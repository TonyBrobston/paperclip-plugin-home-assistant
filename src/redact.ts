/**
 * Credential scrubbing for the two tools that return raw provider text.
 *
 * `get_error_log` and `check_config` are the only tools whose result is text
 * Home Assistant composed rather than a field this plugin chose. Both routinely
 * carry credentials:
 *
 * - An integration that logs a failing request logs its URL, and a URL built
 *   from a configured API key carries the key in the query string. Several
 *   integrations log the request headers too, `Authorization` included.
 * - `check_config` validates the configuration *after* `!secret` substitution,
 *   so the "offending value" voluptuous quotes back is the expanded secret, not
 *   the `!secret` reference the operator wrote.
 *
 * The plugin SDK has no risk level or ask-first field on a registered agent
 * tool, so there is no per-call approval an operator could turn on: scrubbing
 * here is the only control available. See README "Why two tools are scrubbed".
 *
 * Two kinds of rule run, and the distinction is the honest part of this file:
 *
 * - **Context rules** key off a credential-naming word, or a position that
 *   names the value, right there in the text (`authorization:`, `?api_key=`,
 *   `data['password']`, the userinfo of a `http://user:pass@host` URL). These
 *   are precise, and they are the ones worth trusting.
 * - **Shape rules** key off the look of the value alone (a JWT, a long opaque
 *   run of token characters). These are a backstop for a credential whose name
 *   this file never anticipated, and they over-redact by design — a 40-character
 *   opaque blob in a log tail is rarely the diagnostic part, and a visible
 *   marker is a better outcome than a leaked token.
 *
 * Neither kind is a proof. Pattern matching cannot recognise a secret that
 * looks like ordinary prose, so this reduces exposure rather than eliminating
 * it. Nothing is dropped silently: every removal leaves
 * {@link REDACTION_MARKER} where the value was, so a reader can tell the
 * difference between "Home Assistant said nothing here" and "this plugin took
 * something out".
 */

/** Left in place of every removed value, so a redaction is never silent. */
export const REDACTION_MARKER = "[redacted-credential]";

/**
 * Below this length, replacing every occurrence of the configured token does
 * more harm than good: a short token is a substring of ordinary log text, and
 * blanking it would shred the log while protecting a credential that is not
 * usable as a Home Assistant long-lived token anyway (real ones are JWTs,
 * hundreds of characters long).
 */
const MIN_LITERAL_TOKEN_LENGTH = 8;

/**
 * Key names that mean "the value next to me is a credential".
 *
 * Used three ways: in `key: value` and `key=value` assignments, as a query
 * parameter name, and as the bracketed key in a voluptuous validation error.
 * Written as one source string so those three rules cannot drift apart.
 */
const SENSITIVE_KEY = String.raw`(?:api[_-]?password|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|bearer[_-]?token|client[_-]?secret|consumer[_-]?secret|private[_-]?key|secret[_-]?key|app[_-]?key|app[_-]?secret|password|passwd|passphrase|pwd|secret|token|credential|credentials|cookie|auth)`;

/**
 * Header names that carry a credential as their whole value.
 *
 * `x-ha-access` is Home Assistant's own legacy auth header and still appears in
 * older integrations' debug output; `x-api-key` and `x-auth-token` are the two
 * most common vendor spellings in integration logs.
 */
const CREDENTIAL_HEADER = String.raw`(?:proxy-authorization|authorization|x-ha-access|x-auth-token|x-api-key|x-apikey)`;

/** Auth schemes kept in the output, because "which scheme" is diagnostic and the scheme itself is not secret. */
const AUTH_SCHEME = String.raw`(?:bearer|basic|digest|token|apikey)`;

/**
 * `Authorization: Bearer <token>`, and the same header as it appears in a
 * logged header dict (`{'Authorization': 'Bearer …'}`) or a `curl` echo.
 *
 * The scheme word is preserved and only the credential after it is replaced.
 */
const AUTHORIZATION_HEADER = new RegExp(
  String.raw`(["']?\b${CREDENTIAL_HEADER}\b["']?\s*[:=]\s*["']?)(${AUTH_SCHEME}\s+)?([^\s"',;)\]}]+)`,
  "gi",
);

/**
 * A credential carried in a query string.
 *
 * Anchored on `?` or `&` so only a real query parameter matches — this must not
 * fire on the prose of a log message. `api_password` is Home Assistant's own
 * pre-auth query credential and is named in the issue; the rest are the
 * spellings integrations actually use.
 */
const CREDENTIAL_QUERY_PARAM = new RegExp(
  String.raw`([?&](?:${SENSITIVE_KEY}|authsig|signature|sig|code|key)=)([^&\s"'<>\\)\]}]+)`,
  "gi",
);

