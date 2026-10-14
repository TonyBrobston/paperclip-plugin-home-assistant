import {
  definePlugin,
  runWorker,
  type EnvSecretRefBinding,
  type PluginConfigValidationResult,
  type PluginContext,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import { CONFIG_KEYS } from "./constants.js";
import {
  executeTool,
  homeAssistantApiUrl,
  HomeAssistantError,
  InvalidParameterError,
  type ClientOptions,
} from "./home-assistant.js";
import { TOOL_DECLARATIONS } from "./tools.js";

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
 * Turn a thrown error into a tool result.
 *
 * Returning `{ error }` rather than throwing keeps the message useful to the
 * agent — a bad entity ID should read as "fix the argument", not as a plugin
 * crash. Only messages this plugin wrote are passed through; anything else is
 * replaced, because an arbitrary runtime error can carry the instance address
 * or request detail in its text.
 */
function toolError(error: unknown): ToolResult {
  if (error instanceof InvalidParameterError || error instanceof HomeAssistantError) {
    return { error: error.message };
  }
  return { error: "The Home Assistant request failed." };
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
            const data = await executeTool(options, declaration.name, params);
            return {
              // The agent reads `content`; `data` keeps the structured form
              // for anything that consumes the result programmatically.
              content: JSON.stringify(data, null, 2),
              data: data as Record<string, unknown>,
            };
          } catch (error) {
            return toolError(error);
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
      ],
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
