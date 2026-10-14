import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { TOOL_DECLARATIONS } from "../src/tools.js";
import { TOOL_NAMES } from "../src/constants.js";

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
