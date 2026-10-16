// src/constants.ts
var PLUGIN_ID = "tbro.home-assistant";
var PLUGIN_VERSION = "0.1.0";
var TOOL_NAMES = {
  listEntities: "list_entities",
  getState: "get_state",
  listServices: "list_services",
  renderTemplate: "render_template",
  getConfig: "get_config",
  checkConfig: "check_config",
  getHistory: "get_history",
  getLogbook: "get_logbook",
  getErrorLog: "get_error_log"
};
var NAMESPACED_TOOL_NAMES = Object.values(
  TOOL_NAMES
).map((name) => `${PLUGIN_ID}:${name}`);
var ENTITY_PAGE_MAX = 500;
var EVENT_PAGE_MAX = 500;
var LOG_TAIL_MAX_BYTES = 64 * 1024;
var RESPONSE_LIMIT_BYTES = 8 * 1024 * 1024;
var DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1e3;
var CONFIG_KEYS = {
  baseUrl: "baseUrl",
  token: "token"
};

// src/tools.ts
var entityIdProperty = {
  type: "string",
  description: "Entity ID such as light.kitchen or sensor.outdoor_temperature.",
  maxLength: 255
};
var startTimeProperty = {
  type: "string",
  description: "ISO 8601 start of the window. Defaults to 24 hours ago."
};
var endTimeProperty = {
  type: "string",
  description: "ISO 8601 end of the window. Defaults to now."
};
var eventLimitProperty = {
  type: "integer",
  minimum: 1,
  maximum: EVENT_PAGE_MAX,
  description: `Maximum rows to return, newest kept (default ${EVENT_PAGE_MAX}).`
};
function object(properties, required = []) {
  return {
    type: "object",
    properties,
    ...required.length > 0 ? { required } : {},
    additionalProperties: false
  };
}
var TOOL_DECLARATIONS = [
  {
    name: TOOL_NAMES.listEntities,
    displayName: "Home Assistant: list entities",
    description: "List Home Assistant entities with their current state, optionally filtered by domain or a search term. Use this to find the entity ID for something instead of guessing it. Returns a compact row per entity; use get_state for an entity's full attributes.",
    parametersSchema: object({
      domain: {
        type: "string",
        description: "Restrict to one domain, such as light, sensor or binary_sensor.",
        maxLength: 64
      },
      search: {
        type: "string",
        description: "Case-insensitive substring match on entity ID and friendly name.",
        maxLength: 128
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: ENTITY_PAGE_MAX,
        description: `Maximum rows to return (default ${ENTITY_PAGE_MAX}).`
      }
    })
  },
  {
    name: TOOL_NAMES.getState,
    displayName: "Home Assistant: get entity state",
    description: "Get one entity's full current state object, including every attribute and its last-changed timestamp.",
    parametersSchema: object({ entityId: entityIdProperty }, ["entityId"])
  },
  {
    name: TOOL_NAMES.listServices,
    displayName: "Home Assistant: list services",
    description: "List the services Home Assistant exposes, optionally filtered by domain. Use this to confirm a service name and its parameters before writing an automation that calls it. Without a domain it returns service names only; pass a domain to get that domain's full field schemas, which are too large to return for every domain at once.",
    parametersSchema: object({
      domain: {
        type: "string",
        description: "Restrict to one domain, such as light or climate.",
        maxLength: 64
      }
    })
  },
  {
    name: TOOL_NAMES.renderTemplate,
    displayName: "Home Assistant: render template",
    description: "Render a Jinja2 template against live state and return the result. Use this to check a value_template or a condition before committing it to YAML.",
    parametersSchema: object(
      {
        template: {
          type: "string",
          description: "Template source, such as {{ states('sensor.outdoor_temperature') }}.",
          maxLength: 8192
        }
      },
      ["template"]
    )
  },
  {
    name: TOOL_NAMES.getConfig,
    displayName: "Home Assistant: get configuration",
    description: "Get the instance configuration: version, time zone, unit system, location name and loaded components.",
    parametersSchema: object({})
  },
  {
    name: TOOL_NAMES.checkConfig,
    displayName: "Home Assistant: check configuration",
    description: "Validate the current Home Assistant configuration and return any errors. Read-only: it checks the config on disk and changes nothing. Home Assistant expands !secret before it validates, so credential-shaped text in the errors is replaced with [redacted-credential] before you see it \u2014 ask the operator if you need the real value.",
    parametersSchema: object({})
  },
  {
    name: TOOL_NAMES.getHistory,
    displayName: "Home Assistant: get entity history",
    description: "Get recorded state history for one entity over a time window. Use this to see how something actually behaved rather than inferring it.",
    parametersSchema: object(
      {
        entityId: entityIdProperty,
        startTime: startTimeProperty,
        endTime: endTimeProperty,
        limit: eventLimitProperty,
        minimalResponse: {
          type: "boolean",
          description: "Return state changes without full attributes (default true, and much smaller)."
        }
      },
      ["entityId"]
    )
  },
  {
    name: TOOL_NAMES.getLogbook,
    displayName: "Home Assistant: get logbook",
    description: "Get human-readable logbook entries over a time window, optionally for one entity \u2014 what happened and what triggered it. Filter by entity where you can: a whole-installation logbook runs to thousands of entries, and only the newest page is returned.",
    parametersSchema: object({
      entityId: entityIdProperty,
      startTime: startTimeProperty,
      endTime: endTimeProperty,
      limit: eventLimitProperty
    })
  },
  {
    name: TOOL_NAMES.getErrorLog,
    displayName: "Home Assistant: get error log",
    description: "Get the tail of the Home Assistant error log. Use this to diagnose a failing integration or a broken automation. Credential-shaped text \u2014 tokens, authorization headers, credentials in logged request URLs \u2014 is replaced with [redacted-credential] before you see it, and the redacted flag says whether anything in the returned tail was replaced.",
    parametersSchema: object({
      maxBytes: {
        type: "integer",
        minimum: 1024,
        maximum: LOG_TAIL_MAX_BYTES,
        description: `Bytes to return from the end of the log (default ${LOG_TAIL_MAX_BYTES}).`
      }
    })
  }
];