/**
 * `password: hunter2`, `"api_key": "…"`, `token=…`.
 *
 * This is the rule that covers YAML and dict fragments echoed into an error,
 * which is how `check_config` hands back an expanded `!secret`. A quoted value
 * is matched as a whole so a password containing spaces is removed completely
 * rather than down to its first space.
 */
const SENSITIVE_ASSIGNMENT = new RegExp(
  String.raw`(["']?\b${SENSITIVE_KEY}\b["']?\s*[:=]\s*)((["'])(?:(?!\3)[^\n])*\3|[^\s,;)\]}\n]+)`,
  "gi",
);

/**
 * A credential in a URL's userinfo: `scheme://user:password@host/…`.
 *
 * `generic` camera, `mjpeg`, `ffmpeg`, `rest` and `scrape` are all configured
 * with a URL that can carry basic-auth, and all of them log that URL when a
 * request fails. The position after the colon is what names the value, so this
 * belongs with the context rules — the password is usually far too short for
 * {@link LONG_OPAQUE_SECRET} to reach.
 *
 * The value is matched greedily up to the *last* `@` before the host, because
 * an unencoded `@` inside a password is common enough that stopping at the
 * first one would leave the tail of the password in the log. It may not cross
 * `/`, `?` or `#`, which is what keeps the rule off a portless-looking URL
 * whose query happens to contain an `@` (`https://host:8123?to=a@b.test`).
 */
