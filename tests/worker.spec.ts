import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { ToolResult } from "@paperclipai/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { TOOL_DECLARATIONS } from "../src/tools.js";
import { NAMESPACED_TOOL_NAMES, TOOL_NAMES } from "../src/constants.js";

const TOKEN_REF = { type: "secret_ref" as const, secretId: "secret-1" };
const CONFIG = { baseUrl: "http://home-assistant.test:8123", token: TOKEN_REF };

async function harnessWith(config: Record<string, unknown>) {
  const harness = createTestHarness({ manifest, config });
  await plugin.definition.setup(harness.ctx);
  return harness;
}

function stubFetch(body: unknown, status = 200) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("manifest and registration", () => {
  it("declares and registers the same tools", async () => {
    const harness = await harnessWith(CONFIG);
    const declared = manifest.tools?.map((tool) => tool.name).sort() ?? [];
    expect(declared).toEqual(TOOL_DECLARATIONS.map((tool) => tool.name).sort());

    // A declared tool with no handler would publish an action to agents that
    // always fails, so prove each one is actually wired.
    for (const tool of TOOL_DECLARATIONS) {
      stubFetch([]);
      await expect(
        harness.executeTool(tool.name, defaultParamsFor(tool.name)),
      ).resolves.toBeDefined();
    }
  });

  it("asks for no capability beyond what it uses", () => {
    expect([...manifest.capabilities].sort()).toEqual([
      "agent.tools.register",
      "http.outbound",
      "secrets.read-ref",
    ]);
  });

  it("declares no UI entrypoint, so the host renders the settings form", () => {
    expect(manifest.entrypoints.ui).toBeUndefined();
    expect(manifest.instanceConfigSchema).toBeDefined();
  });

  it("marks the token field as a secret reference rather than text", () => {
    const properties = (
      manifest.instanceConfigSchema as {
        properties: Record<string, { format?: string }>;
      }
    ).properties;
    expect(properties.token!.format).toBe("secret-ref");
  });
});

/**
 * The host classifies a plugin tool's risk by regex-matching its name and
 * cannot be told otherwise: the manifest tool schema has no risk field, and
 * `tool-gateway.ts` overwrites whatever the dispatcher reports with
 * `inferToolRisk(tool.name)`. This is that classifier, copied, so that adding a
 * tool whose name reads as a mutation fails here instead of silently shipping
 * an action that is auto-allowed or — if gated — cannot execute after approval.
 */
function inferToolRisk(toolName: string): "read" | "write" | "destructive" {
  const lower = toolName.toLowerCase();
  if (
    /\b(delete|destroy|remove|drop|truncate|wipe|purge)\b|(^|[:._-])(delete|destroy|remove|drop|truncate|wipe|purge)([:._-]|$)/.test(
      lower,
    )
  ) {
    return "destructive";
  }
  if (
    /\b(create|update|write|edit|patch|post|send|publish|merge|commit|apply)\b|(^|[:._-])(create|update|write|edit|patch|post|send|publish|merge|commit|apply)([:._-]|$)/.test(
      lower,
    )
  ) {
    return "write";
  }
  return "read";
}

describe("host risk classification", () => {
  it("classifies every tool as read, under its namespaced name", () => {
    for (const tool of TOOL_DECLARATIONS) {
      const namespacedName = `${manifest.id}:${tool.name}`;
      expect(inferToolRisk(namespacedName), namespacedName).toBe("read");
    }
  });
});

function defaultParamsFor(name: string): Record<string, unknown> {
  if (name === TOOL_NAMES.getState || name === TOOL_NAMES.getHistory) {
    return { entityId: "light.kitchen" };
  }
  if (name === TOOL_NAMES.renderTemplate) return { template: "{{ 1 }}" };
  return {};
}

