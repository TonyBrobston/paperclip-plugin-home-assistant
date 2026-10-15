import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NAMESPACED_TOOL_NAMES, PLUGIN_ID, TOOL_NAMES } from "../src/constants.js";
import { TOOL_DECLARATIONS } from "../src/tools.js";

const README = readFileSync(
  fileURLToPath(new URL("../README.md", import.meta.url)),
  "utf8",
);

/**
 * The grant list is documentation that has to be copied by hand into a profile
 * rule, one line per tool, or the tool cannot be called at all. A tool added to
 * this plugin without being added to that list ships un-grantable and looks to
 * the operator like a broken tool rather than a missing rule — and the list is
 * not derived from anything at read time, so nothing but a test will catch the
 * omission.
 */
describe("README grant instructions", () => {
  it("lists every tool under its namespaced name", () => {
    expect(NAMESPACED_TOOL_NAMES).toHaveLength(TOOL_DECLARATIONS.length);
    for (const name of NAMESPACED_TOOL_NAMES) {
      expect(README).toContain(name);
    }
  });

  it("namespaces the names the way the host publishes them", () => {
    expect(NAMESPACED_TOOL_NAMES).toContain(`${PLUGIN_ID}:${TOOL_NAMES.getState}`);
  });

  it("points at the page that holds the only usable lever", () => {
    expect(README).toContain("/apps/advanced/profiles");
    expect(README).toMatch(/## Granting the tools to an agent/);
  });
});
