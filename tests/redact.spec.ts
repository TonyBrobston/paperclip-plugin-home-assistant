import { describe, expect, it } from "vitest";
import {
  redactCredentials,
  redactDeep,
  REDACTION_MARKER,
} from "../src/redact.js";

/** A JWT of the shape Home Assistant issues as a long-lived access token. */
const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJhYmMxMjMiLCJpYXQiOjE3MDAwMDAwMDB9.s1gnatureV4lue_abc123";

/** The token the plugin itself was configured with, as `executeTool` passes it. */
const CONFIGURED = `eyJhbGciOiJIUzI1NiJ9.cG9uZXMtYW5kLXVuaWNvcm5zLTEyMw.c0nf1gured-s1gnature`;

/**
 * Each rule gets its own case, because each one is a separate claim about what
 * Home Assistant puts in these two tools' output. A rule that silently stops
 * matching — a tightened character class, a reordered replacement — is a
 * credential back in an agent's context, and nothing else in this repo would
 * notice.
 */
describe("redactCredentials", () => {
  describe("the configured token", () => {
    it("removes the token wherever it appears, with no pattern involved", () => {
      const out = redactCredentials(
        `Request to /api/states failed with header Bearer ${CONFIGURED}`,
        CONFIGURED,
      );
      expect(out).not.toContain(CONFIGURED);
      expect(out).toContain(REDACTION_MARKER);
    });

    it("removes the percent-encoded token, as a logged URL carries it", () => {
      const token = "s3cret/token+value==";
      const out = redactCredentials(
        `GET https://ha.test/x?auth=${encodeURIComponent(token)}`,
        token,
      );
      expect(out).not.toContain(encodeURIComponent(token));
    });

    it("leaves a token too short to be a real one alone, rather than shredding the log", () => {
      // A three-character token is a substring of ordinary log text. Blanking
      // every occurrence would destroy the log to protect something that is
      // not a usable Home Assistant credential.
      const out = redactCredentials("Setup of the sensor platform failed", "set");
      expect(out).toBe("Setup of the sensor platform failed");
    });
  });

  describe("authorization headers", () => {
    it.each([
      ["a plain header", `Authorization: Bearer ${JWT}`],
      ["a logged header dict", `{'Authorization': 'Bearer ${JWT}', 'Accept': '*/*'}`],
      ["an equals form", `authorization = "Basic dXNlcjpwYXNzd29yZDEyMw=="`],
      ["Home Assistant's legacy header", "x-ha-access: abcd1234efgh5678"],
      ["a vendor header", "X-API-Key: 7f3a9b2c4d5e6f1a8b9c0d1e"],
    ])("redacts %s", (_label, line) => {
      const out = redactCredentials(line);
      expect(out).toContain(REDACTION_MARKER);
      expect(out).not.toMatch(/dXNlcjpwYXNzd29yZDEyMw|abcd1234efgh5678|7f3a9b2c4d5e6f1a8b9c0d1e/);
      expect(out).not.toContain(JWT);
    });

    it("keeps the scheme, which says what kind of credential failed", () => {
      expect(redactCredentials(`Authorization: Bearer ${JWT}`)).toBe(
        `Authorization: Bearer ${REDACTION_MARKER}`,
      );
    });
  });

  describe("credential query parameters", () => {
    it.each([
      ["api_password", "GET /api/states?api_password=letmein1 HTTP/1.1", "letmein1"],
      ["token", "https://ha.test/x?token=A1b2C3d4E5f6 failed", "A1b2C3d4E5f6"],
      [
        "access_token",
        "Error fetching https://api.test/v1?access_token=abc123def456&unit=c",
        "abc123def456",
      ],
      [
        "api_key",
        "rest: https://api.test/v1/sensors?api_key=A1b2C3d4E5f6G7h8 returned 401",
        "A1b2C3d4E5f6G7h8",
      ],
    ])("redacts ?%s=", (_label, line, secret) => {
      const out = redactCredentials(line);
      expect(out).not.toContain(secret);
      expect(out).toContain(REDACTION_MARKER);
    });

    it("stops at the parameter boundary, keeping the rest of the URL readable", () => {
      expect(
        redactCredentials("https://api.test/v1?access_token=abc123def456&unit=c"),
      ).toBe(`https://api.test/v1?access_token=${REDACTION_MARKER}&unit=c`);
    });

    it("leaves a parameter that names nothing sensitive", () => {
      const line = "https://api.test/v1/history?entity_id=light.kitchen&minimal=1";
      expect(redactCredentials(line)).toBe(line);
    });
  });

  /**
   * `generic` camera, `mjpeg`, `ffmpeg`, `rest` and `scrape` are all configured
   * with a URL that can carry basic-auth, and every one of them logs that URL
   * verbatim on a timeout or a non-200. The password is usually far too short
   * for the shape rules to reach, so the position after the colon is the only
   * thing naming it.
   */
  describe("credentials in URL userinfo", () => {
    it("redacts the password a failing camera request logs", () => {
      expect(
        redactCredentials(
          "2026-10-16 01:02:03 ERROR (MainThread) [homeassistant.components.generic.camera] Timeout getting camera image from http://admin:hunter2@192.168.1.64/Streaming/channels/101/picture",
        ),
      ).toBe(
        `2026-10-16 01:02:03 ERROR (MainThread) [homeassistant.components.generic.camera] Timeout getting camera image from http://admin:${REDACTION_MARKER}@192.168.1.64/Streaming/channels/101/picture`,
      );
    });

    it("keeps the user, which says which account failed", () => {
      expect(redactCredentials("rest: https://svc:s3cret@api.test/v1 returned 401")).toBe(
        `rest: https://svc:${REDACTION_MARKER}@api.test/v1 returned 401`,
      );
    });

    it("takes the whole password when it contains an unencoded @", () => {
      // Stopping at the first `@` would leave `ssw0rd123` in the log.
      const out = redactCredentials("Connecting to mqtt://user:p@ssw0rd123@broker.test:1883");
      expect(out).toBe(`Connecting to mqtt://user:${REDACTION_MARKER}@broker.test:1883`);
      expect(out).not.toContain("ssw0rd123");
    });

    it.each([
      ["a URL with no userinfo", "Timeout fetching hue data from http://10.0.0.5/api/lights"],
      ["a host:port with no userinfo", "Cannot connect to https://ha.test:8123/api/states"],
      // The value may not cross `?`, so an address in a query string is not
      // mistaken for a password followed by a host.
      ["an @ in a query string", "Redirecting to https://ha.test:8123?to=admin@example.test"],
    ])("leaves %s", (_label, line) => {
      expect(redactCredentials(line)).toBe(line);
    });
  });

  describe("credential assignments in echoed config", () => {
    it.each([
      ["a YAML key", "Setup failed for smtp: password: hunter2", "hunter2"],
      [
        "a quoted dict key",
        "config entry data: {'host': '10.0.0.5', 'token': 'A1b2C3d4E5f6G7h8'}",
        "A1b2C3d4E5f6G7h8",
      ],
      ["an equals form", "client_secret=9f8e7d6c5b4a", "9f8e7d6c5b4a"],
      ["a quoted value with spaces", `password: "p@ss w0rd here"`, "p@ss w0rd here"],
      // Standard-alphabet base64 is below the shape rule's reach, so the label
      // is what has to catch it.
      ["a cookie header", "GET /x failed, cookie=ab+cd/ef+gh/ij=", "ab+cd/ef+gh/ij="],
    ])("redacts %s", (_label, line, secret) => {
      const out = redactCredentials(line);
      expect(out).not.toContain(secret);
      expect(out).toContain(REDACTION_MARKER);
    });

    it("keeps the key, so the error still says which setting is wrong", () => {
      expect(redactCredentials("password: hunter2")).toBe(
        `password: ${REDACTION_MARKER}`,
      );
    });
  });

  describe("check_config validation errors", () => {
    // Home Assistant expands `!secret` before validating, so the value
    // voluptuous quotes back is the secret itself.
    it("redacts the offending value for a credential key", () => {
      const out = redactCredentials(
        "Invalid config for [notify.smtp]: not a valid value for dictionary value @ data['password']. Got 'hunter2-correct-horse'",
      );
      expect(out).not.toContain("hunter2-correct-horse");
      expect(out).toContain("data['password']");
      expect(out).toContain(REDACTION_MARKER);
    });

    it("redacts a nested credential key", () => {
      const out = redactCredentials(
        "data['notify']['api_key'] value is invalid. Got 'A1b2C3d4E5f6'",
      );
      expect(out).not.toContain("A1b2C3d4E5f6");
    });

    it("leaves `Got None`, which only says the key was missing", () => {
      const line =
        "Invalid config for [sensor.rest]: expected str for dictionary value @ data['api_key']. Got None";
      expect(redactCredentials(line)).toBe(line);
    });

    it("leaves the offending value for a key that is not a credential", () => {
      const line =
        "Invalid config for [light.template]: expected int for dictionary value @ data['brightness']. Got 'bright'";
      expect(redactCredentials(line)).toBe(line);
    });
  });

  describe("credential shapes with no label", () => {
    it("redacts a bare JWT", () => {
      const out = redactCredentials(`Websocket auth failed for ${JWT}`);
      expect(out).toBe(`Websocket auth failed for ${REDACTION_MARKER}`);
    });

    it("redacts a long opaque token", () => {
      const out = redactCredentials(
        "Supervisor rejected 9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a3928",
      );
      expect(out).toBe(`Supervisor rejected ${REDACTION_MARKER}`);
    });

    it.each([
      ["a long run with no digits", "homeassistant_components_sensor_platform_setup_failed"],
      ["a run below the length floor", "A1b2C3d4E5f6G7h8I9j0"],
    ])("leaves %s, which is not credential-shaped", (_label, text) => {
      expect(redactCredentials(`Saw ${text} here`)).toBe(`Saw ${text} here`);
    });

    /**
     * Underscore is inside the token class, so an auto-generated entity ID that
     * is long enough and carries a digit is over-redacted. This is the chosen
     * trade, not an oversight: a discriminator loose enough to spare entity IDs
     * is a way around the backstop. Pinned here so changing it is a decision.
     */
    it("over-redacts a long auto-generated entity ID, by design", () => {
      expect(
        redactCredentials(
          "Unable to find entity sensor.basement_dehumidifier_power_1234567890_energy",
        ),
      ).toBe(`Unable to find entity sensor.${REDACTION_MARKER}`);
    });
  });

  /**
   * The cost of a scrub is the log it mangles. These are lines a real error log
   * is full of, and a rule that starts eating them has stopped being worth its
   * keep — the point of `get_error_log` is to diagnose something.
   */
  describe("ordinary log text", () => {
    it.each([
      "2026-10-16 01:02:03 WARNING (MainThread) [homeassistant.components.sensor] Updating sensor.outdoor_temperature took longer than the scheduled update interval 0:00:30",
      "2026-10-16 01:02:04 ERROR (MainThread) [homeassistant.config_entries] Error setting up entry Kitchen for hue",
      "Unable to find entity light.kitchen_ceiling_downlight_group",
      "Error doing job: Task exception was never retrieved (None)",
      "Timeout fetching hue data from http://10.0.0.5/api/lights",
      "Platform template does not generate unique IDs. ID sensor_1 is already used",
      // `auth` is a real domain, so this preamble is a line check_config
      // genuinely emits. Allowing a bracketed key to open an assignment ate
      // `expected` — the word saying what was actually wrong.
      "Invalid config for [auth]: expected a dictionary. Got None",
      "Invalid config for [secret]: required key not provided @ data['host']",
    ])("passes through %s", (line) => {
      expect(redactCredentials(line, CONFIGURED)).toBe(line);
    });
  });

  it("is idempotent, so a scrubbed string survives a second pass unchanged", () => {
    const text = [
      `Authorization: Bearer ${JWT}`,
      "https://api.test/v1?api_key=A1b2C3d4E5f6G7h8&unit=c",
      "password: hunter2",
      "data['password']. Got 'hunter2'",
    ].join("\n");
    const once = redactCredentials(text, CONFIGURED);
    expect(redactCredentials(once, CONFIGURED)).toBe(once);
    // A doubled rule used to leave the marker's closing bracket as stray text.
    expect(once).not.toContain(`${REDACTION_MARKER}]`);
  });

  it("marks what it removed rather than dropping it", () => {
    expect(redactCredentials("password: hunter2")).toContain(REDACTION_MARKER);
    expect(REDACTION_MARKER).not.toBe("");
  });
});

