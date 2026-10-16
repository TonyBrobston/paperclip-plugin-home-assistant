import { describe, expect, it } from "vitest";
import {
  executeTool,
  homeAssistantApiUrl,
  HomeAssistantError,
  type FetchLike,
} from "../src/home-assistant.js";
import {
  ENTITY_PAGE_MAX,
  EVENT_PAGE_MAX,
  LOG_TAIL_MAX_BYTES,
  TOOL_NAMES,
} from "../src/constants.js";
import { InvalidParameterError } from "../src/validate.js";
import { REDACTION_MARKER } from "../src/redact.js";

const BASE_URL = "http://home-assistant.test:8123";
const TOKEN = "test-token";

type Call = { url: string; init: RequestInit };

/** Records every request and replies with the queued body. */
function recorder(
  bodies: Array<unknown | string>,
  init?: { status?: number; contentType?: string },
) {
  const calls: Call[] = [];
  const fetchImpl: FetchLike = async (url, requestInit) => {
    calls.push({ url, init: requestInit });
    const next = bodies.length > 1 ? bodies.shift() : bodies[0];
    const body = typeof next === "string" ? next : JSON.stringify(next);
    return new Response(body, {
      status: init?.status ?? 200,
      headers: { "content-type": init?.contentType ?? "application/json" },
    });
  };
  return { calls, options: { baseUrl: BASE_URL, token: TOKEN, fetchImpl } };
}

const state = (entityId: string, value = "on", friendlyName?: string) => ({
  entity_id: entityId,
  state: value,
  attributes: {
    ...(friendlyName ? { friendly_name: friendlyName } : {}),
    device_class: "light",
    unit_of_measurement: null,
  },
  last_changed: "2026-10-14T00:00:00Z",
});

describe("homeAssistantApiUrl", () => {
  it("joins the base URL and path, tolerating a trailing slash", () => {
    expect(homeAssistantApiUrl("http://ha.test:8123/", "/api/states").toString()).toBe(
      "http://ha.test:8123/api/states",
    );
  });

  it.each([
    ["a missing scheme", "ha.test:8123"],
    ["a non-HTTP scheme", "ftp://ha.test"],
    ["embedded credentials", "http://user:pass@ha.test:8123"],
    ["a query string", "http://ha.test:8123?x=1"],
    ["a fragment", "http://ha.test:8123#x"],
  ])("rejects %s", (_label, baseUrl) => {
    expect(() => homeAssistantApiUrl(baseUrl, "/api/")).toThrow();
  });
});

describe("authentication and transport", () => {
  it("sends the token as a bearer header and refuses redirects", async () => {
    const { calls, options } = recorder([[]]);
    await executeTool(options, TOOL_NAMES.listEntities, {});
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    // A redirect off the configured host would carry the token with it.
    expect(calls[0]!.init.redirect).toBe("error");
  });

  it("reports a rejected token without echoing the address", async () => {
    const { options } = recorder([{}], { status: 401 });
    await expect(executeTool(options, TOOL_NAMES.getConfig, {})).rejects.toThrow(
      /rejected the long-lived access token/,
    );
    await expect(
      executeTool(options, TOOL_NAMES.getConfig, {}),
    ).rejects.not.toThrow(/home-assistant\.test/);
  });

  it("does not leak the attempted URL when the request throws", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error(`connect ECONNREFUSED ${BASE_URL}/api/states`);
    };
    await expect(
      executeTool({ baseUrl: BASE_URL, token: TOKEN, fetchImpl }, TOOL_NAMES.getConfig, {}),
    ).rejects.toThrow(/could not be reached at the configured address/);
  });

  it("surfaces a missing entity as a 404-specific message", async () => {
    const { options } = recorder([{}], { status: 404 });
    await expect(
      executeTool(options, TOOL_NAMES.getState, { entityId: "light.nope" }),
    ).rejects.toThrow(/no such entity or endpoint/);
  });

  it("fails cleanly when the body is not JSON", async () => {
    const { options } = recorder(["<html>not json</html>"]);
    await expect(executeTool(options, TOOL_NAMES.getConfig, {})).rejects.toThrow(
      /could not parse as JSON/,
    );
  });
});

