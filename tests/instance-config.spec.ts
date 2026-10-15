/**
 * The host validates `configJson` against `instanceConfigSchema` with Ajv
 * before it will save a settings form, and it reports a failure as
 * "Configuration does not match the plugin's instanceConfigSchema" with no
 * mention of which value or which rule. So a schema that is stricter than the
 * worker does not produce a correction, it produces an operator who believes
 * the plugin is broken.
 *
 * These tests drive the real manifest schema through the same validator the
 * server builds — Ajv with formats and the host's permissive `secret-ref`
 * format — so the accepted set is asserted against the thing that actually
 * gates the save, not against a regex copied out of the manifest.
 */
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { pluginManifestV1Schema } from "@paperclipai/shared";
import { describe, expect, it } from "vitest";
import manifest from "../src/manifest.js";
import { homeAssistantApiUrl } from "../src/home-assistant.js";

/**
 * The shape the host's settings form actually submits for a `secret-ref`
 * field: `SecretRefField` in `JsonSchemaForm.tsx` emits this object when a
 * secret is chosen from the dropdown.
 */
const TOKEN_REF = {
  type: "secret_ref",
  secretId: "11111111-1111-4111-8111-111111111111",
  version: "latest",
};

/**
 * Mirrors `validateInstanceConfig` in the host's plugin-config-validator,
 * including its interop dance: under ESM both packages expose the real export
 * on `.default`, which is why the host reaches for it the same way.
 */
function validateConfig(config: Record<string, unknown>): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const AjvCtor = (Ajv as any).default ?? Ajv;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const applyFormats = (addFormats as any).default ?? addFormats;
  const ajv = new AjvCtor({ allErrors: true });
  applyFormats(ajv);
  // A UI hint on the host side; it never rejects a value.
  ajv.addFormat("secret-ref", { validate: () => true });
  const validate = ajv.compile(manifest.instanceConfigSchema!);
  return validate(config) as boolean;
}

function validateBaseUrl(baseUrl: string): boolean {
  return validateConfig({ baseUrl, token: TOKEN_REF });
}

describe("instance config schema", () => {
  /**
   * The host parses the manifest with this schema before it will install or
   * activate the plugin, so a manifest edit that violates it does not produce
   * a failing tool — it produces a plugin that will not load at all. Asserted
   * against the published `@paperclipai/shared`, not a local copy of it.
   */
  it("keeps the manifest valid against the host's published schema", () => {
    const result = pluginManifestV1Schema.safeParse(manifest);
    expect(result.error?.issues ?? []).toEqual([]);
    expect(result.success).toBe(true);
  });

  it.each([
    ["a local hostname with a port", "http://homeassistant.local:8123"],
    ["an address pasted with the browser's trailing slash", "http://homeassistant.local:8123/"],
    ["a doubled trailing slash", "http://homeassistant.local:8123//"],
    ["an IPv4 address", "http://10.0.0.2:8123"],
    ["a bracketed IPv6 address", "http://[::1]:8123"],
    ["a public hostname over TLS", "https://ha.example.com"],
    ["a public hostname over TLS with a trailing slash", "https://ha.example.com/"],
  ])("accepts %s", (_label, baseUrl) => {
    expect(validateBaseUrl(baseUrl)).toBe(true);
  });

  it.each([
    ["no scheme", "homeassistant.local:8123"],
    ["a non-HTTP scheme", "ws://homeassistant.local:8123"],
    ["embedded credentials", "http://user:pass@homeassistant.local:8123"],
    ["a path", "http://homeassistant.local:8123/lovelace"],
    ["a query string", "http://homeassistant.local:8123?api=1"],
    ["a fragment", "http://homeassistant.local:8123#frag"],
    ["whitespace", "http://homeassistant.local:8123 "],
    ["an empty string", ""],
  ])("rejects %s", (_label, baseUrl) => {
    expect(validateBaseUrl(baseUrl)).toBe(false);
  });

  it("requires both the address and the token", () => {
    expect(validateConfig({ baseUrl: "http://homeassistant.local:8123" })).toBe(false);
    expect(validateConfig({ token: TOKEN_REF })).toBe(false);
  });

  /**
   * The token field is the one the operator cannot work around: there is no
   * way to put a different shape in it, because the picker produces this one.
   * A schema that rejects it blocks the save outright, which is how this
   * plugin shipped.
   */
  describe("token field", () => {
    const withToken = (token: unknown) =>
      validateConfig({ baseUrl: "http://homeassistant.local:8123", token });

    it("accepts the binding object the secret picker submits", () => {
      expect(withToken(TOKEN_REF)).toBe(true);
    });

    it("accepts a binding with no explicit version", () => {
      expect(withToken({ type: "secret_ref", secretId: TOKEN_REF.secretId })).toBe(true);
    });

    /**
     * The host's `parseSecretRefBindingObject` accepts "latest" or a positive
     * integer, so a pinned secret version reaches this schema as a number.
     */
    it("accepts a binding pinned to a numbered version", () => {
      expect(withToken({ type: "secret_ref", secretId: TOKEN_REF.secretId, version: 3 })).toBe(true);
    });

    /**
     * The picker also allows typing a value straight into the field. Saving
     * that would persist the token as plaintext in plugin config — and the
     * worker requires a binding, so every tool call would fail afterwards
     * anyway. Refusing the save is the honest outcome.
     */
    it("refuses a raw pasted token rather than storing it as text", () => {
      expect(withToken("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.not-a-real-token")).toBe(false);
    });

    it.each([
      ["a different binding kind", { type: "user_secret_ref", secretId: TOKEN_REF.secretId }],
      ["a binding with no secret id", { type: "secret_ref" }],
      ["a binding with an empty secret id", { type: "secret_ref", secretId: "" }],
      ["an empty object", {}],
      ["null", null],
    ])("rejects %s", (_label, token) => {
      expect(withToken(token)).toBe(false);
    });
  });

  /**
   * The schema and the URL builder are separate guards on the same value, and
   * the builder is the one that runs on stored config that may predate the
   * field. Every address the form accepts has to survive it, or the save
   * succeeds and every tool call then fails.
   */
  it("accepts only addresses the request builder can use", () => {
    for (const baseUrl of [
      "http://homeassistant.local:8123",
      "http://homeassistant.local:8123/",
      "http://homeassistant.local:8123//",
      "https://ha.example.com/",
    ]) {
      expect(validateBaseUrl(baseUrl)).toBe(true);
      expect(homeAssistantApiUrl(baseUrl, "/api/").toString()).toBe(
        `${baseUrl.replace(/\/+$/, "")}/api/`,
      );
    }
  });
});
