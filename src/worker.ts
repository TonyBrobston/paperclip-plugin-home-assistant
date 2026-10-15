import {
  definePlugin,
  runWorker,
  type EnvSecretRefBinding,
  type PluginConfigValidationResult,
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { CONFIG_KEYS, NAMESPACED_TOOL_NAMES } from "./constants.js";
import {
  executeTool,
  homeAssistantApiUrl,
  HomeAssistantError,
  InvalidParameterError,
  type ClientOptions,
} from "./home-assistant.js";
import { TOOL_DECLARATIONS } from "./tools.js";

/**
 * Said on every successful validation, because nothing else says it.
 *
 * Configuring the plugin and enabling it is not enough to make a single tool
 * callable. Paperclip denies a tool call that no tool profile, grant or allow
 * policy permits, and plugin activation does not create any of the three — so
 * the tools are registered, healthy, and denied to every agent until an
 * operator writes a profile by hand. The denial is reported to the agent as a
 * default deny with no mention of plugins, and the settings page shows a green
 * `ready`, so there is no other surface where an operator would find this out.
 *
 * Test Connection is the one place the plugin gets to talk to the person who
 * just configured it, so it is where this belongs.
 */
const TOOL_GRANT_WARNING = [
  "Enabling this plugin does not grant its tools to any agent — Paperclip denies a plugin tool until a tool profile allows it, and activation never creates one.",
  "In Connectors → Profiles (/apps/advanced/profiles), create a profile with one Allow rule per tool, kind \"tool name\", and assign it to the agents that need these tools:",
  NAMESPACED_TOOL_NAMES.join(", ") + ".",
  'The field is labelled "pattern", but the server compares names literally, so a wildcard rule matches nothing.',
  "You only write the rules once: the same profile can be bound to further agents, or to the whole company, without retyping them.",
  'See the plugin README, "Granting the tools to an agent".',
].join(" ");

function isSecretRefBinding(value: unknown): value is EnvSecretRefBinding {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === "secret_ref" &&
    typeof (value as { secretId?: unknown }).secretId === "string"
  );
}

/**
 * Read the per-company config and resolve the token.
 *
 * The token is resolved on every call rather than cached. A worker is spawned
 * once per plugin and serves every company, so a cached credential would be
 * the wrong credential as soon as a second company configured the plugin — and
 * rotating the secret in Paperclip would not take effect until a restart.
 */
async function resolveClientOptions(
  ctx: PluginContext,
  companyId: string,
): Promise<ClientOptions> {
  const config = await ctx.config.get(companyId);

  const baseUrl = config[CONFIG_KEYS.baseUrl];
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
    throw new HomeAssistantError(
      "This plugin has no Home Assistant address configured. Set it in Settings → Plugins → Home Assistant.",
    );
  }

  const tokenRef = config[CONFIG_KEYS.token];
  if (!isSecretRefBinding(tokenRef)) {
    throw new HomeAssistantError(
      "This plugin has no Home Assistant token configured. Add a long-lived access token in Settings → Plugins → Home Assistant.",
    );
  }

  const token = await ctx.secrets.resolve(tokenRef, {
    companyId,
    configPath: CONFIG_KEYS.token,
  });
  if (!token) {
    throw new HomeAssistantError(
      "The configured Home Assistant token secret resolved to an empty value.",
    );
  }

  return { baseUrl, token };
}

/**
 * Guarantee the structured half of a tool result is a JSON object.
 *
 * The host forwards `ToolResult.data` as MCP `structuredContent`, and the
 * client's schema requires an object there: an array, a scalar, or an absent
 * `data` (which the host forwards as an explicit `null`) makes the client
 * discard the whole result — `content` included — before the agent reads any of
 * it. Every tool already returns an object, and the array-returning endpoints
 * are wrapped in `home-assistant.ts`; this is the unconditional backstop at the
 * one place the host reads, so a future tool cannot reintroduce the fault.
 */
function structured(data: unknown): Record<string, unknown> {
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    return data as Record<string, unknown>;
  }
  return { value: data };
}

/**
 * Turn a thrown error into a tool result.
 *
 * Returning `{ error }` rather than throwing keeps the message useful to the
 * agent — a bad entity ID should read as "fix the argument", not as a plugin
 * crash. Only messages this plugin wrote are passed through; anything else is
 * replaced, because an arbitrary runtime error can carry the instance address
 * or request detail in its text.
 *
 * `content` and `data` are set alongside `error` deliberately. `error` on its
 * own travels in neither of the two fields the host forwards, so the agent's
 * client rejected the result as malformed and the message — the whole point of
 * writing specific ones — never arrived. The same call is logged, so a failure
 * is visible on the plugin health page even when the agent's transport drops it.
 */
function toolError(
  ctx: PluginContext,
  toolName: string,
  companyId: string,
  error: unknown,
): ToolResult {
  const expected =
    error instanceof InvalidParameterError || error instanceof HomeAssistantError;
  const message = expected
    ? error.message
    : "The Home Assistant request failed.";
  ctx.logger.warn("Home Assistant tool call failed", {
    tool: toolName,
    companyId,
    // An unexpected error's own text is withheld from the agent; the log is
    // operator-facing, so record its class to make one diagnosable.
    reason: expected ? message : `unexpected ${(error as Error)?.name ?? "error"}`,
  });
  return { error: message, content: message, data: { error: message } };
}

const plugin = definePlugin({
  async setup(ctx: PluginContext): Promise<void> {
    for (const declaration of TOOL_DECLARATIONS) {
      ctx.tools.register(
        declaration.name,
        {
          displayName: declaration.displayName,
          description: declaration.description,
          parametersSchema: declaration.parametersSchema,
        },
        async (params: unknown, runCtx: ToolRunContext): Promise<ToolResult> => {
          try {
            const options = await resolveClientOptions(ctx, runCtx.companyId);
            const data = structured(
              await executeTool(options, declaration.name, params),
            );
            return {
              // The agent reads `content`; `data` keeps the structured form
              // for anything that consumes the result programmatically.
              content: JSON.stringify(data, null, 2),
              data,
            };
          } catch (error) {
            return toolError(ctx, declaration.name, runCtx.companyId, error);
          }
        },
      );
    }
  },

  /**
   * Shape-only validation, and the "only" is deliberate.
   *
   * The host calls this on start, on save, and behind the settings page's Test
   * Connection button — but it passes the config without a company ID, and
   * resolving the token ref requires one. So this cannot make a live request.
   * It checks what it can and says plainly what it did not check, rather than
   * reporting a green "connected" that was never tested.
   */
  async onValidateConfig(
    config: Record<string, unknown>,
  ): Promise<PluginConfigValidationResult> {
    const errors: string[] = [];

    const baseUrl = config[CONFIG_KEYS.baseUrl];
    if (typeof baseUrl !== "string" || baseUrl.trim() === "") {
      errors.push("Enter the address you open Home Assistant at.");
    } else {
      try {
        homeAssistantApiUrl(baseUrl, "/api/");
      } catch (error) {
        errors.push(
          error instanceof HomeAssistantError
            ? error.message
            : "The Home Assistant address could not be parsed.",
        );
      }
    }

    if (!isSecretRefBinding(config[CONFIG_KEYS.token])) {
      errors.push(
        "Select a secret holding a Home Assistant long-lived access token.",
      );
    }

    if (errors.length > 0) return { ok: false, errors };
    return {
      ok: true,
      warnings: [
        "Address and token reference look valid. This check does not contact Home Assistant — ask an agent to run get_config to confirm the instance is reachable and the token is accepted.",
        TOOL_GRANT_WARNING,
      ],
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
