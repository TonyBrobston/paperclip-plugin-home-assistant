/**
 * Home Assistant REST client and the read-only tool catalog.
 *
 * Every branch in {@link executeTool} builds its own path from validated
 * input. No branch accepts a caller-supplied path, URL, HTTP method or
 * pass-through body, so an agent cannot reach an endpoint this plugin does not
 * document — the tool list is the whole reachable surface.
 */

import {
  DEFAULT_WINDOW_MS,
  ENTITY_PAGE_MAX,
  EVENT_PAGE_MAX,
  LOG_TAIL_MAX_BYTES,
  REQUEST_TIMEOUT_MS,
  RESPONSE_LIMIT_BYTES,
  TOOL_NAMES,
} from "./constants.js";
import {
  asRecord,
  domain,
  entityId,
  InvalidParameterError,
  optionalBoolean,
  optionalInteger,
  optionalString,
  optionalTimestamp,
  rejectUnknownKeys,
  requiredString,
} from "./validate.js";

export class HomeAssistantError extends Error {}

/** Injectable for tests; defaults to the runtime's own fetch. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: FetchLike;
}

/**
 * Build an API URL from the operator-entered instance address.
 *
 * An address carrying credentials, a query or a fragment would silently
 * rewrite every request built from it, so those are refused here rather than
 * trusted because a settings field once validated them — stored config can be
 * older than the field, or hand-edited in the database.
 */
export function homeAssistantApiUrl(baseUrl: string, path: string): URL {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  // `new URL("homeassistant:8123")` parses as the scheme `homeassistant:` with
  // an opaque path rather than throwing, so an address that lost its scheme
  // would build a nonsense request instead of failing here.
  const base = new URL(trimmed);
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new HomeAssistantError(
      "The Home Assistant address must start with http:// or https://",
    );
  }
  if (base.username || base.password) {
    throw new HomeAssistantError(
      "The Home Assistant address must not contain credentials.",
    );
  }
  if (base.search || base.hash) {
    throw new HomeAssistantError(
      "The Home Assistant address must not contain a query string or fragment.",
    );
  }
  return new URL(`${trimmed}${path}`);
}

/**
 * Home Assistant streams a whole-installation state dump on `/api/states`.
 * Read it with a ceiling so one call cannot exhaust the worker's memory.
 */
async function readBounded(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > RESPONSE_LIMIT_BYTES) {
        throw new HomeAssistantError(
          "Home Assistant returned more data than this plugin will read in one call. Narrow the request with a domain, a search term or a time window.",
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function call(
  options: ClientOptions,
  path: string,
  body?: unknown,
): Promise<string> {
  const url = homeAssistantApiUrl(options.baseUrl, path);
  const init: RequestInit = {
    method: body === undefined ? "GET" : "POST",
    // A redirect off the configured host would carry the token with it.
    redirect: "error",
    headers: {
      Authorization: `Bearer ${options.token}`,
      Accept: "application/json, text/plain",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url.toString(), init);
  } catch (error) {
    // The address and token are operator configuration. Never echo the
    // attempted URL or the underlying error text back to the agent.
    if (error instanceof HomeAssistantError) throw error;
    throw new HomeAssistantError(
      "Home Assistant could not be reached at the configured address.",
    );
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 401 || response.status === 403) {
      throw new HomeAssistantError(
        "Home Assistant rejected the long-lived access token. Replace it in the plugin settings with a current one.",
      );
    }
    if (response.status === 404) {
      throw new HomeAssistantError(
        "Home Assistant has no such entity or endpoint.",
      );
    }
    throw new HomeAssistantError(
      `Home Assistant request failed (${response.status}).`,
    );
  }

  return readBounded(response);
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new HomeAssistantError(
      "Home Assistant returned a response this plugin could not parse as JSON.",
    );
  }
}

type HomeAssistantState = {
  entity_id?: unknown;
  state?: unknown;
  attributes?: Record<string, unknown>;
  last_changed?: unknown;
};

/**
 * The compact row shape used by `list_entities`.
 *
 * The full object — every attribute — stays behind `get_state`. A whole-house
 * dump of full state objects is mostly attribute noise and crowds out the run's
 * context for no gain.
 */
function summarizeState(state: HomeAssistantState) {
  const attributes = state.attributes ?? {};
  return {
    entityId: state.entity_id,
    state: state.state,
    friendlyName: attributes.friendly_name ?? null,
    deviceClass: attributes.device_class ?? null,
    unitOfMeasurement: attributes.unit_of_measurement ?? null,
    lastChanged: state.last_changed ?? null,
  };
}