describe("list_entities", () => {
  it("summarises rather than returning full attribute dumps", async () => {
    const { options } = recorder([[state("light.kitchen", "on", "Kitchen")]]);
    const result = (await executeTool(options, TOOL_NAMES.listEntities, {})) as {
      entities: Array<Record<string, unknown>>;
    };
    expect(result.entities[0]).toEqual({
      entityId: "light.kitchen",
      state: "on",
      friendlyName: "Kitchen",
      deviceClass: "light",
      unitOfMeasurement: null,
      lastChanged: "2026-10-14T00:00:00Z",
    });
  });

  it("filters by domain", async () => {
    const { options } = recorder([
      [state("light.kitchen"), state("sensor.outdoor"), state("light.hall")],
    ]);
    const result = (await executeTool(options, TOOL_NAMES.listEntities, {
      domain: "light",
    })) as { totalMatched: number };
    expect(result.totalMatched).toBe(2);
  });

  it("matches a search term against entity ID and friendly name", async () => {
    const { options } = recorder([
      [state("light.a", "on", "Kitchen ceiling"), state("light.kitchen_lamp"), state("light.hall")],
    ]);
    const result = (await executeTool(options, TOOL_NAMES.listEntities, {
      search: "KITCHEN",
    })) as { totalMatched: number };
    expect(result.totalMatched).toBe(2);
  });

  it("reports truncation instead of silently dropping rows", async () => {
    const { options } = recorder([[state("light.a"), state("light.b"), state("light.c")]]);
    const result = (await executeTool(options, TOOL_NAMES.listEntities, {
      limit: 2,
    })) as { returned: number; truncated: boolean; totalMatched: number };
    expect(result).toMatchObject({ totalMatched: 3, returned: 2, truncated: true });
  });

  it("rejects a limit above the page ceiling", async () => {
    const { options } = recorder([[]]);
    await expect(
      executeTool(options, TOOL_NAMES.listEntities, { limit: ENTITY_PAGE_MAX + 1 }),
    ).rejects.toThrow(InvalidParameterError);
  });

  it("fails when the instance returns a non-array state list", async () => {
    const { options } = recorder([{ unexpected: true }]);
    await expect(executeTool(options, TOOL_NAMES.listEntities, {})).rejects.toThrow(
      HomeAssistantError,
    );
  });
});

describe("parameter validation", () => {
  it("rejects an unknown parameter rather than ignoring it", async () => {
    const { options } = recorder([[]]);
    // Silently dropping it would report a filtered answer that was never filtered.
    await expect(
      executeTool(options, TOOL_NAMES.listEntities, { domian: "light" }),
    ).rejects.toThrow(/Unsupported parameter: domian/);
  });

  it("requires a well-formed entity ID", async () => {
    const { options } = recorder([{}]);
    await expect(
      executeTool(options, TOOL_NAMES.getState, { entityId: "kitchen" }),
    ).rejects.toThrow(/entity ID/);
  });

  it("rejects an unparseable timestamp before building a URL from it", async () => {
    const { options } = recorder([[]]);
    await expect(
      executeTool(options, TOOL_NAMES.getHistory, {
        entityId: "light.kitchen",
        startTime: "last tuesday",
      }),
    ).rejects.toThrow(/ISO 8601/);
  });

  it("percent-encodes an entity ID into the path", async () => {
    const { calls, options } = recorder([{}]);
    await executeTool(options, TOOL_NAMES.getState, { entityId: "light.kitchen" });
    expect(calls[0]!.url).toBe(`${BASE_URL}/api/states/light.kitchen`);
  });
});

