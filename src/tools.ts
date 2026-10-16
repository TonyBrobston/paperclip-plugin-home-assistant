/**
 * The tool catalog, declared once.
 *
 * The manifest advertises these to the host and the worker registers handlers
 * for them. Both import this list, so a tool cannot be advertised without a
 * handler or registered without being declared.
 */

import {
  ENTITY_PAGE_MAX,
  EVENT_PAGE_MAX,
  LOG_TAIL_MAX_BYTES,
  TOOL_NAMES,
} from "./constants.js";

export interface ToolDeclaration {
  name: string;
  displayName: string;
  description: string;
  parametersSchema: Record<string, unknown>;
}

const entityIdProperty = {
  type: "string",
  description: "Entity ID such as light.kitchen or sensor.outdoor_temperature.",
  maxLength: 255,
} as const;

const startTimeProperty = {
  type: "string",
  description: "ISO 8601 start of the window. Defaults to 24 hours ago.",
} as const;

const endTimeProperty = {
  type: "string",
  description: "ISO 8601 end of the window. Defaults to now.",
} as const;

const eventLimitProperty = {
  type: "integer",
  minimum: 1,
  maximum: EVENT_PAGE_MAX,
  description: `Maximum rows to return, newest kept (default ${EVENT_PAGE_MAX}).`,
} as const;

function object(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

export const TOOL_DECLARATIONS: readonly ToolDeclaration[] = [
  {
    name: TOOL_NAMES.listEntities,
    displayName: "Home Assistant: list entities",
    description:
      "List Home Assistant entities with their current state, optionally filtered by domain or a search term. Use this to find the entity ID for something instead of guessing it. Returns a compact row per entity; use get_state for an entity's full attributes.",
    parametersSchema: object({
      domain: {
        type: "string",
        description: "Restrict to one domain, such as light, sensor or binary_sensor.",
        maxLength: 64,
      },
      search: {
        type: "string",
        description: "Case-insensitive substring match on entity ID and friendly name.",
        maxLength: 128,
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: ENTITY_PAGE_MAX,
        description: `Maximum rows to return (default ${ENTITY_PAGE_MAX}).`,
      },
    }),
  },
  {
    name: TOOL_NAMES.getState,
    displayName: "Home Assistant: get entity state",
    description:
      "Get one entity's full current state object, including every attribute and its last-changed timestamp.",
    parametersSchema: object({ entityId: entityIdProperty }, ["entityId"]),
  },
  {
    name: TOOL_NAMES.listServices,
    displayName: "Home Assistant: list services",
    description:
      "List the services Home Assistant exposes, optionally filtered by domain. Use this to confirm a service name and its parameters before writing an automation that calls it. Without a domain it returns service names only; pass a domain to get that domain's full field schemas, which are too large to return for every domain at once.",
    parametersSchema: object({
      domain: {
        type: "string",
        description: "Restrict to one domain, such as light or climate.",
        maxLength: 64,
      },
    }),
  },
  {
    name: TOOL_NAMES.renderTemplate,
    displayName: "Home Assistant: render template",
    description:
      "Render a Jinja2 template against live state and return the result. Use this to check a value_template or a condition before committing it to YAML.",
    parametersSchema: object(
      {
        template: {
          type: "string",
          description: "Template source, such as {{ states('sensor.outdoor_temperature') }}.",
          maxLength: 8192,
        },
      },
      ["template"],
    ),
  },
  {
    name: TOOL_NAMES.getConfig,
    displayName: "Home Assistant: get configuration",
    description:
      "Get the instance configuration: version, time zone, unit system, location name and loaded components.",
    parametersSchema: object({}),
  },
  {
    name: TOOL_NAMES.checkConfig,
    displayName: "Home Assistant: check configuration",
    description:
      "Validate the current Home Assistant configuration and return any errors. Read-only: it checks the config on disk and changes nothing. Home Assistant expands !secret before it validates, so credential-shaped text in the errors is replaced with [redacted-credential] before you see it — ask the operator if you need the real value.",
    parametersSchema: object({}),
  },
  {
    name: TOOL_NAMES.getHistory,
    displayName: "Home Assistant: get entity history",
    description:
      "Get recorded state history for one entity over a time window. Use this to see how something actually behaved rather than inferring it.",
    parametersSchema: object(
      {
        entityId: entityIdProperty,
        startTime: startTimeProperty,
        endTime: endTimeProperty,
        limit: eventLimitProperty,
        minimalResponse: {
          type: "boolean",
          description:
            "Return state changes without full attributes (default true, and much smaller).",
        },
      },
      ["entityId"],
    ),
  },
  {
    name: TOOL_NAMES.getLogbook,
    displayName: "Home Assistant: get logbook",
    description:
      "Get human-readable logbook entries over a time window, optionally for one entity — what happened and what triggered it. Filter by entity where you can: a whole-installation logbook runs to thousands of entries, and only the newest page is returned.",
    parametersSchema: object({
      entityId: entityIdProperty,
      startTime: startTimeProperty,
      endTime: endTimeProperty,
      limit: eventLimitProperty,
    }),
  },
  {
    name: TOOL_NAMES.getErrorLog,
    displayName: "Home Assistant: get error log",
    description:
      "Get the tail of the Home Assistant error log. Use this to diagnose a failing integration or a broken automation. Credential-shaped text — tokens, authorization headers, credentials in logged request URLs — is replaced with [redacted-credential] before you see it, and the redacted flag says whether anything in the returned tail was replaced.",
    parametersSchema: object({
      maxBytes: {
        type: "integer",
        minimum: 1024,
        maximum: LOG_TAIL_MAX_BYTES,
        description: `Bytes to return from the end of the log (default ${LOG_TAIL_MAX_BYTES}).`,
      },
    }),
  },
];