describe("tool execution", () => {
  it("sends the resolved secret as the bearer token", async () => {
    const harness = await harnessWith(CONFIG);
    const calls = stubFetch({ version: "2026.10.1" });
    await harness.executeTool(TOOL_NAMES.getConfig, {});
    const headers = calls[0]!.init.headers as Record<string, string>;
    // The harness resolver echoes the ref, which proves the token came from
    // secret resolution rather than from config text.
    expect(headers.Authorization).toMatch(/^Bearer resolved:/);
    expect(calls[0]!.url).toBe("http://home-assistant.test:8123/api/config");
  });

  it("returns both agent-readable content and structured data", async () => {
    const harness = await harnessWith(CONFIG);
    stubFetch({ version: "2026.10.1" });
    const result = await harness.executeTool<{ content: string; data: unknown }>(
      TOOL_NAMES.getConfig,
      {},
    );
    expect(JSON.parse(result.content)).toEqual({ version: "2026.10.1" });
    expect(result.data).toEqual({ version: "2026.10.1" });
  });

  it("tells the operator where to fix a missing address", async () => {
    const harness = await harnessWith({ token: TOKEN_REF });
    const result = await harness.executeTool<{ error: string }>(TOOL_NAMES.getConfig, {});
    expect(result.error).toMatch(/no Home Assistant address configured/);
  });

  it("tells the operator where to fix a missing token", async () => {
    const harness = await harnessWith({ baseUrl: "http://home-assistant.test:8123" });
    const result = await harness.executeTool<{ error: string }>(TOOL_NAMES.getConfig, {});
    expect(result.error).toMatch(/no Home Assistant token configured/);
  });

  it("rejects a token stored as plain text instead of a secret reference", async () => {
    const harness = await harnessWith({
      baseUrl: "http://home-assistant.test:8123",
      token: "a-raw-token",
    });
    const result = await harness.executeTool<{ error: string }>(TOOL_NAMES.getConfig, {});
    expect(result.error).toMatch(/no Home Assistant token configured/);
  });

  it("returns a bad argument as a fixable error, not a crash", async () => {
    const harness = await harnessWith(CONFIG);
    stubFetch({});
    const result = await harness.executeTool<{ error: string }>(TOOL_NAMES.getState, {
      entityId: "kitchen",
    });
    expect(result.error).toMatch(/entity ID/);
  });

  it("replaces an unexpected runtime error rather than forwarding its text", async () => {
    const harness = await harnessWith(CONFIG);
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED http://home-assistant.test:8123/api/config");
    });
    const result = await harness.executeTool<{ error: string }>(TOOL_NAMES.getConfig, {});
    expect(result.error).toMatch(/could not be reached at the configured address/);
    expect(result.error).not.toMatch(/home-assistant\.test/);
  });
});

