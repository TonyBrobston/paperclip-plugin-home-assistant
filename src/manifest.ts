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
          "The address you open Home Assistant at, including the scheme and port and nothing else — for example http://homeassistant.local:8123. No path, query string or credentials.",
        // http is accepted because the ordinary deployment is a local address
        // with no certificate.
        pattern: "^https?://[^\\s/?#]+$",
      },
      [CONFIG_KEYS.token]: {
        type: "string",
        title: "Long-lived access token",
        description:
          "Create one in Home Assistant under your profile, at the bottom of the Security tab. Stored as a Paperclip secret reference, not as text in this config.",
        format: "secret-ref",
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