describe("read endpoints", () => {
  it("get_state returns the full object untouched", async () => {
    const full = state("light.kitchen", "on", "Kitchen");
    const { options } = recorder([full]);
    expect(await executeTool(options, TOOL_NAMES.getState, { entityId: "light.kitchen" })).toEqual(
      full,
    );
  });

  it("list_services filters by domain", async () => {
    const { options } = recorder([
      [
        { domain: "light", services: { turn_on: {} } },
        { domain: "climate", services: { set_temperature: {} } },
      ],
    ]);
    const result = (await executeTool(options, TOOL_NAMES.listServices, {
      domain: "light",
    })) as { domain: string; returned: number; domains: Array<{ domain: string }> };
    expect(result.domain).toBe("light");
    expect(result.returned).toBe(1);
    expect(result.domains).toHaveLength(1);
    expect(result.domains[0]!.domain).toBe("light");
  });

  it("render_template posts the template and returns plaintext output", async () => {
    const { calls, options } = recorder(["21.5"], { contentType: "text/plain" });
    const result = await executeTool(options, TOOL_NAMES.renderTemplate, {
      template: "{{ states('sensor.x') }}",
    });
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      template: "{{ states('sensor.x') }}",
    });
    expect(result).toEqual({ rendered: "21.5" });
  });

  it("check_config posts to the documented check endpoint", async () => {
    const { calls, options } = recorder([{ result: "valid", errors: null }]);
    await executeTool(options, TOOL_NAMES.checkConfig, {});
    expect(calls[0]!.url).toBe(`${BASE_URL}/api/config/core/check_config`);
    expect(calls[0]!.init.method).toBe("POST");
  });

  it("get_history defaults to a 24-hour window and a minimal response", async () => {
    const { calls, options } = recorder([[]]);
    await executeTool(options, TOOL_NAMES.getHistory, { entityId: "light.kitchen" });
    const url = new URL(calls[0]!.url);
    expect(url.pathname.startsWith("/api/history/period/")).toBe(true);
    expect(url.searchParams.get("filter_entity_id")).toBe("light.kitchen");
    expect(url.searchParams.has("minimal_response")).toBe(true);
    const start = Date.parse(decodeURIComponent(url.pathname.split("/api/history/period/")[1]!));
    expect(Date.now() - start).toBeGreaterThan(23 * 60 * 60 * 1000);
    expect(Date.now() - start).toBeLessThan(25 * 60 * 60 * 1000);
  });

  it("get_history honours an explicit window and opts out of minimal", async () => {
    const { calls, options } = recorder([[]]);
    await executeTool(options, TOOL_NAMES.getHistory, {
      entityId: "light.kitchen",
      startTime: "2026-10-01T00:00:00Z",
      endTime: "2026-10-02T00:00:00Z",
      minimalResponse: false,
    });
    const url = new URL(calls[0]!.url);
    expect(decodeURIComponent(url.pathname)).toContain("2026-10-01T00:00:00Z");
    expect(url.searchParams.get("end_time")).toBe("2026-10-02T00:00:00Z");
    expect(url.searchParams.has("minimal_response")).toBe(false);
  });

  it("get_logbook omits the entity filter when none is given", async () => {
    const { calls, options } = recorder([[]]);
    await executeTool(options, TOOL_NAMES.getLogbook, {});
    expect(new URL(calls[0]!.url).searchParams.has("entity")).toBe(false);
  });

  it("get_error_log returns the tail and flags truncation", async () => {
    const log = `${"a".repeat(2000)}TAIL`;
    const { options } = recorder([log], { contentType: "text/plain" });
    const result = (await executeTool(options, TOOL_NAMES.getErrorLog, {
      maxBytes: 1024,
    })) as { truncated: boolean; log: string };
    expect(result.truncated).toBe(true);
    expect(result.log.endsWith("TAIL")).toBe(true);
    expect(Buffer.byteLength(result.log, "utf8")).toBe(1024);
  });

  it("get_error_log does not flag truncation for a short log", async () => {
    const { options } = recorder(["short"], { contentType: "text/plain" });
    const result = (await executeTool(options, TOOL_NAMES.getErrorLog, {})) as {
      truncated: boolean;
      log: string;
    };
    expect(result).toEqual({ truncated: false, redacted: false, log: "short" });
  });

  it("rejects a maxBytes above the documented tail ceiling", async () => {
    const { options } = recorder(["x"]);
    await expect(
      executeTool(options, TOOL_NAMES.getErrorLog, { maxBytes: LOG_TAIL_MAX_BYTES + 1 }),
    ).rejects.toThrow(InvalidParameterError);
  });
});

