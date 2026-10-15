import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { CONFIG_KEYS, PLUGIN_ID, PLUGIN_VERSION } from "./constants.js";
import { TOOL_DECLARATIONS } from "./tools.js";

/**
 * Home Assistant, as a read-only Paperclip plugin.
 *
 * Capabilities are deliberately minimal. The plugin reads its own config and
 * resolves one secret ref; it asks for nothing about companies, projects,
 * issues or agents, because none of those are needed to answer "what is the
 * entity ID for the kitchen light".
 *
 * `http.outbound` is declared because it is the capability that gates outbound
 * requests, but note the caveat in the README: the host's gated fetch helper
 * refuses private network addresses unconditionally, so the client uses the
 * worker runtime's own fetch to reach a LAN instance.
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Home Assistant (read-only)",
  description:
    "Read-only access to a Home Assistant instance: entity registry and live state, available services, template rendering, configuration, history, logbook and the error log. Lets an agent look things up directly instead of asking an operator to paste them.",
  author: "Tony Brobston",
  categories: ["connector"],
  capabilities: ["http.outbound", "secrets.read-ref", "agent.tools.register"],
  entrypoints: {
    worker: "./dist/worker.js",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      [CONFIG_KEYS.baseUrl]: {
        type: "string",
        title: "Home Assistant address",
        description:
          "The address you open Home Assistant at, including the scheme and port and nothing else — for example http://homeassistant.local:8123. A trailing slash is fine. No path, query string or credentials.",
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
        pattern: "^https?://[^\\s/?#@]+/*$",
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
        description:
          "Create one in Home Assistant under your profile, at the bottom of the Security tab, then save it as a Paperclip secret and pick it here. A token pasted as raw text is refused rather than stored in this config.",
        properties: {
          type: { const: "secret_ref" },
          secretId: { type: "string", minLength: 1 },
          version: { type: "string" },
        },
        required: ["type", "secretId"],
      },
    },
    required: [CONFIG_KEYS.baseUrl, CONFIG_KEYS.token],
  },
  tools: TOOL_DECLARATIONS.map((tool) => ({
    name: tool.name,
    displayName: tool.displayName,
    description: tool.description,
    parametersSchema: tool.parametersSchema,
  })),
};

export default manifest;