function window(startTime?: string, endTime?: string) {
  return {
    start: startTime ?? new Date(Date.now() - DEFAULT_WINDOW_MS).toISOString(),
    end: endTime,
  };
}

/**
 * Require a JSON array from an endpoint documented to return one.
 *
 * Every array Home Assistant returns is wrapped in an object before it leaves
 * this module, because the host forwards a tool's structured result as MCP
 * `structuredContent` and that field must be a JSON *object*. A top-level
 * array is rejected by the client's schema before the agent sees any of it, so
 * a tool that returns one is unusable even when Home Assistant answered
 * perfectly. See README "Why every result is an object".
 */
function expectArray(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new HomeAssistantError(`Home Assistant returned an unexpected ${what}.`);
  }
  return value;
}

/**
 * Flatten `/api/history/period`'s per-entity series into one list of rows.
 *
 * Home Assistant answers with an array of series, one per entity. `get_history`
 * requires an entity ID and sends `filter_entity_id`, so there is at most one
 * series; flattening keeps the nesting out of the agent's way. Anything that is
 * not an array of arrays is passed through as a single series rather than
 * discarded, so an unexpected shape still reaches the agent.
 */
function flattenHistory(value: unknown): unknown[] {
  const series = expectArray(value, "history response");
  if (series.length === 0) return [];
  if (series.every((entry) => Array.isArray(entry))) {
    return series.flat() as unknown[];
  }
  return series;
}

/**
 * The newest `limit` rows, in the order Home Assistant gave them.
 *
 * History and logbook come back oldest first, so a head slice would drop the
 * events closest to whatever question prompted the call. Keeping the tail
 * keeps "what just happened" answerable from a truncated page.
 */
function mostRecent(rows: readonly unknown[], limit: number): unknown[] {
  return rows.length <= limit ? [...rows] : rows.slice(rows.length - limit);
}

/**
 * `{ domain, services: { turn_on: { fields: … } } }` reduced to its names.
 *
 * A whole-installation service catalog is mostly per-service field schemas —
 * 351 KB of them on a real instance. A caller with no domain filter is
 * browsing for a name, so answer with the names and let them ask again for
 * the one domain they want.
 */
function serviceNames(entry: unknown): unknown {
  if (entry === null || typeof entry !== "object") return entry;
  const record = entry as { domain?: unknown; services?: unknown };
  const services = record.services;
  return {
    domain: record.domain ?? null,
    services:
      services !== null && typeof services === "object"
        ? Object.keys(services as Record<string, unknown>)
        : [],
  };
}

/** The documented liveness endpoint. It requires the token, so a success proves both reachability and a valid credential without reading household data. */
export async function probe(options: ClientOptions): Promise<void> {
  await call(options, "/api/");
}

