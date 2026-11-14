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
| `spec/nd-fabric-controller-lan-1222.json.gz` | Cisco's OpenAPI document for NDFC 12.2.2 (Apache 2.0); data for the harness |

## Commands

```bash
./setup                                    # after a clone: asks, writes .env, starts, configures clients (Windows: .\setup)
node test/verify-local.mjs                 # 294 checks, no network — run after EVERY change
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
  refuses every POST, PUT and DELETE whatever calls it. The harness pins both, and reads the
  source for the three places a method is named (the login, `get()`, `send()`).
- **A write is declared, single and built here.** A write tool declares ONE `POST|PUT|DELETE`
  endpoint (plus GETs under `also`), `readOnlyHint: false`, whether it is destructive and
  idempotent, and a description that starts with `WRITE`. Its body is built in the handler from
  validated arguments. **No write argument is a template name, free-form configuration, a
  credential or a raw body**, and every string argument has a pattern that admits no newline,
  quote or command separator: a name or description ends up in device configuration. A write is
  sent once; the only retry is after a 401. The harness checks all of this per declaration.
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
- **A write error says whether anything changed.** `writeGuidanceFor` in `tools.mjs`: a refusal
  before or by the controller says nothing was changed; a timeout or a cut connection after the
  request left is `write_outcome_unknown` and says read the state first; a 5xx says the outcome
  is unknown. An attach answers HTTP 200 with a verdict per switch: anything but `SUCCESS` is
  an error result. A write answer is never passed through whole (it can carry configuration):
  only its `status` or `message` sentence.
- **The role is checked before the arguments**, so a reader learns nothing about what a write
  accepts. Roles: `read` < `write` < `admin`. Local mode: the one caller holds the ceiling.
  Gateway mode: a person's role is their grant by e-mail address (`grants.json` under
  `NDFC_MCP_DATA_DIR`), no grant means `read`, and `NDFC_MCP_ADMIN_EMAILS` are always admin.
  A grants file that cannot be read suspends every grant; a grant that cannot be stored is
  refused, never held in memory. Grant settings where no grant is read stop the server at start.
- **Every change is logged with its arguments** (`access=write args=…`); reads are logged as
  before. Write arguments are names and numbers, which is what makes logging them safe.
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

**Not verified:** on Windows, a tunnel that comes up (and so a real controller, and `setup`'s
CA pin), and a real `claude` CLI; a gateway other than the sandbox's (a second
factor, a private gateway certificate, another protocol); Claude Desktop.

Closed since this section was written: the aimo VS Code extension called the server later the
same day (stdio, as `own_ndfc`: one question, `list_switches` and `get_fabric_overview`);
`setup` and `bin/client-config` ran on macOS itself on 2026-11-14, and `list_vrfs` /
`list_networks` returned a VRF and a network that day (the section above).

Seen under Podman and left alone: with the controller unreachable and `NDFC_TIMEOUT_MS=4000`,
`get_controller_info` took 134 s and then 34 s to answer `upstream_unreachable`, though a bare
request from the same container timed out on schedule. Under Docker Desktop the same answer
came within `setup`'s 30 s run, so it may be Podman's network; not looked into.

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
