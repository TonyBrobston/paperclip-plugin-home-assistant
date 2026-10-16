# paperclip-plugin-home-assistant

Read-only Home Assistant access for [Paperclip](https://github.com/paperclipai/paperclip)
agents. It exists so an agent can look things up in Home Assistant directly —
entity IDs, live state, available services, template output, history — instead
of asking a human to go and paste them.

Nine tools, all reads:

| Tool | What it answers |
| --- | --- |
| `list_entities` | What entities exist, with current state. Filter by domain or search term. |
| `get_state` | One entity's full state object and every attribute. |
| `list_services` | What services exist; pass a domain for the fields each accepts. |
| `render_template` | What a Jinja2 template evaluates to against live state. |
| `get_config` | Version, time zone, unit system, loaded components. |
| `check_config` | Whether the current configuration validates. Credentials scrubbed. |
| `get_history` | How an entity actually behaved over a time window. |
| `get_logbook` | What happened, in human-readable form, and what triggered it. |
| `get_error_log` | The tail of the error log. Credentials scrubbed. |

There is no tool that changes anything. That is a deliberate design decision
with a specific cause — see [Why this plugin is read-only](#why-this-plugin-is-read-only).

Two of those tools return text Home Assistant composed rather than fields this
plugin chose, and that text routinely carries the operator's credentials. Both
are scrubbed before an agent sees them — see [Why two tools are
scrubbed](#why-two-tools-are-scrubbed).

## Install

The plugin ships pre-built. `dist/` is committed and the bundler inlines the
SDK, so the installed copy needs no `node_modules` and no build step on the
host.

```bash
# 1. Put the package somewhere the Paperclip server can read. On a container
#    deployment this must be a path inside the container — a persistent volume
#    is the useful choice, because the plugin then survives an image rebuild.
git clone https://github.com/TonyBrobston/paperclip-plugin-home-assistant.git

# 2. Install it by absolute path.
paperclipai plugin install /absolute/path/to/paperclip-plugin-home-assistant

# 3. Confirm it loaded.
paperclipai plugin list
paperclipai plugin inspect tbro.home-assistant
```

Installing, configuring and enabling it is **not** enough to make the tools
callable — a loaded, healthy, enabled plugin is still denied to every agent
until someone writes a tool profile for it. That step is
[Granting the tools to an agent](#granting-the-tools-to-an-agent), and skipping
it is the single most likely reason an agent tells you these tools do not work.

If the CLI is not in your image, the route the CLI calls is
`POST /api/plugins/install` with `{"packageName": "<absolute path>",
"isLocalPath": true}`, instance-admin only.

**Settings → Plugins cannot do this on `2026.1012.0`.** Its install dialog sends
`{ packageName }` and never sets `isLocalPath`, so a directory typed into it is
handed to `npm install` and fails — on a missing `package.json` if the directory
is empty, and otherwise on `Package directory not found after installation`,
because the loader joins the absolute path into `node_modules`. Neither error
names the missing flag. Use the CLI or the route above until your host carries
the fix.

Two install-time constraints are worth knowing before you try:

- **Cloud-managed instances will refuse this.** A managed instance rejects npm
  installs outright and accepts a local path only from inside its own bundled
  plugin catalog. Self-hosted instances have neither restriction.
- **The plugin id has to stay out of the distribution namespace.** The host runs
  every activation through a distribution-catalog guard. An id that matches a
  bundled plugin key, or a package inside the image's own plugin root, is
  rejected with "Distribution plugin is absent or not selected in this
  deployment". `tbro.home-assistant` is neither, so the guard passes it through
  — which is why the id is namespaced the way it is. Do not rename it to
  anything under `paperclip.`.

### Where the install lives, and how to upgrade

A local-path install is **referenced in place, not copied**. The host records
the directory you named as the plugin's package path and reads the package from
there on every activation. Practical consequences:

- Where you clone it is where it lives, permanently. On a container deployment
  put it on a bind-mounted volume; the plugin then survives an image rebuild,
  which a connector compiled into the bundle cannot.
- It survives a container restart with no reinstall. On boot the host loads the
  plugins its registry has marked ready and resolves each one's recorded path.
- Deleting or moving the directory does not uninstall it — it fails activation
  and the row lands in `error`. Restoring the directory and restarting is
  enough, because the host retries errored plugins once per boot.

Upgrading is `git pull` in that directory, plus a restart if the manifest moved:

- **Code-only change** (handler logic in `src/`, rebuilt into `dist/`) takes
  effect on its own. The host watches the installed package path and restarts
  the worker when its files change — but only for a plugin whose record carries
  that path, which means a local-path install. See the note below.
- **Manifest change** — a new tool, a new config field, a version bump — needs
  an activation, so restart the container or run `paperclipai plugin upgrade`
  (`POST /api/plugins/{id}/upgrade`). Activation re-reads the manifest from the
  package and persists it, so there is nothing to reinstall.
- **Never change the manifest id.** Activation throws if the package's id stops
  matching the installed plugin key.

#### If you installed it by package name instead of by path

There is a second way this package can end up installed, and it behaves
differently. The host runs `npm install <name> --prefix <plugin root> --save`,
so if that prefix's `package.json` already carries a `file:` dependency on this
package — which a previous local-path attempt leaves behind — npm resolves the
bare name to that link rather than to the registry. The install succeeds and
loads your clone through the symlink. This package is not published to npm, so
that is the only way a bare name can resolve at all.

What you get is a working install with three differences:

- The record's source is npm, and the host only persists `packagePath` for a
  local-filesystem source. So there is **no dev watcher**: a `git pull` changes
  the files and nothing restarts the worker. Restart the container, or call
  `POST /api/plugins/{id}/upgrade`, which repeats the same resolution and
  re-reads the clone.
- It still survives a restart. Boot discovery scans the plugin root's
  `node_modules` for packages matching the `paperclip-plugin-*` naming
  convention and follows the symlink, so the clone is found without a recorded
  path.
- It depends on that `file:` entry staying in the prefix's `package.json`. If
  anything rewrites the file without it, the next install or upgrade of the name
  goes to the public registry and fails.

Reinstalling by absolute path replaces the record with a local-filesystem one
and restores the watcher on the next boot.

Then configure it in **Settings → Plugins → Home Assistant (read-only)**. The
host generates that form from the manifest's `instanceConfigSchema`:

- **Home Assistant address** — what you open Home Assistant at, scheme and port
  included and nothing else, e.g. `http://homeassistant.local:8123`. No path,
  query string or credentials; a trailing slash is accepted and stripped.
  `http` is accepted because the ordinary deployment is a local address with no
  certificate. See [Which address to use](#which-address-to-use).
- **Long-lived access token** — create one in Home Assistant under your profile,
  at the bottom of the Security tab, save it as a Paperclip secret, and pick it
  from the dropdown. The token is stored as a secret reference and resolved at
  call time; it is never written into plugin config as text. The field also lets
  you type a value directly — the schema refuses that, because saving it would
  persist the token as plaintext, and the worker requires a reference anyway.

**A long-lived access token inherits every permission of the account that
issued it.** Home Assistant cannot scope one to specific entities, domains, or
to read-only. This plugin is read-only because of what it does and does not
implement, not because the token is restricted — so issue the token from an
account with only the access you are willing to expose.

### Which address to use

If Home Assistant is reachable at more than one address, the choice is not
cosmetic.

**Do not use a hostname published through an identity-aware proxy** —
Cloudflare Access, Authelia, an OIDC-authenticating reverse proxy. The proxy
authenticates the *browser*, through a session cookie it sets after an
interactive login. It does not know what a Home Assistant bearer token is. An
API request arriving with one is answered by the proxy with a redirect to its
own login page, so the request never reaches Home Assistant, and every tool
fails in a way that looks like a rejected token. Two ways to tell before you
commit to an address: a `GET <address>/api/` that returns a `30x` to a login
host, or a `www-authenticate` header naming the proxy. Home Assistant answering
for itself returns `401` with the body `401: Unauthorized`.

Making such a hostname work would need either credentials the proxy understands
(Cloudflare Access service tokens, for instance, which this plugin does not
send) or a bypass rule on `/api/*` — and a bypass puts the Home Assistant API
on the public internet behind nothing but the long-lived token. Prefer an
address that does not leave the host.

**Prefer the most local address that works**, in this order: a container alias
or service name if Paperclip and Home Assistant share a Docker network; the
host's own address if they do not. A Home Assistant container running with
`network_mode: host` is not in any user-defined network's DNS, so its compose
service name will not resolve from another container — that one is not a
misconfiguration you can fix with a port.

**`http` to a host-local address is the normal case, not a compromise.** Home
Assistant serves plain HTTP on `8123` unless you give it `ssl_certificate`, so
on most deployments there is no HTTPS port to point at; the TLS such a setup
has belongs to the proxy and is terminated at the edge. When the address
resolves to the machine Paperclip is running on, the token crosses one hop
inside that machine rather than the network. If the two are on *different*
machines, that stops being true — put TLS in front of Home Assistant, or accept
that a long-lived token with full account permissions is crossing your LAN in
cleartext.

### Verifying the configuration

The settings page's **Test Connection** button validates the *shape* of what you
entered — that the address parses and that a secret reference is selected. It
cannot contact Home Assistant: the host calls `validateConfig` without a
company ID, and resolving the token reference requires one. The plugin says so
in its own result rather than reporting a green "connected" it never tested.

To confirm the instance is actually reachable and the token is accepted, ask an
agent to run `get_config`. If the agent reports that the tools do not exist, or
that the call was denied, the plugin is fine and the grant below is missing.

## Granting the tools to an agent

**Installing, configuring and enabling the plugin does not let a single agent
call a single tool.** The plugin will show `ready` with green health, the worker
will be running, the nine tools will be registered — and every call is denied,
because Paperclip denies any tool call that no tool profile, grant or allow
policy permits, and plugin activation creates none of the three. Nothing warns
you. The agent sees a bare default deny that does not mention plugins, and an
agent that was never given the tools usually reports them as simply absent.

Verified against Paperclip `2026.1012.0`. The fix is one profile, written by
hand.

**Connectors → Profiles**, at `/apps/advanced/profiles` — in the page's own
**Developer** sidebar group, under Connections and Gateways. It needs
`tools:admin`, so an agent cannot do this for you.

1. **New profile**, name it for the agents it serves, e.g.
   `Home Assistant plugin tools`.
2. In **Choose tools**, tick nothing in the app list — the picker is built from
   per-connection tool catalogs, and a plugin tool has no connection, so these
   nine will not be in it. Expand **Advanced rules** and add one rule per tool:
   effect **Allow**, kind **tool name**, value one of

   ```
   tbro.home-assistant:list_entities
   tbro.home-assistant:get_state
   tbro.home-assistant:list_services
   tbro.home-assistant:render_template
   tbro.home-assistant:get_config
   tbro.home-assistant:check_config
   tbro.home-assistant:get_history
   tbro.home-assistant:get_logbook
   tbro.home-assistant:get_error_log
   ```

   Leave **New tools** on *Deny*.
3. **Assign** it to the agents that should have Home Assistant access, and only
   those.

**You write those rules once per instance, not once per agent.** A profile is a
reusable object: it is bound to a target, and the same profile can carry as many
bindings as you like — `agent`, `company`, `project`, `issue`, `routine` or
`gateway`. So the second agent that needs Home Assistant is one binding, not
nine rules again, and a `company` binding makes the set a default that every
agent inherits. Prefer per-agent bindings if only some agents should be able to
read the house.

Three things about that screen are worth knowing before you use it:

- **The tool-name field is matched literally, despite the label.** It is called
  a pattern and placeholdered with a glob, and the server compares it to the
  tool name with string equality. `tbro.home-assistant:*` saves cleanly, shows
  up as a rule, and grants nothing. It has to be the nine exact names.
- **Only two of the five rule kinds can ever match a plugin tool.** The others
  select on connection, application or catalog entry, and a plugin tool call
  carries `null` for all three. So it is a tool-name rule or a risk-level rule;
  nothing else will work however correctly you fill it in.
- **A single Allow / risk level / read-only rule also grants the set**, since
  all nine tools infer as reads. It is one rule instead of nine, and it is
  looser — that profile then permits any read tool, including ones added later.

Profiles are additive: the decision walks each profile that applies and allows
on the first that permits, so a new narrow profile cannot disturb tools an agent
already has. Do not grant these by flipping an existing profile's **New tools**
to *Allow* — that sets the profile's default action to allow and grants
everything, permanently, including tools that do not exist yet.

## Why this plugin is read-only

Paperclip governs tool calls by risk class: `read`, `write`, `destructive`, with
per-action Allowed / Ask-first / Off policy. A plugin tool cannot participate in
that properly, for two independent reasons in the host as of Paperclip
`2026.1012.0`:

1. **A plugin cannot declare its risk class.** The manifest tool declaration is
   `{name, displayName, description, parametersSchema}` and the host's internal
   tool descriptor has no risk field either. The gateway spreads the tool and
   then overwrites risk with `inferToolRisk(tool.name)`, a regex over the tool's
   *name*. A Home Assistant `call_service` tool matches no keyword and so is
   classified **`read`** — no Ask-first, no destructive handling, on the one
   action that can unlock a lock.
2. **Ask-first would not work even if set manually.** When a human approves a
   gated call, the host runs it through `executeApprovedAgentInvocation`, and
   for a plugin tool that path throws `approved_execution_unsupported`
   ("Plugin actions cannot execute outside their originating run") — and the
   caller swallows the error. The approval would appear to succeed and the
   action would not run.

So a write on the plugin path is either ungoverned or broken. Reads are neither:
`read` is the correct class for every tool here, so the name inference lands on
the right answer and the policy screen means what it says.

If you want governed device control, that belongs in a curated catalog
connector, where the risk class is declared and reviewed and approvals execute.

## Why two tools are scrubbed

`get_error_log` and `check_config` return text Home Assistant wrote. Every other
tool returns fields this plugin picked out of a documented JSON shape. That
difference is the whole problem: provider-composed text carries whatever the
provider happened to put in it, and on these two endpoints that routinely
includes the operator's credentials.

- An integration that fails a request logs the request. A URL built from a
  configured API key carries the key in its query string, and several
  integrations log the request headers too, `Authorization` included.
- `check_config` validates the configuration **after** `!secret` substitution.
  So when voluptuous quotes the offending value back — `not a valid value for
  dictionary value @ data['password']. Got '…'` — the quoted value is the
  expanded secret, not the `!secret` reference the operator wrote.

There is no approval gate to fall back on. A plugin's manifest tool declaration
is `{name, displayName, description, parametersSchema}`: no risk level, no
ask-first field (see [Why this plugin is
read-only](#why-this-plugin-is-read-only)), so an operator cannot make these two
tools prompt. Any agent the plugin's tools are granted to calls them freely.
Scrubbing in the plugin is the only control that exists.

`src/redact.ts` runs two kinds of rule, and the difference matters when reading
a redacted log:

- **Context rules** key off a credential-naming word in the text itself —
  `authorization:` and friends, `?api_password=` / `?token=` / `?access_token=`
  / `?api_key=`, `password: …` assignments, and the bracketed key in a
  voluptuous error. These are precise, and they keep the key and the auth scheme
  so the error still says what failed.
- **Shape rules** key off the value alone: a JWT (the shape of a Home Assistant
  long-lived token), and any run of 40+ opaque token characters mixing letters
  and digits. These are the backstop for a credential nobody named, and they
  over-redact on purpose — a long opaque blob is rarely the diagnostic part of a
  log line.

The configured token itself is matched literally, raw and percent-encoded, and
first: it is the one secret whose exact value the plugin knows, so it never
depends on a pattern recognising it.

Every removal leaves `[redacted-credential]` behind — nothing is dropped
silently, so a reader can tell "Home Assistant said nothing here" from "the
plugin took something out". `get_error_log` also returns `redacted: true` when
the tail it hands back still carries a marker. The log is scrubbed **before**
the tail is cut, not after: slicing first would offer the patterns half a
credential to match.

For `check_config` the whole parsed response is walked, whatever its shape,
because the field the errors live in has moved between Home Assistant releases.
A string sitting under a credential-named key is removed on the strength of the
key alone; the keys themselves are kept, since `password` as a key name is not a
secret and blanking it would hide which setting the error is about.

**What this does not do.** Pattern matching cannot recognise a secret that looks
like ordinary prose, so this reduces exposure, it does not eliminate it. Two
known gaps: a credential logged with no label and no credential-like shape
survives, and the scrub is not applied to the structured tools — a camera
entity's `access_token` attribute still reaches an agent through `get_state` or
`list_entities`. Extending `redactDeep` to those is a one-line change if you
want it; it is left off because those tools' output is values an agent is
expected to read exactly.

## Why every result is an object

Every tool returns a JSON **object**, and three of them wrap an array to do it.
That is a compatibility contract with the transport, not a formatting
preference.

The host forwards a tool result's `data` as MCP `structuredContent`, and an
agent's MCP client validates that field as a record. The forwarding is
unconditional — `structuredContent: result.data ?? null` — so three shapes fail
validation and make the client discard the **entire** result, text content
included, before the agent reads any of it:

- a top-level array, which is what `/api/history/period`, `/api/logbook` and
  `/api/services` hand back verbatim;
- a scalar or `null`;
- an absent `data`, which the host forwards as an explicit `null`.

So `get_history` returns `{ entityId, start, end, minimalResponse,
totalMatched, returned, truncated, changes }`, `get_logbook` returns
`{ entityId, start, end, totalMatched, returned, truncated, entries }`, and
`list_services` returns `{ domain, detail, returned, domains }`. `get_history`
also flattens Home Assistant's per-entity series, since the tool requires one
entity and therefore gets at most one series.

The same rule governs the failure path. A result carrying only `error` travels
in neither forwarded field, so `toolError` sets `content` and `data` alongside
it — otherwise this plugin's specific messages ("could not be reached at the
configured address", "rejected the long-lived access token", "has no such
entity or endpoint") are written but unreachable, and every distinct failure
reads to the agent as one identical schema error. It also logs a warning, so a
failure is visible on the plugin health page even when an agent's transport
drops it.

`worker.ts` keeps a `structured()` backstop at the one place the host reads, and
both the unit suite and `scripts/smoke.mjs` carry a copy of the host's
forwarding rule, so a future tool cannot reintroduce the fault quietly.

## Why every result is also small

A result the agent cannot read is as lost as one the client discards, and the
second ceiling is far lower than the first. Measured against a real
installation: an unfiltered `get_logbook` over the default 24-hour window came
back at **5.6 MB** — more tokens than any model holds — and the
whole-installation service catalog at **351 KB**, nearly all of it per-service
field schemas. Neither was capped. `RESPONSE_LIMIT_BYTES` sits at 8 MB and
guards the worker's memory, not a run's context.

- `get_history` and `get_logbook` return at most `EVENT_PAGE_MAX` (500) rows,
  lowerable with `limit`, and report `totalMatched` and `truncated` so a short
  page is never mistaken for a quiet window. The **newest** rows are the ones
  kept: both endpoints answer oldest-first, so a head slice would drop the
  events closest to whatever question prompted the call.
- `list_services` without a `domain` returns service **names** only, and says
  so with `detail: "names"`. Pass a `domain` for that domain's full field
  schemas (`detail: "full"`). Browsing for a name does not need the schemas;
  writing a service call needs one domain's worth.
- `list_entities` caps at `ENTITY_PAGE_MAX` (500) and `get_error_log` at
  `LOG_TAIL_MAX_BYTES` (64 KB). Both already did; these were the models.

A test feeds 20,000 logbook entries through `executeTool` and asserts the
forwarded result stays two orders of magnitude smaller than the upstream body,
so a tool that stops paging fails here rather than in a run.

## A note on outbound HTTP

The plugin uses the worker runtime's own `fetch` rather than the SDK's
`ctx.http` helper. This is not an oversight. The host's implementation of
`http.fetch` resolves the target and drops every private or reserved address
unconditionally — there is no deployment-exposure escape hatch, unlike the
connector path — so a LAN or same-host Home Assistant fails with "All resolved
IPs are in private/reserved ranges". A plugin worker is a forked Node process
with ordinary network access, which is how this plugin reaches a local
instance at all.

Treat that as what it is: the plugin system's documented "trusted install, not
a sandbox boundary" posture. Install plugins you trust.

The client still behaves itself on that path: bearer auth, redirects refused so
a redirect cannot carry the token off-host, a 25s timeout, an 8 MiB response
ceiling, and error messages that never echo the configured address or the
underlying request text back to the agent.

## Development

```bash
npm install
npm run typecheck
npm test          # 161 unit tests
npm run build     # writes dist/worker.js and dist/manifest.js
node scripts/smoke.mjs
```

`scripts/smoke.mjs` is an end-to-end check: it forks the built worker the way
the host does, plays the host side of the JSON-RPC protocol — answering the
worker's `config.get` and `secrets.resolve` calls — and drives a real tool call
against a stub Home Assistant on `127.0.0.1`. The loopback address is the point:
it is exactly the case the host's gated fetch helper refuses. It also drives
every tool through the built worker and asserts each result would survive the
host's MCP forwarding — see "Why every result is an object". The stub's
`/api/error_log` and `/api/config/core/check_config` answer with credentials in
them, and the script asserts no credential appears anywhere in the forwarded
result — `content` and `data` both, since the agent reads one and its client
reads the other.

Commit `dist/*.js` when you change `src/`, since installs read the built
output. Sourcemaps are generated but not committed — they are mostly inlined
SDK source and would dwarf the rest of the repo; `npm run build` regenerates
them locally.

## What has not been verified

The unit tests are fixture-backed and the smoke test runs against a stub, so
together they prove this plugin's behaviour — not any particular Home Assistant
instance.

**All nine tools have now been called against a real Home Assistant**, through
a real agent tool-gateway session on a self-hosted Paperclip at
`2026.1012.0`, with the instance reached at a private LAN address. Every one
returned a JSON object. `get_history` returned 11 state changes for a real
light; `get_logbook` returned 6 entries; `list_services` returned the `light`
domain's service map; `check_config` returned `valid`; `render_template`
rendered. An unknown entity id came back as this plugin's own message, *Home
Assistant has no such entity or endpoint.*, and not as a transport error — which
is the whole point of returning `data` on the failure path.

Two consequences worth recording, because both were open questions:

- **The worker's `fetch` is not subject to the host's private-address block.**
  That block lives in `ctx.http.fetch`, which this plugin deliberately does not
  use. A private LAN address works.
- **A plugin tool's result survives the round trip** once `data` is an object.
  The host forwards it as `structuredContent` and the agent's MCP client accepts
  it.

**The scrub has not been run against a real instance's error log.** The rules in
`src/redact.ts` were written against the shapes Home Assistant and voluptuous
documentably produce, and are covered by fixtures and by the smoke test's stub —
but no real log tail has been read through them, so the false-positive rate on
one installation's actual logging is unmeasured. The failure mode to watch for
is over-redaction (a marker where a diagnostic value should be), not a leak.

The instance-config tests reproduce the host's save-time validator — Ajv with
formats plus the host's permissive `secret-ref` format, assembled the same way
`plugin-config-validator.ts` assembles it — so the set of values the settings
form will accept is asserted rather than assumed. That is a faithful copy of
the validator, not a live save against a running instance.

The deny-by-default behaviour in [Granting the tools to an
agent](#granting-the-tools-to-an-agent) was observed, not inferred: on a
running `2026.1012.0` instance with this plugin `ready` and its worker up, the
assigned tool catalogue for an agent held 164 tools and none of them were
plugin tools, and calls were refused as a default deny.

**The remedy has now been executed and works.** An instance admin created a
profile with nine Allow / tool-name rules and bound it to one agent; that
agent's catalogue went from 0 plugin tools to all 9, and every one of them then
answered. So both halves of that section are observed, not inferred. Expect the
field labels to be the part that drifts.

It has now been installed on a running self-hosted Paperclip at `2026.1012.0`,
and that install is where the dialog defect, the npm-name resolution and the
symlinked package path above are described from. The rest of the host behaviour
— the risk-class inference, the gated fetch helper, the activation guards and
the upgrade mechanics — was read out of the server source at that version rather
than observed. It is accurate to that code and could change in a later release.

## License

MIT