const URL_USERINFO = /([a-z][a-z0-9+.-]*:\/\/[^\s:/?#@"']+:)([^\s/?#"']+)(?=@)/gi;

/**
 * voluptuous' "offending value" clause for a credential key.
 *
 * `check_config` errors read: `expected str for dictionary value @
 * data['password']. Got 'hunter2'` — the key is bracketed, not assigned, so
 * {@link SENSITIVE_ASSIGNMENT} does not see it. The bracketed key is matched
 * anywhere in the chain (`data['smtp']['password']` included) and the value
 * after `Got` is replaced.
 *
 * `None` and `null` are left alone: they say the key was absent, which is the
 * whole content of that error and is not a credential.
 */
const SENSITIVE_GOT_VALUE = new RegExp(
  String.raw`(\[["']${SENSITIVE_KEY}["']\][^\n]{0,200}?\bGot\s+)(["'](?:[^"'\n]*)["']|[^\s,;)\]}\n]+)`,
  "gi",
);

/**
 * A JSON Web Token.
 *
 * This is the shape of a Home Assistant long-lived access token and of every
 * signed-path token the frontend hands out, so it is the single highest-value
 * shape rule here. Anchored on `eyJ` — the base64url of `{"`, which every JOSE
 * header starts with — rather than on "three dotted segments", which also
 * describes a hostname and a dotted file path.
 */
const JWT = /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}(?:\.[A-Za-z0-9_-]+)?/g;

/**
 * A long opaque run of token characters, mixing letters and digits.
 *
 * The last line of defence, for a credential this file has no name for: a
 * supervisor token, a vendor API key logged without a label, a webhook ID. The
 * 40-character floor and the letter-and-digit requirement are what keep it off
 * most ordinary log text — words, module paths and ISO timestamps are all
 * either shorter or broken up by characters outside the class.
 *
 * It does over-redact, and underscore being inside the class means entity IDs
 * are part of that: an auto-generated `sensor.<40+ chars with a digit>` from
 * Z-Wave JS, Zigbee2MQTT, Shelly or ESPHome is replaced, which can empty out an
 * "Unable to find entity …" line. A git SHA or a long registry ID goes the same
 * way. That is the intended trade and it is deliberately not narrowed here: a
 * discriminator loose enough to keep long entity IDs is loose enough to be a
 * way around the backstop, and this rule exists for the credential nobody
 * named. The marker says what happened, and an agent that needs the unredacted
 * value can ask the operator for it.
 *
 * The class is base64**url** (`-` and `_`). A standard-alphabet base64 secret
 * containing `+` or `/` is split into sub-40 runs and survives this rule —
 * widening the class is not the fix, because `/` would swallow long filesystem
 * and module paths wholesale. Labelled cases are the context rules' job, which
 * is why `cookie` is in {@link SENSITIVE_KEY}.
 */
const LONG_OPAQUE_SECRET =
  /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Has this value already been replaced by an earlier rule?
 *
 * Several rules can describe the same credential — `?api_key=…` is both a
 * query parameter and a `key=value` assignment — and the marker's own brackets
 * fall outside the bare-value character classes, so a second rule would match
 * the marker's prefix and leave the closing bracket stranded as text. Matching
 * on the marker's leading word rather than the whole marker is what catches
 * that partial form. Scrubbing is therefore idempotent, which also means a
 * scrubbed string can be safely passed through again.
 */
function alreadyRedacted(value: string): boolean {
  return value.startsWith(REDACTION_MARKER.slice(0, "[redacted".length));
}

/**
 * Every spelling of the configured token that could appear in provider text.
 *
 * The raw value is the common case. The percent-encoded form is what appears
 * when an integration logs a URL it built with the token in the query string,
 * and `encodeURIComponent` leaves a JWT unchanged, so the two forms are
 * deduplicated rather than both always applied.
 */
function tokenSpellings(token: string): string[] {
  const trimmed = token.trim();
  if (trimmed.length < MIN_LITERAL_TOKEN_LENGTH) return [];
  const spellings = new Set([trimmed, encodeURIComponent(trimmed)]);
  return [...spellings];
}

/**
 * Remove credential-shaped text from one string.
 *
 * `token` is the credential this plugin was configured with. It is matched
 * literally and first: it is the one secret whose exact value is known here, so
 * it should never depend on a pattern recognising it.
 */
export function redactCredentials(text: string, token?: string): string {
  if (text === "") return text;
  let out = text;

  if (token) {
    for (const spelling of tokenSpellings(token)) {
      out = out.replace(new RegExp(escapeRegExp(spelling), "g"), REDACTION_MARKER);
    }
  }

  // Context rules first: a named credential is replaced on the strength of its
  // name, before a shape rule gets a chance to half-match the same value.
  out = out.replace(
    AUTHORIZATION_HEADER,
    (match, prefix: string, scheme: string | undefined, value: string) =>
      alreadyRedacted(value)
        ? match
        : `${prefix}${scheme ?? ""}${REDACTION_MARKER}`,
  );
  out = out.replace(
    URL_USERINFO,
    (match, prefix: string, value: string) =>
      alreadyRedacted(value) ? match : `${prefix}${REDACTION_MARKER}`,
  );
  out = out.replace(
    CREDENTIAL_QUERY_PARAM,
    (match, prefix: string, value: string) =>
      alreadyRedacted(value) ? match : `${prefix}${REDACTION_MARKER}`,
  );
  out = out.replace(
    SENSITIVE_GOT_VALUE,
    (match, prefix: string, value: string) =>
      /^(?:None|null)$/i.test(value) || alreadyRedacted(value)
        ? match
        : `${prefix}${REDACTION_MARKER}`,
  );
  out = out.replace(
    SENSITIVE_ASSIGNMENT,
    (match, prefix: string, value: string) =>
      alreadyRedacted(value) ? match : `${prefix}${REDACTION_MARKER}`,
  );

  out = out.replace(JWT, REDACTION_MARKER);
  out = out.replace(LONG_OPAQUE_SECRET, REDACTION_MARKER);

  return out;
}

/**
 * The same key names, matched whole, with a plural tolerated.
 *
 * A JSON key is matched as a whole word where a text rule cannot be: there is
 * no surrounding prose to mistake it for. The optional `s` is for the list
 * form — `tokens`, `passwords` — which costs nothing here and would be unsafe
 * to allow in the text rules, where `secrets.yaml` is ordinary log content.
 */
const SENSITIVE_KEY_NAME = new RegExp(String.raw`^${SENSITIVE_KEY}s?$`, "i");

/**
 * Scrub every string inside a parsed JSON value, in place of the value's shape.
 *
 * `check_config` returns an object whose error text has moved between Home
 * Assistant releases — a string, a list of strings, a nested object — so the
 * walk is shape-agnostic on purpose: a release that changes where the errors
 * live cannot route them around the scrub.
 *
 * A string reached under a credential-named key is removed outright rather than
 * pattern-matched, because the key already said what it is. Keys themselves are
 * left alone: `password` as a key name is not a secret, and blanking it would
 * hide which setting the error is about.
 *
 * `key` is the nearest credential-named *ancestor*, not the immediate parent
 * key, so everything under `{ token: { raw: … } }` is covered. The same reason
 * the walk is shape-agnostic applies here: a release that nests the value one
 * level deeper must not route it around the scrub.
 */
export function redactDeep(value: unknown, token?: string, key?: string): unknown {
  if (typeof value === "string") {
    if (key !== undefined && SENSITIVE_KEY_NAME.test(key) && value !== "") {
      return REDACTION_MARKER;
    }
    return redactCredentials(value, token);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactDeep(entry, token, key));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [
        childKey,
        redactDeep(child, token, SENSITIVE_KEY_NAME.test(childKey) ? childKey : key),
      ]),
    );
  }
  return value;
}
