/**
 * Identity, limits and tool names for the Home Assistant plugin.
 *
 * Kept dependency-free so the worker bundle stays small and the package needs
 * no `node_modules` at runtime (the bundler inlines the SDK; see README).
 */

export const PLUGIN_ID = "tbro.home-assistant";
export const PLUGIN_VERSION = "0.1.0";

/**
 * Bare tool names. The host namespaces these as `<PLUGIN_ID>:<name>` when it
 * publishes them to an agent, so `list_entities` reaches a run as
 * `tbro.home-assistant:list_entities`.
 *
 * Every name here is a read. That is not a stylistic choice: the host infers a
 * plugin tool's risk class from its name and cannot be told otherwise, so a
 * name that reads as a mutation would be classified `write` or `destructive`
 * and a name that mutates while reading as a read would be classified `read`.
 * Read names on read-only endpoints keep the inference correct. See README
 * "Why this plugin is read-only".
 */
export const TOOL_NAMES = {
  listEntities: "list_entities",
  getState: "get_state",
  listServices: "list_services",
  renderTemplate: "render_template",
  getConfig: "get_config",
  checkConfig: "check_config",
  getHistory: "get_history",
  getLogbook: "get_logbook",
  getErrorLog: "get_error_log",
} as const;

export type ToolName = (typeof TOOL_NAMES)[keyof typeof TOOL_NAMES];

/** Caps a `/api/states` response so a large installation cannot flood a run. */
export const ENTITY_PAGE_MAX = 500;

/** Home Assistant returns the error log as plaintext with no paging. */
export const LOG_TAIL_MAX_BYTES = 64 * 1024;

/** Largest response body read from Home Assistant, before parsing. */
export const RESPONSE_LIMIT_BYTES = 8 * 1024 * 1024;

/** Per-request timeout. Home Assistant is on the local network; this is slack. */
export const REQUEST_TIMEOUT_MS = 25_000;

/** Default history/logbook window when the caller gives no start time. */
export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Config keys on the instance settings page.
 *
 * `token` holds a Paperclip secret reference, never raw credential material.
 */
export const CONFIG_KEYS = {
  baseUrl: "baseUrl",
  token: "token",
} as const;