/**
 * The two tools that return provider-composed text are the two that can hand
 * an agent the operator's credentials, and the plugin SDK has no risk level or
 * ask-first field on a registered tool, so there is no approval gate to fall
 * back on. `redact.spec.ts` covers the patterns; these cover the wiring — that
 * each tool actually runs the scrub, on the right text, in the right order.
 */
describe("credential scrubbing", () => {
  const JWT =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJhYmMxMjMifQ.s1gnatureV4lue_abc123";

  it("get_error_log removes the plugin's own configured token", async () => {
    const { options } = recorder(
      [`ERROR Request failed: Authorization: Bearer ${TOKEN}\n`],
      { contentType: "text/plain" },
    );
    const result = (await executeTool(options, TOOL_NAMES.getErrorLog, {})) as {
      redacted: boolean;
      log: string;
    };
    expect(result.log).not.toContain(TOKEN);
    expect(result.redacted).toBe(true);
  });

  it("get_error_log removes a credential in a logged request URL", async () => {
    const { options } = recorder(
      ["ERROR [homeassistant.components.rest] https://api.test/v1?api_key=A1b2C3d4E5f6G7h8 failed\n"],
      { contentType: "text/plain" },
    );
    const result = (await executeTool(options, TOOL_NAMES.getErrorLog, {})) as {
      redacted: boolean;
      log: string;
    };
    expect(result.log).not.toContain("A1b2C3d4E5f6G7h8");
    expect(result.log).toContain("api_key=");
    expect(result.redacted).toBe(true);
  });

  it("scrubs before cutting the tail, so truncation cannot split a token", async () => {
    // The token straddles the cut: scrubbing the tail instead of the log would
    // leave the pattern half a credential to match, and hand over the rest.
    const log = `${"filler line\n".repeat(200)}Authorization: Bearer ${JWT}\n`;
    const maxBytes = 1024;
    const { options } = recorder([log], { contentType: "text/plain" });
    const result = (await executeTool(options, TOOL_NAMES.getErrorLog, {
      maxBytes,
    })) as { truncated: boolean; redacted: boolean; log: string };
    expect(result.truncated).toBe(true);
    expect(result.log).not.toContain(JWT.slice(0, 24));
    expect(result.log).toContain(REDACTION_MARKER);
    expect(result.redacted).toBe(true);
  });

  it("check_config removes an expanded !secret from a validation error", async () => {
    // Home Assistant substitutes `!secret` before it validates, so the value
    // quoted back here is the secret, not the reference the operator wrote.
    const { options } = recorder([
      {
        result: "invalid",
        errors:
          "Invalid config for [notify.smtp]: not a valid value for dictionary value @ data['password']. Got 'hunter2-correct-horse'",
      },
    ]);
    const result = (await executeTool(options, TOOL_NAMES.checkConfig, {})) as {
      result: string;
      errors: string;
    };
    expect(result.errors).not.toContain("hunter2-correct-horse");
    expect(result.errors).toContain(REDACTION_MARKER);
    // The shape Home Assistant returned is preserved, scrubbed in place.
    expect(result.result).toBe("invalid");
  });

  it("check_config scrubs wherever the errors live in the response", async () => {
    const { options } = recorder([
      {
        result: "invalid",
        errors: { "notify.smtp": [`token: ${TOKEN}`], detail: { password: "ok" } },
      },
    ]);
    const result = (await executeTool(options, TOOL_NAMES.checkConfig, {})) as {
      errors: { "notify.smtp": string[]; detail: { password: string } };
    };
    expect(result.errors["notify.smtp"][0]).not.toContain(TOKEN);
    expect(result.errors.detail.password).toBe(REDACTION_MARKER);
  });

  it("leaves a clean log and a valid config untouched", async () => {
    const clean =
      "2026-10-16 01:02:03 WARNING (MainThread) [homeassistant.components.sensor] Updating sensor.outdoor_temperature took too long\n";
    const { options } = recorder([clean], { contentType: "text/plain" });
    const log = (await executeTool(options, TOOL_NAMES.getErrorLog, {})) as {
      redacted: boolean;
      log: string;
    };
    expect(log.log).toBe(clean);
    expect(log.redacted).toBe(false);

    const valid = recorder([{ result: "valid", errors: null }]);
    expect(await executeTool(valid.options, TOOL_NAMES.checkConfig, {})).toEqual({
      result: "valid",
      errors: null,
    });
  });
});

