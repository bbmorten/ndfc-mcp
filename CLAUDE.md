# CLAUDE.md

Guidance for Claude Code when working in this repository. `README.md` is the user's guide; this
file holds what a change must not break.

## What this is

**ndfc-mcp** — an MCP server for Cisco Nexus Dashboard Fabric Controller, run locally with
Docker Compose. **Read-only unless `NDFC_MCP_ACCESS=write`**; with it, twelve write tools for
VRFs and overlay networks (since 0.3.0, 2026-11-14, asked for by the owner). Two containers:
`vpn` (OpenConnect, owns the AnyConnect tunnel and the network namespace) and `ndfc-mcp` (the
server, in that namespace). Node 22, **zero npm dependencies**, no build step.

It began on 2026-11-11/12 as `deploy-ndfc-mcp/` inside the GPU Pool platform repository and
became this independent project the same day, because the only way to reach a controller was a
VPN the server has to open itself — which a cluster deployment could not do.

| Path | What |
| --- | --- |
| `server/tools.mjs` | the tool declarations (read tools and write tools), `EXCLUDED_ENDPOINTS`, argument validation, redaction, the byte budget, error guidance for reads and for writes, the rate limiter. **No side effects at import** — the harness imports it |
| `server/ndfc.mjs` | the controller client: login + token cache, `get()` and `send()`, endpoint containment, the write list, TLS modes, no redirects |
| `server/auth.mjs` | the API key; in gateway mode, user-assertion verification |
| `server/grants.mjs` | who may write: the access ceiling, the roles, the grant store and the three grant tools |
| `server/server.mjs` | MCP over HTTP, `loadConfig` (fail closed), which tools are offered, the role check, the call log |
| `server/stdio.mjs` | MCP over stdin/stdout — a bridge to the HTTP server in the same container, not a second implementation |
| `server/pin-ca.mjs` | prints `NDFC_TLS_CA_PEM` for the controller's CA |
| `vpn/` | the OpenConnect sidecar: `connect.sh` (connect, retry; `VPN_MODE` tunnel or proxy), `healthcheck.sh` (tun0 has an address; in proxy mode, ocproxy runs and each forward accepts), `proxy-hook.sh` (proxy mode only: becomes ocproxy) |
| `compose.yaml` / `compose.direct.yaml` | with the VPN sidecar / without it |
| `bin/client-config` | prints client configuration with this checkout's real paths, never the key. Node (CommonJS, no dependencies) since the Windows work; on POSIX its output is byte-identical to the `sh` script it replaced, on Windows the two `claude` lines are PowerShell |
| `setup.cmd`, `bin/client-config.cmd` | Windows launchers: `node` on the script beside them. CRLF (`.gitattributes`); everything else is LF |
| `setup` | the interactive installer (Node, CommonJS, no dependencies): asks, writes `.env`, starts and checks the containers, configures Claude Code / Claude Desktop / aimo. Touches only the `ndfc` entry of a client file, backs it up first, keeps JSONC comments in VS Code's `settings.json`, never prints a secret |
| `defaults.env` | `setup`'s defaults — **committed with the lab's credentials, on the owner's decision** (see Working rules) |
| `test/verify-local.mjs` | the offline harness (stub controller on loopback) |
| `test/live-check.mjs` | every read tool against a real controller; `--write` and `--deploy` change it and put it back |
| `PROMPTS.md` | longer prompts, all run on the lab: thirteen that read, nineteen that write (from the platform's KB articles 23 and 24) |
| `spec/nd-fabric-controller-lan-1222.json.gz` | Cisco's OpenAPI document for NDFC 12.2.2 (Apache 2.0); data for the harness |

## Commands

```bash
./setup                                    # after a clone: asks, writes .env, starts, configures clients (Windows: .\setup)
node test/verify-local.mjs                 # 350 checks, no network — run after EVERY change
node test/live-check.mjs                   # needs .env and a controller node can reach from the host; changes nothing
node test/live-check.mjs --write           # CHANGES THE CONTROLLER and puts it back (a lab); --deploy also configures a leaf
docker compose up -d --build               # with the VPN sidecar
docker compose -f compose.direct.yaml up -d --build   # controller already reachable
```

There is no linter and no package.json. The harness is the gate.

## What must survive a refactor

- **Read-only by construction, by default.** `NDFC_MCP_ACCESS` is the server's ceiling and
  defaults to `read`. Under it the write tools and grant tools are not offered (a call to one
  is `unknown tool`), and the controller client is built with an EMPTY write list, so `send()`
  refuses every POST, PUT and DELETE whatever calls it. The harness pins both (`/healthz`
  reports the client's `canWrite`), and reads the source for the three places a method is named
  (the login, `get()`, `send()`). The instructions `initialize` returns open with the read-only
  promise only on a read-only server (`instructionsFor`).
- **A write is declared, single and built here.** A write tool declares ONE `POST|PUT|DELETE`
  endpoint (plus GETs under `also`), `readOnlyHint: false`, whether it is destructive and
  idempotent, and a description that starts with `WRITE`. Its body is built in the handler from
  validated arguments. **No write argument is a template name, free-form configuration, a
  credential or a raw body**, and every string argument has a pattern that admits no newline,
  quote or command separator: a name or description ends up in device configuration. A write is
  sent once; the only retry is after a 401. The harness checks all of this per declaration.
  `detach_network` with `detachSwitchPorts` reads the attachment first and sends nothing unless
  the network is attached to that switch with those ports: the request is the controller's
  ATTACH call, and would attach the network where it was not.
- **Which writes exist is the owner's decision.** The twelve of 0.3.0 cover VRFs and overlay
  networks (create, delete, attach, detach, deploy) and a fabric's recalculate and deploy.
  **Another write tool is asked for explicitly — never added as part of another change.**
  Policies, interfaces, templates, discovery, credentials, bulk and import routes stay out.
- **Every controller route not declared is unreachable.** NDFC documents 455 GET and 385 write
  operations; this server reaches sixteen (the fourteen read tools, and the next-free-id lookup
  each of the two create tools makes) and ten. `EXCLUDED_ENDPOINTS` records the reads
  deliberately left out, each with a reason. A new tool needs: the endpoint in the spec (the
  harness checks), a strict `inputSchema`, its annotations, redaction decided, a harness check
  for its request and its result, and a run against a controller.
- **A write error says whether anything changed, and "nothing was changed" has to be known.**
  `writeGuidanceFor` in `tools.mjs` says it in two cases only: the controller refused (400, 401,
  403, 404, 409, 422), or the server knows the write was not sent. That knowledge is
  `notSent`: `server.mjs` sets it when the handler failed before it called `send()` (a read the
  tool makes first), and `ndfc.mjs` when the login failed or the request never had a connected
  socket (`request()` tracks this per request). Everything after that point is
  `write_outcome_unknown`: a timeout, a cut connection, a TLS fault after the handshake, a
  redirect, an answer over the size limit. A 5xx, and a 2xx that is not the controller's (not
  JSON and not a short plain sentence; a create that does not name what it created) say the
  outcome is unknown. An attach answers HTTP 200 with a verdict per switch: all `SUCCESS` is a
  success, all refusals `controller_refused_change`, a mix `write_partly_applied`, and a verdict
  that begins with SUCCESS and goes on is `write_outcome_unknown` (never measured). A deploy
  tool returns `accepted`, not `changed`. A write answer is never passed through whole (it can
  carry configuration): only its `status` or `message` sentence.
- **No request can take the process down, and every wait has a limit.** The HTTP listener
  catches everything (`GET //` is a 400); `request()` has a deadline that covers the connection
  itself, not only an idle socket; the stdio bridge uses `node:http` with its own 360 s timer,
  because `fetch` gives up on headers at 300 s.
- **The role is checked before the arguments**, so a reader learns nothing about what a write
  accepts. Roles: `read` < `write` < `admin`. Local mode: the one caller holds the ceiling.
  Gateway mode: a person's role is their grant by e-mail address (`grants.json` under
  `NDFC_MCP_DATA_DIR`), no grant means `read`, and `NDFC_MCP_ADMIN_EMAILS` are always admin.
  A grants file that cannot be read suspends every grant (`grant_list` says so, `grant_revoke`
  refuses, `grant_set` sets the file aside); a grant that cannot be stored or logged is refused,
  never held in memory: the changelog line is appended BEFORE `grants.json` is replaced. The
  assertion's address is matched as received against the grant tools' pattern, then lower-cased
  (no trim). The file is re-read when it changes on disk. Grant settings where no grant is read
  stop the server at start.
