/**
 * End-to-end smoke test for the built plugin.
 *
 * Forks dist/worker.js the way the Paperclip host does (stdio pipes, NDJSON
 * JSON-RPC), plays the host side of the protocol — answering the worker's
 * config.get and secrets.resolve calls — and drives a real tool call against a
 * stub Home Assistant listening on 127.0.0.1.
 *
 * The loopback address is deliberate: it is exactly the kind of address the
 * host's gated plugin fetch helper refuses, so a pass here demonstrates the
 * worker reaching a private endpoint through the runtime's own fetch.
 */
import { fork } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the package root from this file, so the script runs from anywhere.
const PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TOKEN = "llat-smoke-token";

const seenAuth = [];
const seenPaths = [];

const ha = createServer((req, res) => {
  seenAuth.push(req.headers.authorization ?? "(none)");
  seenPaths.push(req.url);
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    res.writeHead(401).end("unauthorized");
    return;
  }
  if (req.url === "/api/states") {
    res.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify([
        {
          entity_id: "light.kitchen",
          state: "on",
          attributes: { friendly_name: "Kitchen", device_class: "light" },
          last_changed: "2026-10-14T12:00:00Z",
        },
        {
          entity_id: "sensor.outdoor_temperature",
          state: "7.4",
          attributes: { friendly_name: "Outdoor", unit_of_measurement: "°C" },
          last_changed: "2026-10-14T12:01:00Z",
        },
      ]),
    );
    return;
  }
  res.writeHead(404).end("not found");
});

await new Promise((resolve) => ha.listen(0, "127.0.0.1", resolve));
const baseUrl = `http://127.0.0.1:${ha.address().port}`;

const manifest = (await import(`${PLUGIN_DIR}/dist/manifest.js`)).default;

const child = fork(`${PLUGIN_DIR}/dist/worker.js`, [], {
  stdio: ["pipe", "pipe", "pipe", "ipc"],
  env: { PATH: process.env.PATH, NODE_ENV: "production", TZ: "UTC" },
});

const pending = new Map();
let nextId = 1;

function send(method, params) {
  const id = nextId++;
  const promise = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 20000);
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return promise;
}

function reply(id, result) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

const hostCalls = [];

createInterface({ input: child.stdout }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    console.log("  [worker stdout non-JSON]", line.slice(0, 160));
    return;
  }

  // A response to something we sent.
  if (msg.id !== undefined && msg.method === undefined) {
    const waiter = pending.get(msg.id);
    if (waiter) {
      pending.delete(msg.id);
      msg.error ? waiter.reject(new Error(JSON.stringify(msg.error))) : waiter.resolve(msg.result);
    }
    return;
  }

  // An outbound host call from the worker — we are the host.
  if (msg.method) {
    hostCalls.push(msg.method);
    if (msg.method === "config.get") {
      reply(msg.id, { baseUrl, token: { type: "secret_ref", secretId: "secret-smoke" } });
    } else if (msg.method === "secrets.resolve") {
      reply(msg.id, TOKEN);
    } else if (msg.id !== undefined) {
      reply(msg.id, null);
    }
  }
});

createInterface({ input: child.stderr }).on("line", (l) =>
  console.log("  [worker stderr]", l.slice(0, 200)),
);

const fail = (msg) => {
  console.log(`\nFAIL: ${msg}`);
  child.kill();
  ha.close();
  process.exit(1);
};

try {
  await send("initialize", {
    manifest,
    config: {},
    instanceInfo: { instanceId: "00000000-0000-0000-0000-000000000000", hostVersion: "0.0.0-smoke" },
    apiVersion: 1,
  });
  console.log("initialize: ok");

  const health = await send("health", {});
  console.log("health:", JSON.stringify(health));

  const result = await send("executeTool", {
    toolName: "list_entities",
    parameters: { search: "kitchen" },
    runContext: {
      agentId: "agent-smoke",
      runId: "run-smoke",
      companyId: "company-smoke",
      projectId: "project-smoke",
    },
  });

  if (result?.error) fail(`tool returned an error: ${result.error}`);

  const data = result?.data;
  console.log("executeTool(list_entities, search=kitchen):");
  console.log(`  totalMatched=${data?.totalMatched} returned=${data?.returned} truncated=${data?.truncated}`);
  console.log(`  entity=${JSON.stringify(data?.entities?.[0])}`);

  if (data?.totalMatched !== 1) fail(`expected 1 match, got ${data?.totalMatched}`);
  if (data?.entities?.[0]?.entityId !== "light.kitchen") fail("wrong entity returned");

  console.log("host calls made by worker:", [...new Set(hostCalls)].join(", "));
  console.log("stub HA saw path:", seenPaths.join(", "));
  console.log("stub HA saw auth:", seenAuth[0] === `Bearer ${TOKEN}` ? "Bearer <resolved secret>" : seenAuth[0]);

  if (!hostCalls.includes("secrets.resolve")) fail("worker never resolved the secret ref");
  if (seenAuth[0] !== `Bearer ${TOKEN}`) fail("token did not arrive as a bearer header");

  // A provider-side failure should reach the agent as a fixable message rather
  // than as a crashed tool call. The stub 404s on any path but /api/states.
  const missing = await send("executeTool", {
    toolName: "get_state",
    parameters: { entityId: "light.missing" },
    runContext: {
      agentId: "agent-smoke",
      runId: "run-smoke",
      companyId: "company-smoke",
      projectId: "project-smoke",
    },
  });
  console.log("executeTool(get_state, unknown entity) ->", JSON.stringify(missing?.error));
  if (!/no such entity or endpoint/.test(missing?.error ?? "")) {
    fail("a 404 should surface as a fixable tool error");
  }

  console.log("\nPASS: forked worker spoke the protocol, resolved its secret, and read a loopback Home Assistant stub.");
} catch (error) {
  fail(error.message);
}

child.kill();
ha.close();
process.exit(0);