describe("reachable surface", () => {
  it("refuses a tool name outside the catalog", async () => {
    const { options } = recorder([{}]);
    await expect(executeTool(options, "call_service", { domain: "lock" })).rejects.toThrow(
      /Unknown Home Assistant tool/,
    );
  });

  it("only ever issues GET, except for the two documented read POSTs", async () => {
    const reads = [
      [TOOL_NAMES.listEntities, {}],
      [TOOL_NAMES.getState, { entityId: "light.kitchen" }],
      [TOOL_NAMES.listServices, {}],
      [TOOL_NAMES.getConfig, {}],
      [TOOL_NAMES.getHistory, { entityId: "light.kitchen" }],
      [TOOL_NAMES.getLogbook, {}],
      [TOOL_NAMES.getErrorLog, {}],
    ] as const;
    for (const [tool, params] of reads) {
      const { calls, options } = recorder([[]]);
      await executeTool(options, tool, params);
      expect(calls[0]!.init.method, `${tool} must be a GET`).toBe("GET");
    }
  });
});

/**
 * The host forwards a tool's structured result as MCP `structuredContent`, and
 * the agent's client validates that field as a JSON object. A top-level array
 * — which is what `/api/history/period`, `/api/logbook` and `/api/services`
 * hand back — fails that schema, and the client discards the entire result
 * before the agent reads any of it. So the shape of every tool's result is a
 * compatibility contract with the transport, not a formatting preference.
 */
describe("structured results are valid MCP structuredContent", () => {
  const haState = state("light.kitchen", "on", "Kitchen");

  /** What Home Assistant actually returns on each documented endpoint. */
  const responses: Array<[string, Record<string, unknown>, unknown, string?]> = [
    [TOOL_NAMES.listEntities, {}, [haState]],
    [TOOL_NAMES.getState, { entityId: "light.kitchen" }, haState],
    [
      TOOL_NAMES.listServices,
      {},
      [{ domain: "light", services: { turn_on: { fields: {} } } }],
    ],
    [TOOL_NAMES.renderTemplate, { template: "{{ 1 }}" }, "1", "text/plain"],
    [TOOL_NAMES.getConfig, {}, { version: "2026.10.1", location_name: "Home" }],
    [TOOL_NAMES.checkConfig, {}, { result: "valid", errors: null }],
    [
      TOOL_NAMES.getHistory,
      { entityId: "light.kitchen" },
      [[haState, { ...haState, state: "off" }]],
    ],
    [
      TOOL_NAMES.getLogbook,
      {},
      [{ when: "2026-10-14T00:00:00Z", name: "Kitchen", message: "turned on" }],
    ],
    [TOOL_NAMES.getErrorLog, {}, "ERROR boom\n", "text/plain"],
  ];

  it("covers every tool in the catalog", () => {
    expect(responses.map(([name]) => name).sort()).toEqual(
      Object.values(TOOL_NAMES).sort(),
    );
  });

  it.each(responses)(
    "%s returns an object, not an array or a scalar",
    async (tool, params, body, contentType) => {
      const { options } = recorder([body], contentType ? { contentType } : undefined);
      const result = await executeTool(options, tool, params);
      expect(Array.isArray(result), `${tool} returned a top-level array`).toBe(false);
      expect(result === null, `${tool} returned null`).toBe(false);
      expect(typeof result, `${tool} returned a scalar`).toBe("object");
    },
  );
});