- **Every change is logged with its arguments, before and after** (`msg="tool call started"`,
  then the outcome line, both with `access=write args=…`); reads are logged as before. Write
  arguments are names and numbers, which is what makes logging them safe. On SIGTERM the server
  names the changes in flight and waits for them (`stop_grace_period: 2m` in the compose files).
- **A create sends the template's defaults.** `create_vrf` and `create_network` read the pinned
  template (`GET /configtemplate/rest/config/templates/{name}`) and send every parameter's
  `defaultValue` under their own values, merged AFTER `clean()` so an argument left out keeps
  its default. Without them NDFC renders the placeholders: `ip address 192.0.2.1/24 tag $$tag$$`
  reached the switches on 2026-11-14 and NX-OS refused the gateway (the UI fills these in).
- **A deploy waits for the switches.** `deploy_vrf`/`deploy_network` read the object's
  attachments every 3 s (`NDFC_MCP_DEPLOY_POLL_MS`) until no switch is `PENDING`/`IN PROGRESS`
  (`waitSeconds`, default 60, at most 90, under aimo's 120 s per request) and return `outcome`.
  A read that fails there is not an error (the deployment was accepted). Why: the model has no
  other way to wait, and deployments sent back to back left a switch `OUT-OF-SYNC` (a
  network's `member vni` line on `nve1` never sent).
- **The deployment history is asked for newest first**, `sort=completedTime:desc`, and by switch
  on the controller (`filter=serialnumber==X`; it does not combine two filters, so `status` is
  applied here). Unsorted, the controller returns its OLDEST 200 rows, and a fabric deployment
  writes one row per interface. `failedCommandCount` counts `FAILED` only; NX-OS's `WARNING`
  (`vrf member …` on an SVI) and `NOT_EXECUTED` are counted apart.
- **Over stdio the tool list is announced at every start.** The bridge adds
  `tools.listChanged` to the `initialize` answer and sends `notifications/tools/list_changed`
  after the client's `notifications/initialized`. Which tools exist depends on
  `NDFC_MCP_ACCESS`, and a client may keep the list it saw last: aimo 1.4.7 stores a local
  server's tools per launch line and never asks again on its own, so after the switch to write
  it went on showing the twelve read tools of 2026-11-12, each marked `read-only`.
- **Hidden text is removed by Unicode category** (`UNSAFE_CHARS`: Cc except tab, LF and CR, all
  of Cf, U+2028/2029), from every string and every object key of a result.
- **Secrets stay on the controller.** Measured on the lab: a policy's `generatedConfig` and a
  deployment's command list carry local-user password hashes. Neither field is ever copied into
  a result. Fabric settings are redacted by key name; free-form CLI settings are omitted whole.
  `…/lanConfig/getLanSwitchCredentials` (stored switch logins; live on the controller, absent
  from the public spec) is excluded by name.
- **The result fits the client.** 26,000 bytes of the final JSON-RPC response; rows are dropped
  from the end by binary search, never sliced; the result says `truncated`, how many of how
  many, and which filter narrows it.
- **Errors are tool results with guidance on every status**, and an exception that is not a
  `ToolError` is logged and answered `tool_failed` with no detail.
- **The API key is required on every request, discovery included**, and the server refuses to
  start without one. Compose publishes the port on `127.0.0.1` only. A request with an `Origin`
  header is refused (a browser has no business here).
- **Two modes, never a blend.** `local` (default): the key is everything, a presented user
  assertion is *refused*. `gateway`: `tools/call` needs a verified assertion, the algorithm is
  chosen by configuration and never by the token header, `aud` has no code default. Assertion
  settings left in place under local mode stop the server at start.
- **Configuration fails closed** — every missing or contradictory setting is printed and the
  process exits 1.
- **TLS to the controller is a decision**: `verify` (default), `pin` (`NDFC_TLS_CA_PEM` — the CA
  at the top of the chain the controller presents; pinning Nexus Dashboard's leaf fails with
  `SELF_SIGNED_CERT_IN_CHAIN`), `insecure` (said out loud in the log and `/healthz`).
- **`/healthz` never touches the controller.**
- **The VPN password is never on a command line or in a log** (`connect.sh` pipes it from a
  shell builtin), and only the `vpn` container holds `NET_ADMIN`.
- **stdout of `stdio.mjs` carries protocol messages only.**
- **macOS and Windows hosts both work, from one set of scripts.** Whatever runs on the host is
  Node, never `sh` (`vpn/*.sh` run inside the image). A host path is built with `node:path` and
  goes into JSON through `JSON.stringify`. `setup` starts `claude.cmd` (an npm install on
  Windows) through cmd.exe with plain arguments, because a JSON argument does not survive its
  quoting; a real executable still gets `add-json`. A change to `setup` or `bin/client-config`
  is checked on both: on POSIX the output must not move.

## Working rules

- Never print, log or commit a credential. `.env` is git-ignored; scripts that read it print key
  names only. **The one exception is `defaults.env`**: the owner decided on 2026-11-12 to commit
  the lab's values (API key, DevNet controller and VPN logins) as `setup`'s defaults, in a
  private repository. Keep the exception that narrow. No production credential goes there, and
  no other file gets one.
- The harness asserts no tool count. Keep it that way: check what each declaration must be.
- A number in `README.md` or here (checks, tools, operations) is a claim: re-measure before
  changing it.
- Do not add an npm dependency without asking. The zero-dependency server is deliberate.

## State (2026-11-14, night): 0.3.1 deployed for real on the lab

The lab's leaves, border and second spine had never come up (N9Kv panicked ~9 min into boot).
They were wiped in CML and given 12 GB each (from 8): all came up, NDFC rediscovered them (new
serials for leaf2, leaf3, spine2: `9VD2GFNQV22`, `90P52LDI6W6`, `9L2KS4BCVRE`), and
`recalculate_fabric_config` + `deploy_fabric_config` put all five `In-Sync`. That first fabric
deploy ran past `NDFC_WRITE_TIMEOUT_MS` (90 s): `write_outcome_unknown`, then `In-Sync` two
minutes later on its own.

Then nineteen prompts for site KB article 24 (platform repo, branch `feature/kb-ndfc-write`)
ran through `claude -p` over the stdio bridge, each a new conversation with only the ndfc
tools: VRFs and networks created, attached to two leaves and the border with ports, deployed,
moved, detached and deleted, six refusals, a fabric recalculate and deploy. That found three
faults, fixed here (invariants above): the missing template defaults, the history returning the
oldest rows, and back-to-back deployments. Verified after the fixes: harness 350/350, all
nineteen prompts clean (223 turns), every deployment settled in ~13 s, the fabric `In-Sync` and
empty at the end. Seen on the controller, not in our code: when a VRF's last network leaves a
switch, the same deployment removes the VRF there (`no vrf context …`), so a later `detach_vrf`
is refused *is already in detached state* and `deploy_vrf` finds nothing pending.
`MCP_TEST_VRF`/`MCP_TEST_NET` are gone. Pushed (`b4a46d1`).

On Windows (2026-11-16, Node 22.15) the harness crashed once in six runs at the first
`list_deploy_history` check: one call to the stub took past the harness's 1 s controller
timeout. The harness now gives the stub 10 s (the timeout case keeps its own 1 s server), and
that check prints what came back instead of crashing. At `b60255e` it passed 9 runs of 9 there.

**The Windows tunnel is verified** (2026-11-17, Windows 11, Docker Desktop 29.9, `2c71ee8`):
the owner ran `.\setup` (VPN sidecar, TLS pin, write access). The sidecar logged in to the
sandbox gateway (group `SSLClient`, DTLS + LZS), `tun0` got `192.168.254.x/32`, both containers
were healthy, `/healthz` reported 0.3.1, 26 tools, `controllerTls: pin`, one controller login and
`canWrite: true`. The stdio bridge driven from PowerShell announced `list_changed`, listed 26
tools, and answered `get_controller_info` (12.2.2.241) and `list_fabrics`. No write was sent. The
sidecar rode out one dead-peer detection, reconnecting with the same address. Its `.env` had
kept the previous reservation's VPN password over `defaults.env`'s new one (`.env` wins in
`setup`), which is why a new reservation needs either `.env`'s `VPN_*` lines removed or
re-entered. Still not run there: a real `claude` CLI (not installed) and aimo.

## State (2026-11-14, evening): 0.3.1, the review's fixes

0.3.0 was reviewed before it was switched on locally: six reviewers, each finding then checked
twice (one agent reproducing it offline, one trying to refute it). 32 findings, all confirmed,
about twenty distinct defects, none rated high. 0.3.1 fixes all of them:

- `ndfc.mjs`: a deadline that covers the connection; "sent" tracked per request, so a failure
  is `write_outcome_unknown` only when the write can have reached the controller, and "not
  sent" only when it cannot; a 2xx page of markup is not an answer; `/healthz` shows `canWrite`.
- `server.mjs`: no request can crash the process (`GET //`); a change is logged before it is
  sent; SIGTERM names and waits for changes in flight; the instructions of a write server no
  longer open with "Read-only access".
- `tools.mjs`: `write_partly_applied`; a ports-only `detach_network` reads the attachment
  first; attachment rows in an unknown shape are an error, not an empty list; reserved VRF
  names; a create must name what it created; deploy tools answer `accepted`; the sanitizer
  works by Unicode category and covers keys.
- `grants.mjs`: changelog before file; the assertion's address matched as received; the file
  re-read when it changes; the suspended state shown and not papered over; a stored grant
  under a configured administrator can be seen and revoked; `grant_list` takes filters.
- `stdio.mjs`: its own 360 s timer; a lost tool call says a change may have been applied.
- `live-check.mjs`: a teardown when a `--write` run stops half way. `vpn/`: the proxy-mode
  healthcheck and the `VPN_FORWARDS` check.

Verified: harness 338/338, and twelve fixes were removed one at a time in a scratch copy to
see their checks fail. The connect deadline was timed against a silent address (1.5 s with a
1.5 s limit). The local stack (`compose.yaml`, VPN sidecar) was rebuilt with
`NDFC_MCP_ACCESS=write`: `/healthz` reports 0.3.1, 26 tools, `access: write`, `canWrite: true`.
Through it, against the sandbox: a VRF created, read back and deleted over HTTP; a ports-only
detach refused twice with no write sent (a switch the network is not on, a port it does not
carry); **Claude Code as the MCP client over the stdio bridge** created and deleted a VRF
(`claude -p --mcp-config … --strict-mcp-config`, checked in the server's log, not by its
answer); `live-check.mjs --write` all passing with the CA pinned.

`live-check.mjs` needs the controller reachable from where node runs. Without a second VPN
login it runs inside the stack's own network:
`docker run --rm --network container:ndfc-mcp-vpn-1 -v "$PWD":/src:ro --entrypoint node ndfc-mcp:local /src/test/live-check.mjs --env /src/.env --write`.

The announcement was checked with aimo 1.4.7's own stdio client (`src/mcp/stdio.ts`, bundled
with esbuild and run against the stack): one `list_changed` event, then 26 tools listed, 14
read-only and 12 write. Then in the extension itself (aimo 1.4.7, a platform-mode window, 18:27):
the first prompt ran `list_vrfs` from the old stored list and said the server was read-only;
that call started the server, the stored list became 26 tools, and the second prompt ran
`create_vrf`, `list_vrfs`, `delete_vrf`, `list_vrfs` (the server's log has all four).

**Not verified:** a deployment that succeeds, again: at 18:10 the controller still reported
every leaf `Unreachable`, so `--deploy` was not run and the new teardown path has run only as
code that parses. The grant-store changes ran in the harness only. Of the `vpn/` proxy-mode
fixes, the forwards check was exercised under `sh` and the healthcheck not at all (proxy mode
itself is unfinished, below). `MCP_TEST_VRF` and `MCP_TEST_NET` are still `PENDING` on the lab.

## State (2026-11-14): write access, 0.3.0

Built and verified against a new reservation of the same sandbox, reached from the host through
a SOCKS proxy and a local port forward (the host's own VPN client held another network):

- Harness 294/294. Two guards were broken on purpose to see it fail: a role check that lets
  everyone write (5 checks failed), and `send()` without its write list (7 failed).
- `live-check.mjs`: read-only 29/29 with the CA pinned and no write sent; `--write` all passing —
  a reader refused, an administrator's grant, `create_vrf`, `create_network`, the attachment
  reads, the controller's refusals (duplicate, a VRF with a network, a spine), both deletes,
  the same VRFs and networks afterwards, and the revoke.
- Called through the real server in local mode: `attach_network`, `detach_network` (whole and
  ports only), `detach_vrf`, `recalculate_fabric_config` ("Config save is completed"),
  `deploy_network`, `delete_network`.
- The image built from this tree, run as `compose.direct.yaml` declares it (read-only
  filesystem, no capabilities, 127.0.0.1 only): 26 tools, a create and a delete over HTTP and
  over the stdio bridge, `/data` writable by the server's user.
- `./setup --yes` in scratch copies, old and new side by side: identical output, `.env` and aimo
  entry in read mode; with `NDFC_MCP_ACCESS=write` it keeps the line and writes the other
  description.

**Not verified:** a deployment that succeeds — the sandbox's switches were still booting (one
spine reachable, no leaf), so `deploy_*` timed out and `--deploy` skipped itself; the answer of
a successful `deploy_vrf`, `deploy_network` and `deploy_fabric_config` is from Cisco's API
document. No MCP client was driven with the write tools. Gateway mode ran only against
assertions the tests signed. Nothing of this was run on Windows.

What the lab taught, kept because the document does not say it:

- v2 `vrfs` / `networks` take `vrfTemplateConfig` / `networkTemplateConfig` as an OBJECT and
  fill every setting not sent. `vrfinfo` / `netinfo` propose the next free VNI.
- An attachment needs `vlan`: missing, it is a NullPointerException inside an HTTP 200; `0`
  lets the controller choose. A network attachment takes the network's VLAN when none is sent.
- Taking ports out of a network needs `switchPorts: ""` beside `detachSwitchPorts`; without it
  the controller answers 500 with a NullPointerException.
- The v2 GET of VRF attachments returns a list of lists; the v1 GET returns the documented
  shape. The read tools use v1.
- Refusals are HTTP 400 `{Error, message}` with tabs inside the message; recalculate refuses
  with one plain sentence and HTTP 500 while a switch is unreachable.
- With a switch unreachable, a deployment does not answer within 60 s, and an object that was
  ever attached cannot be deleted: its detach stays `PENDING` until a deployment succeeds.
  **`MCP_TEST_VRF` and `MCP_TEST_NET` were left on that reservation in this state.**

**The sandbox gateway holds ONE session per VPN login** (seen 2026-11-14): a second client that
logs in with the same account is given the same address, and one of the two is ended with
`Received server disconnect: b0 'Internal Error'` about 13 s later. A sidecar retries every
10 s, so two clients on one login knock each other off for as long as both run. Before starting
the stack, stop every other client of that login (another checkout's stack, a host VPN client).

**`VPN_MODE=proxy` in the sidecar is built, not finished** (same day, for a place that gives a
container no capability, such as a Kubernetes pod): OpenConnect with `--script-tun` and
`ocproxy`, one `VPN_FORWARDS` port on 127.0.0.1, no interface and no route. Run as uid 10001
with every capability dropped and a read-only filesystem it logged in and one request through
the forward answered 200. Whether it holds a session is NOT known: every run was ended after
13 s by the one-session rule above, because this checkout's own stack was up on the same login.
Not in the README, not in a compose file, default unchanged (`tunnel`).

## State (2026-11-12)

Verified against Cisco's DevNet sandbox (NDFC 12.2.2.241, Nexus Dashboard 3.2(1i)): harness
174/174, live-check 28/28 with the CA pinned, `compose.direct.yaml` up and healthy, and the
`claude` CLI calling tools over both HTTP and stdio.

The VPN sidecar is verified too (same day, `compose.yaml`): OpenConnect logged in to the
sandbox gateway (`devnetsandbox-usw1-reservation.cisco.com:<port of the reservation>`, group
`SSLClient` chosen without `VPN_AUTHGROUP`, DTLS + LZS), `tun0` got `192.168.254.x/32` and
split-tunnel routes for `10.10.20.0/24`–`10.10.24.0/24` — the container's default route stayed
on `eth0` — and the server made one controller login and answered tool calls over HTTP, stdio
and the `claude` CLI. Repeated with the host's own VPN client OFF: the host could no longer
reach the controller (timeout, route via `en0`), the containers still could, the tools still
answered, and the sidecar had not reconnected — the tunnel is the container's own.

`./setup` is verified too (same day). Run in a simulated fresh clone with no `.env`, under a real
TTY with Enter for every answer, it reproduced the `.env` values and `.mcp.json`. It added only
the `ndfc` entry to Claude Desktop's config and to a JSONC `settings.json`, keeping comments and
trailing commas, and printed no secret. Piped answers covered the direct mode, a new key,
Claude Code at user scope through the CLI, and aimo over HTTP. A run in the real checkout left
the containers healthy without recreating them, answered `get_controller_info`, and the stdio
bridge answered. It *wrote* the Claude Desktop and aimo configurations, but neither client was
run against them.

Windows is partly verified (same day; Windows 11, Node 22.15, Git Bash and PowerShell 5.1, no
controller in reach; first with Podman 5.5, then with Docker Desktop 29.9 / Compose 5.7 — see
the paragraph after this one). The harness, now 175 checks, passes; it
found that `server.mjs` never started when run directly on Windows (its "am I the main module"
test split the path on `/`). `.\setup` ran in simulated fresh clones with `%APPDATA%` redirected
and a fake npm-style `claude.cmd`: `--yes` reproduced `.env` and `.mcp.json`; piped answers
covered Claude Code at user scope over stdio and HTTP through `claude.cmd`, Claude Desktop under
`%APPDATA%\Claude`, and aimo in a CRLF `settings.json` with comments, which keeps its CRLF. No
secret was printed. Both images were built from the Windows checkout and run by hand with the
settings `compose.direct.yaml` declares: `/healthz`, 401 without the key, twelve tools with it,
and the stdio bridge driven from Node and from a PowerShell pipe (which prepends a byte-order
mark; the bridge now drops it). The `vpn` image ran its connect loop against a dead loopback
port; built from CRLF copies of its scripts it died at exec with the previous Dockerfile and ran
with this one. For macOS, the committed and the new `setup` and `bin/client-config` were run
side by side in a Linux container: identical output and files, but for the second in a backup's
name.

With Docker Desktop on the same machine: `.\setup` in direct mode, in a fresh-clone copy under
its own project name and port, built the image, waited for `healthy`, got 200 from `/healthz`,
reported `upstream_unreachable` for the controller, and the stdio bridge answered through
`docker compose exec`; the Claude Desktop entry it wrote (full path of `docker.exe`), run as
written, listed the tools; the port was published on 127.0.0.1 only. `compose.yaml` built and
started the sidecar, which reached the sandbox gateway and chose group `SSLClient`, and the
gateway answered **"Login failed"** to the login in `defaults.env` — the settings were in the
container byte for byte, so that is the gateway's answer, most likely a reservation that had
ended. No tunnel came up on Windows. That run is why `setup` now says, when `up` fails,
whether Docker is not answering or the tunnel did not come up, shows the sidecar's last lines,
and stops it instead of leaving it to retry a refused login.

**Not verified:** on Windows, a real `claude` CLI (the tunnel, a real controller and `setup`'s
CA pin were verified on 2026-11-17, above); a gateway other than the sandbox's (a second
factor, a private gateway certificate, another protocol); Claude Desktop.

Closed since this section was written: the aimo VS Code extension called the server later the
same day (stdio, as `own_ndfc`: one question, `list_switches` and `get_fabric_overview`);
`setup` and `bin/client-config` ran on macOS itself on 2026-11-14, and `list_vrfs` /
`list_networks` returned a VRF and a network that day (the section above).

Seen under Podman on 2026-11-12: with the controller unreachable and `NDFC_TIMEOUT_MS=4000`,
`get_controller_info` took 134 s and then 34 s to answer `upstream_unreachable`. The likely
cause was found on 2026-11-14: no timeout covered the connection itself, so an address that
did not answer waited for the operating system. `request()` now has a deadline for it
(measured on macOS against a silent address: 1.5 s with a 1.5 s limit). Not re-run under Podman.

## The lab

Cisco DevNet sandbox "vNexus Dashboard Fabric Controller": on demand, a reservation of hours, a
fresh VPN login per reservation, the same addresses in every pod (controller
`https://10.10.20.60`, HTTPS only). `GET /version.json` answers without a login and is the
cheapest reachability probe. A reservation whose `POST /login` answers 200 while every API call
answers 500 "There was a problem proxying the request" is not going to recover: take a new one.

What the spec and the lab disagree on: three live endpoints are not in the spec
(`getLanSwitchCredentials`, `vpcpair` as a GET, `topologydataforvmm`); the spec marks
`alarmlist`'s `reqParam` as required, yet the lab answers without it; the spec offers
server-side `filter`/`sort` on several lists, unused here because their syntax is unverified.