// src/manifest.ts
var manifest = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Home Assistant (read-only)",
  description: "Read-only access to a Home Assistant instance: entity registry and live state, available services, template rendering, configuration, history, logbook and the error log. Lets an agent look things up directly instead of asking an operator to paste them.",
  author: "Tony Brobston",
  categories: ["connector"],
  capabilities: ["http.outbound", "secrets.read-ref", "agent.tools.register"],
  entrypoints: {
    worker: "./dist/worker.js"
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      [CONFIG_KEYS.baseUrl]: {
        type: "string",
        title: "Home Assistant address",
        description: "The address you open Home Assistant at, including the scheme and port and nothing else \u2014 for example http://homeassistant.local:8123. A trailing slash is fine. No path, query string or credentials.",
        // http is accepted because the ordinary deployment is a local address
        // with no certificate.
        //
        // The trailing slash is accepted because a browser address bar shows
        // one and this field is filled by pasting: the host validates this
        // pattern with Ajv and rejects the whole save with a message naming
        // only the schema, so an unaccepted slash reads as a broken plugin
        // rather than as one stray character. `homeAssistantApiUrl` strips it
        // before building a request, so there is nothing for the pattern to
        // protect here.
        //
        // `@` is excluded so the pattern refuses the credentials its own
        // description refuses. `homeAssistantApiUrl` throws on them too, but
        // only once a tool is called — by which point the save looked fine.
        pattern: "^https?://[^\\s/?#@]+/*$"
      },
      [CONFIG_KEYS.token]: {
        // `format: "secret-ref"` is what makes the settings form render a
        // secret picker, and the picker writes a binding *object* — not a
        // string. The host validates this schema with Ajv before it looks for
        // secret bindings, so declaring `type: "string"` here rejected the only
        // value the form can produce, with "/token must be string". The field
        // has to be typed as the object it receives.
        //
        // Ajv's strict mode logs that `format` expects a string or number type;
        // it is a log, not an error, and the keyword is a host-side UI hint
        // that never validates a value.
        type: "object",
        format: "secret-ref",
        title: "Long-lived access token",
        description: "Create one in Home Assistant under your profile, at the bottom of the Security tab, then save it as a Paperclip secret and pick it here. A token pasted as raw text is refused rather than stored in this config.",
        properties: {
          type: { const: "secret_ref" },
          secretId: { type: "string", minLength: 1 }
          // `version` is deliberately unconstrained. The host's own binding
          // parser accepts "latest" or a positive integer, so a pinned version
          // arrives as a number — and over-constraining this field is the
          // mistake that made the save impossible in the first place. The host
          // parses and rejects a bad binding after this schema runs.
        },
        required: ["type", "secretId"]
      }
    },
    required: [CONFIG_KEYS.baseUrl, CONFIG_KEYS.token]
  },
  tools: TOOL_DECLARATIONS.map((tool) => ({
    name: tool.name,
    displayName: tool.displayName,
    description: tool.description,
    parametersSchema: tool.parametersSchema
  }))
};
var manifest_default = manifest;
export {
  manifest_default as default
};
//# sourceMappingURL=manifest.js.map