describe("window-shaped results carry their request back", () => {
  it("get_history flattens the per-entity series and names the window", async () => {
    const rows = [state("light.kitchen", "on"), state("light.kitchen", "off")];
    const { options } = recorder([[rows]]);
    const result = (await executeTool(options, TOOL_NAMES.getHistory, {
      entityId: "light.kitchen",
      startTime: "2026-10-14T00:00:00.000Z",
      endTime: "2026-10-14T06:00:00.000Z",
    })) as Record<string, unknown>;

    expect(result.entityId).toBe("light.kitchen");
    expect(result.start).toBe("2026-10-14T00:00:00.000Z");
    expect(result.end).toBe("2026-10-14T06:00:00.000Z");
    expect(result.minimalResponse).toBe(true);
    expect(result.returned).toBe(2);
    expect(result.changes).toEqual(rows);
  });

  it("get_history reports an empty window as zero rows rather than failing", async () => {
    const { options } = recorder([[]]);
    const result = (await executeTool(options, TOOL_NAMES.getHistory, {
      entityId: "light.kitchen",
    })) as Record<string, unknown>;
    expect(result.returned).toBe(0);
    expect(result.changes).toEqual([]);
  });

  it("get_history passes an unexpected flat array through instead of dropping it", async () => {
    // Defensive: if Home Assistant ever answers with rows rather than series,
    // the agent should still see the rows.
    const { options } = recorder([[{ state: "on" }]]);
    const result = (await executeTool(options, TOOL_NAMES.getHistory, {
      entityId: "light.kitchen",
    })) as Record<string, unknown>;
    expect(result.changes).toEqual([{ state: "on" }]);
  });

  it("get_logbook names the window and reports no entity filter as null", async () => {
    const entries = [{ when: "2026-10-14T00:00:00Z", message: "turned on" }];
    const { options } = recorder([entries]);
    const result = (await executeTool(options, TOOL_NAMES.getLogbook, {})) as Record<
      string,
      unknown
    >;
    expect(result.entityId).toBeNull();
    expect(result.end).toBeNull();
    expect(result.returned).toBe(1);
    expect(result.entries).toEqual(entries);
  });

  it("refuses a non-array where the endpoint documents one", async () => {
    const { options } = recorder([{ unexpected: true }]);
    await expect(
      executeTool(options, TOOL_NAMES.getLogbook, {}),
    ).rejects.toThrow(/unexpected logbook response/);
  });
});

/**
 * A result the agent cannot read is as lost as one the client discards.
 * An unfiltered `get_logbook` over the default 24-hour window measured 5.6 MB
 * against a real installation — more tokens than any model holds — and the
 * whole-installation service catalog measured 351 KB. Neither was capped;
 * `RESPONSE_LIMIT_BYTES` only guards the worker's own memory, at 8 MB.
 */