export async function executeTool(
  options: ClientOptions,
  toolName: string,
  parameters: unknown,
): Promise<unknown> {
  const params = asRecord(parameters);
  const run = (path: string, body?: unknown) => call(options, path, body);

  switch (toolName) {
    case TOOL_NAMES.listEntities: {
      rejectUnknownKeys(params, ["domain", "search", "limit"]);
      const domainFilter = optionalString(params, "domain", 64);
      const search = optionalString(params, "search", 128)?.toLowerCase();
      const limit = optionalInteger(params, "limit", 1, ENTITY_PAGE_MAX) ?? ENTITY_PAGE_MAX;
      if (domainFilter !== undefined) domain(domainFilter, "domain");

      const states = expectArray(parseJson(await run("/api/states")), "state list");
      const matched = (states as HomeAssistantState[]).filter((state) => {
        const id = typeof state.entity_id === "string" ? state.entity_id : "";
        if (domainFilter && !id.startsWith(`${domainFilter}.`)) return false;
        if (!search) return true;
        const friendly = state.attributes?.friendly_name;
        return (
          id.toLowerCase().includes(search) ||
          (typeof friendly === "string" && friendly.toLowerCase().includes(search))
        );
      });
      return {
        totalMatched: matched.length,
        returned: Math.min(matched.length, limit),
        truncated: matched.length > limit,
        entities: matched.slice(0, limit).map(summarizeState),
      };
    }

    case TOOL_NAMES.getState: {
      rejectUnknownKeys(params, ["entityId"]);
      const id = entityId(requiredString(params, "entityId", 255), "entityId");
      return parseJson(await run(`/api/states/${encodeURIComponent(id)}`));
    }

    case TOOL_NAMES.listServices: {
      rejectUnknownKeys(params, ["domain"]);
      const domainFilter = optionalString(params, "domain", 64);
      if (domainFilter !== undefined) domain(domainFilter, "domain");
      const services = expectArray(
        parseJson(await run("/api/services")),
        "service list",
      );
      const matched = domainFilter
        ? services.filter(
            (entry) =>
              entry !== null &&
              typeof entry === "object" &&
              (entry as { domain?: unknown }).domain === domainFilter,
          )
        : services;
      // Full field schemas for every domain at once do not fit in a run's
      // context. Narrowing to one domain is what makes them affordable.
      const detail = domainFilter ? "full" : "names";
      return {
        domain: domainFilter ?? null,
        detail,
        returned: matched.length,
        domains: detail === "full" ? matched : matched.map(serviceNames),
      };
    }

    case TOOL_NAMES.renderTemplate: {
      rejectUnknownKeys(params, ["template"]);
      const template = requiredString(params, "template", 8192);
      // Home Assistant returns rendered output as plaintext, not JSON.
      return { rendered: await run("/api/template", { template }) };
    }

    case TOOL_NAMES.getConfig: {
      rejectUnknownKeys(params, []);
      return parseJson(await run("/api/config"));
    }

    case TOOL_NAMES.checkConfig: {
      rejectUnknownKeys(params, []);
      return parseJson(await run("/api/config/core/check_config", {}));
    }

    case TOOL_NAMES.getHistory: {
      rejectUnknownKeys(params, [
        "entityId",
        "startTime",
        "endTime",
        "limit",
        "minimalResponse",
      ]);
      const id = entityId(requiredString(params, "entityId", 255), "entityId");
      const { start, end } = window(
        optionalTimestamp(params, "startTime"),
        optionalTimestamp(params, "endTime"),
      );
      const minimal = optionalBoolean(params, "minimalResponse") ?? true;
      const limit = optionalInteger(params, "limit", 1, EVENT_PAGE_MAX) ?? EVENT_PAGE_MAX;
      const query = new URLSearchParams({ filter_entity_id: id });
      if (end) query.set("end_time", end);
      // Home Assistant treats the bare presence of this key as the flag.
      if (minimal) query.set("minimal_response", "");
      const changes = flattenHistory(
        parseJson(
          await run(`/api/history/period/${encodeURIComponent(start)}?${query.toString()}`),
        ),
      );
      const page = mostRecent(changes, limit);
      return {
        entityId: id,
        start,
        end: end ?? null,
        minimalResponse: minimal,
        totalMatched: changes.length,
        returned: page.length,
        truncated: changes.length > page.length,
        changes: page,
      };
    }

    case TOOL_NAMES.getLogbook: {
      rejectUnknownKeys(params, ["entityId", "startTime", "endTime", "limit"]);
      const rawId = optionalString(params, "entityId", 255);
      const id = rawId === undefined ? undefined : entityId(rawId, "entityId");
      const { start, end } = window(
        optionalTimestamp(params, "startTime"),
        optionalTimestamp(params, "endTime"),
      );
      const limit = optionalInteger(params, "limit", 1, EVENT_PAGE_MAX) ?? EVENT_PAGE_MAX;
      const query = new URLSearchParams();
      if (id) query.set("entity", id);
      if (end) query.set("end_time", end);
      const suffix = query.toString();
      const entries = expectArray(
        parseJson(
          await run(`/api/logbook/${encodeURIComponent(start)}${suffix ? `?${suffix}` : ""}`),
        ),
        "logbook response",
      );
      const page = mostRecent(entries, limit);
      return {
        entityId: id ?? null,
        start,
        end: end ?? null,
        totalMatched: entries.length,
        returned: page.length,
        truncated: entries.length > page.length,
        entries: page,
      };
    }

    case TOOL_NAMES.getErrorLog: {
      rejectUnknownKeys(params, ["maxBytes"]);
      const maxBytes =
        optionalInteger(params, "maxBytes", 1024, LOG_TAIL_MAX_BYTES) ?? LOG_TAIL_MAX_BYTES;
      const log = Buffer.from(await run("/api/error_log"), "utf8");
      return {
        truncated: log.byteLength > maxBytes,
        // The tail is the useful end of a log file.
        log: log.subarray(Math.max(0, log.byteLength - maxBytes)).toString("utf8"),
      };
    }

    default:
      throw new HomeAssistantError(`Unknown Home Assistant tool: ${toolName}`);
  }
}

export { InvalidParameterError };