describe("redactDeep", () => {
  it("scrubs strings wherever they sit in the result", () => {
    const out = redactDeep(
      {
        result: "invalid",
        errors:
          "Invalid config for [notify.smtp]: not a valid value for dictionary value @ data['password']. Got 'hunter2'",
        warnings: ["rest: https://api.test?api_key=A1b2C3d4E5f6G7h8 failed"],
      },
      undefined,
    ) as { result: string; errors: string; warnings: string[] };
    expect(out.result).toBe("invalid");
    expect(out.errors).not.toContain("hunter2");
    expect(out.warnings[0]).not.toContain("A1b2C3d4E5f6G7h8");
  });

  it("removes a value under a credential-named key without needing a pattern", () => {
    const out = redactDeep({ detail: { password: "ok" } }) as {
      detail: { password: string };
    };
    // "ok" is not credential-shaped; the key is what makes it a credential.
    expect(out.detail.password).toBe(REDACTION_MARKER);
  });

  it("keeps the keys, which say what the error is about", () => {
    const out = redactDeep({ password: "ok" }) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(["password"]);
  });

  it("leaves non-strings and the shape alone", () => {
    expect(redactDeep({ result: null, count: 2, ok: false, list: [] })).toEqual({
      result: null,
      count: 2,
      ok: false,
      list: [],
    });
  });

  it("reaches a value nested under a credential-named key", () => {
    // The walk is shape-agnostic because the error field moves between
    // releases, so one level of nesting must not route a value around it.
    const out = redactDeep({ token: { raw: "letmein" } }) as {
      token: { raw: string };
    };
    expect(out.token.raw).toBe(REDACTION_MARKER);
  });

  it("scrubs every element of a list under a credential-named key", () => {
    const out = redactDeep({ tokens: ["a1", "b2"] }) as { tokens: string[] };
    expect(out.tokens).toEqual([REDACTION_MARKER, REDACTION_MARKER]);
  });
});