describe("results stay small enough for a run to read", () => {
  const logbookEntry = (index: number) => ({
    when: new Date(Date.UTC(2026, 9, 14, 0, 0, index)).toISOString(),
    name: "Garage West Motion",
    message: `event ${index}`,
  });

  it("get_logbook keeps the newest page and says how much it dropped", async () => {
    const entries = Array.from({ length: EVENT_PAGE_MAX + 250 }, (_, i) => logbookEntry(i));
    const { options } = recorder([entries]);
    const result = (await executeTool(options, TOOL_NAMES.getLogbook, {})) as {
      totalMatched: number;
      returned: number;
      truncated: boolean;
      entries: Array<{ message: string }>;
    };
    expect(result.totalMatched).toBe(EVENT_PAGE_MAX + 250);
    expect(result.returned).toBe(EVENT_PAGE_MAX);
    expect(result.truncated).toBe(true);
    // Oldest-first upstream, so the useful end is the tail.
    expect(result.entries[result.entries.length - 1]!.message).toBe(
      `event ${EVENT_PAGE_MAX + 249}`,
    );
    expect(result.entries[0]!.message).toBe(`event ${250}`);
  });

  it("a whole-installation logbook cannot flood the run", async () => {
    const entries = Array.from({ length: 20_000 }, (_, i) => logbookEntry(i));
    const { options } = recorder([entries]);
    const result = await executeTool(options, TOOL_NAMES.getLogbook, {});
    const upstream = JSON.stringify(entries).length;
    const forwarded = JSON.stringify(result).length;
    expect(upstream).toBeGreaterThan(1_000_000);
    expect(forwarded).toBeLessThan(200_000);
  });

  it("get_logbook does not claim truncation for a short window", async () => {
    const { options } = recorder([[logbookEntry(0)]]);
    const result = (await executeTool(options, TOOL_NAMES.getLogbook, {})) as Record<
      string,
      unknown
    >;
    expect(result.totalMatched).toBe(1);
    expect(result.returned).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("get_history honours an explicit limit and keeps the newest changes", async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      ...state("light.kitchen", i % 2 === 0 ? "on" : "off"),
      last_changed: `2026-10-14T00:00:0${i}Z`,
    }));
    const { options } = recorder([[rows]]);
    const result = (await executeTool(options, TOOL_NAMES.getHistory, {
      entityId: "light.kitchen",
      limit: 3,
    })) as {
      totalMatched: number;
      returned: number;
      truncated: boolean;
      changes: Array<{ last_changed: string }>;
    };
    expect(result.totalMatched).toBe(10);
    expect(result.returned).toBe(3);
    expect(result.truncated).toBe(true);
    expect(result.changes.map((row) => row.last_changed)).toEqual([
      "2026-10-14T00:00:07Z",
      "2026-10-14T00:00:08Z",
      "2026-10-14T00:00:09Z",
    ]);
  });

  it.each([TOOL_NAMES.getHistory, TOOL_NAMES.getLogbook])(
    "%s rejects a limit above the documented cap",
    async (tool) => {
      const { options } = recorder([[]]);
      await expect(
        executeTool(options, tool, { entityId: "light.kitchen", limit: EVENT_PAGE_MAX + 1 }),
      ).rejects.toThrow(InvalidParameterError);
    },
  );

  it("list_services returns names only when no domain narrows it", async () => {
    const catalog = [
      { domain: "light", services: { turn_on: { fields: { brightness: {} } }, turn_off: {} } },
      { domain: "climate", services: { set_temperature: { fields: { temperature: {} } } } },
    ];
    const { options } = recorder([catalog]);
    const result = (await executeTool(options, TOOL_NAMES.listServices, {})) as {
      domain: string | null;
      detail: string;
      returned: number;
      domains: Array<{ domain: string; services: string[] }>;
    };
    expect(result.domain).toBeNull();
    expect(result.detail).toBe("names");
    expect(result.returned).toBe(2);
    expect(result.domains).toEqual([
      { domain: "light", services: ["turn_on", "turn_off"] },
      { domain: "climate", services: ["set_temperature"] },
    ]);
    // The field schemas are the bulk, and they are what a browse call drops.
    expect(JSON.stringify(result)).not.toContain("brightness");
  });

  it("list_services returns the full field schemas for one domain", async () => {
    const catalog = [
      { domain: "light", services: { turn_on: { fields: { brightness: {} } } } },
      { domain: "climate", services: { set_temperature: {} } },
    ];
    const { options } = recorder([catalog]);
    const result = (await executeTool(options, TOOL_NAMES.listServices, {
      domain: "light",
    })) as { detail: string; domains: unknown[] };
    expect(result.detail).toBe("full");
    expect(result.domains).toEqual([catalog[0]]);
  });
});