describe("onValidateConfig", () => {
  it("accepts a valid pair but says it did not contact the instance", async () => {
    const result = await plugin.definition.onValidateConfig!(CONFIG);
    expect(result.ok).toBe(true);
    expect(result.warnings?.join(" ")).toMatch(/does not contact Home Assistant/);
  });

  // Test Connection is the only moment the plugin can tell the person who
  // configured it that configuring it was not enough. An operator who misses
  // this reads `ready` + green health as working and has no way to find out
  // otherwise, so assert the text is there and that it carries every exact
  // name a profile rule has to be given.
  it("tells the operator the tools are still denied until a profile grants them", async () => {
    const result = await plugin.definition.onValidateConfig!(CONFIG);
    const warnings = result.warnings?.join(" ") ?? "";
    expect(warnings).toMatch(/does not grant its tools/);
    expect(warnings).toMatch(/Profiles/);
    expect(warnings).toMatch(/wildcard rule matches nothing/);
    for (const name of NAMESPACED_TOOL_NAMES) {
      expect(warnings).toContain(name);
    }
    expect(NAMESPACED_TOOL_NAMES).toHaveLength(TOOL_DECLARATIONS.length);
  });

  it("rejects an address with no scheme", async () => {
    const result = await plugin.definition.onValidateConfig!({
      ...CONFIG,
      baseUrl: "home-assistant.test:8123",
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.join(" ")).toMatch(/http:\/\/ or https:\/\//);
  });

  it("rejects an address carrying credentials", async () => {
    const result = await plugin.definition.onValidateConfig!({
      ...CONFIG,
      baseUrl: "http://user:pass@home-assistant.test:8123",
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.join(" ")).toMatch(/credentials/);
  });

  it("rejects a token that is not a secret reference", async () => {
    const result = await plugin.definition.onValidateConfig!({
      ...CONFIG,
      token: "a-raw-token",
    });
    expect(result.ok).toBe(false);
    expect(result.errors?.join(" ")).toMatch(/secret/);
  });

  it("reports both problems at once", async () => {
    const result = await plugin.definition.onValidateConfig!({});
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(2);
  });
});

/**
 * The host's forwarding rule, copied from `server/src/routes/tool-gateway.ts`
 * (the `tools/call` branch of `/api/mcp/gateways/:gatewayPublicId`, which is
 * the `paperclip-assigned` MCP server every heartbeat run mounts):
 *
 * ```ts
 * const contentText = typeof resultRecord?.content === "string"
 *   ? resultRecord.content
 *   : JSON.stringify(resultRecord?.data ?? result.result ?? null);
 * res.json({ result: {
 *   content: [{ type: "text", text: contentText }],
 *   structuredContent: resultRecord?.data ?? null,
 *   isError: false,
 * } });
 * ```
 *
 * Note `?? null`: an absent `data` is forwarded as an explicit `null`, and the
 * client's schema requires a record there. So a `ToolResult` carrying only
 * `error` is discarded in full — `error` is not one of the two fields that
 * travel. This copy exists so that regression fails here rather than silently
 * shipping a tool whose every failure reads as a transport error.
 */
function forwardAsMcpResult(result: ToolResult) {
  const contentText =
    typeof result.content === "string"
      ? result.content
      : JSON.stringify(result.data ?? result ?? null);
  return {
    content: [{ type: "text", text: contentText }],
    structuredContent: result.data ?? null,
  };
}

/** The client-side schema check that rejected every call from this plugin. */
function clientAcceptsStructuredContent(value: unknown): boolean {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

describe("results survive the host's MCP forwarding", () => {
  it("a success carries structured data the client will accept", async () => {
    const harness = await harnessWith(CONFIG);
    stubFetch({ version: "2026.10.1" });
    const result = await harness.executeTool(TOOL_NAMES.getConfig, {});
    const forwarded = forwardAsMcpResult(result);
    expect(clientAcceptsStructuredContent(forwarded.structuredContent)).toBe(true);
  });

  it("every tool's success is an object once Home Assistant answers", async () => {
    const harness = await harnessWith(CONFIG);
    for (const tool of TOOL_DECLARATIONS) {
      // An array body exercises the three endpoints that return one; the rest
      // ignore it or wrap it.
      stubFetch([]);
      const result = await harness.executeTool(tool.name, defaultParamsFor(tool.name));
      const forwarded = forwardAsMcpResult(result);
      expect(
        clientAcceptsStructuredContent(forwarded.structuredContent),
        `${tool.name} produced structuredContent the client rejects`,
      ).toBe(true);
    }
  });

  /**
   * Each row is one of the distinct causes this plugin writes a specific
   * message for. Before the fix all four reached the agent as the same schema
   * error, which is why the live cause of a failing install could not be read
   * from the agent side at all.
   */
  const failures: Array<[string, () => void | Promise<void>, RegExp]> = [
    [
      "an unreachable instance",
      () => {
        vi.stubGlobal("fetch", async () => {
          throw new Error("connect ECONNREFUSED");
        });
      },
      /could not be reached at the configured address/,
    ],
    [
      "a rejected token",
      () => {
        stubFetch({ message: "401: Unauthorized" }, 401);
      },
      /rejected the long-lived access token/,
    ],
    [
      "an unknown entity or endpoint",
      () => {
        stubFetch({}, 404);
      },
      /no such entity or endpoint/,
    ],
    [
      "an unexpected status",
      () => {
        stubFetch({}, 500);
      },
      /request failed \(500\)/,
    ],
  ];

  it.each(failures)("%s reaches the agent", async (_label, arrange, expected) => {
    await arrange();
    const harness = await harnessWith(CONFIG);
    const result = await harness.executeTool(TOOL_NAMES.getConfig, {});

    expect(result.error).toMatch(expected);
    // The two fields that actually travel.
    expect(result.content).toMatch(expected);
    expect(clientAcceptsStructuredContent(result.data)).toBe(true);

    const forwarded = forwardAsMcpResult(result);
    expect(clientAcceptsStructuredContent(forwarded.structuredContent)).toBe(true);
    expect(forwarded.content[0]!.text).toMatch(expected);
  });

  it("an unconfigured install says so instead of failing as a schema error", async () => {
    const harness = await harnessWith({});
    const result = await harness.executeTool(TOOL_NAMES.getConfig, {});
    expect(result.content).toMatch(/no Home Assistant address configured/);
    expect(clientAcceptsStructuredContent(forwardAsMcpResult(result).structuredContent)).toBe(
      true,
    );
  });

  it("a bad argument comes back as this plugin's own message", async () => {
    const harness = await harnessWith(CONFIG);
    stubFetch({});
    const result = await harness.executeTool(TOOL_NAMES.getState, {
      entityId: "not-an-entity-id",
    });
    expect(result.content).toMatch(/entity ID/);
    expect(clientAcceptsStructuredContent(forwardAsMcpResult(result).structuredContent)).toBe(
      true,
    );
  });
});

describe("failures are visible to the operator too", () => {
  it("logs a warning naming the tool and the reason", async () => {
    const harness = await harnessWith(CONFIG);
    stubFetch({}, 401);
    await harness.executeTool(TOOL_NAMES.getConfig, {});

    const warning = harness.logs.find((entry) => entry.level === "warn");
    expect(warning, "no warning reached the plugin log").toBeDefined();
    expect(warning!.meta?.tool).toBe(TOOL_NAMES.getConfig);
    expect(String(warning!.meta?.reason)).toMatch(/rejected the long-lived access token/);
  });

  it("logs an unexpected error without putting its text in the log's reason", async () => {
    const harness = await harnessWith(CONFIG);
    // A body that fails mid-stream throws past the request wrapper, so this is
    // the branch whose message the agent must not see.
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError("secret-bearing internal detail"));
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const result = await harness.executeTool(TOOL_NAMES.getConfig, {});
    expect(result.error).toBe("The Home Assistant request failed.");

    const warning = harness.logs.find((entry) => entry.level === "warn");
    expect(warning).toBeDefined();
    expect(String(warning!.meta?.reason)).toBe("unexpected TypeError");
    expect(JSON.stringify(warning)).not.toMatch(/secret-bearing/);
  });
});
