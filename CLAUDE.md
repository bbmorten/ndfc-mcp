# CLAUDE.md

Guidance for Claude Code when working in this repository. `README.md` is the user's guide; this
file holds what a change must not break.

## What this is

**ndfc-mcp** — a read-only MCP server for Cisco Nexus Dashboard Fabric Controller, run locally
with Docker Compose. Two containers: `vpn` (OpenConnect, owns the AnyConnect tunnel and the
network namespace) and `ndfc-mcp` (the server, in that namespace). Node 22, **zero npm
dependencies**, no build step.

It began on 2026-11-11/12 as `deploy-ndfc-mcp/` inside the GPU Pool platform repository and
became this independent project the same day, because the only way to reach a controller was a
VPN the server has to open itself — which a cluster deployment could not do.

| Path | What |
| --- | --- |
| `server/tools.mjs` | the twelve tool declarations, `EXCLUDED_ENDPOINTS`, argument validation, redaction, the byte budget, error guidance, the rate limiter. **No side effects at import** — the harness imports it |
| `server/ndfc.mjs` | the controller client: login + token cache, GET only, endpoint containment, TLS modes, no redirects |
| `server/auth.mjs` | the API key; in gateway mode, user-assertion verification |
| `server/server.mjs` | MCP over HTTP, `loadConfig` (fail closed), the call log |
| `server/stdio.mjs` | MCP over stdin/stdout — a bridge to the HTTP server in the same container, not a second implementation |
| `server/pin-ca.mjs` | prints `NDFC_TLS_CA_PEM` for the controller's CA |
| `vpn/` | the OpenConnect sidecar: `connect.sh` (connect, retry), `healthcheck.sh` (tun0 has an address) |
| `compose.yaml` / `compose.direct.yaml` | with the VPN sidecar / without it |
| `bin/client-config` | prints client configuration with this checkout's real paths, never the key |
| `test/verify-local.mjs` | the offline harness (stub controller on loopback) |
| `test/live-check.mjs` | every tool against a real controller |
| `spec/nd-fabric-controller-lan-1222.json.gz` | Cisco's OpenAPI document for NDFC 12.2.2 (Apache 2.0); data for the harness |

## Commands

```bash
node test/verify-local.mjs                 # 174 checks, no network — run after EVERY change
node test/live-check.mjs                   # needs .env and a controller node can reach from the host
docker compose up -d --build               # with the VPN sidecar
docker compose -f compose.direct.yaml up -d --build   # controller already reachable
```

There is no linter and no package.json. The harness is the gate.

## What must survive a refactor

- **Read-only by construction.** Every tool declares one `endpoint`; `tools.mjs` throws at load
  if one is not a `GET`; `ndfc.mjs`'s `get()` refuses any path that is not the calling tool's
  declared endpoint before a byte leaves the server; the module makes exactly one POST, the
  login. The harness pins that by reading the source. **A write tool is the owner's decision,
  asked for explicitly — never added as part of another change.**
- **Every controller route not in `TOOLS` is unreachable.** NDFC has 455 GET operations; this
  server reaches twelve. `EXCLUDED_ENDPOINTS` records the ones deliberately left out, each with
  a reason. A new tool needs: the endpoint in the spec (the harness checks), a strict
  `inputSchema`, `readOnlyHint`, redaction decided, and a harness check for its result.
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

## Working rules

- Never print, log or commit a credential. `.env` is git-ignored; scripts that read it print key
  names only.
- The harness asserts no tool count. Keep it that way: check what each declaration must be.
- A number in `README.md` or here (checks, tools, operations) is a claim: re-measure before
  changing it.
- Do not add an npm dependency without asking. The zero-dependency server is deliberate.

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

**Not verified:** a gateway other than the sandbox's (a second factor, a private gateway
certificate, another protocol); Claude Desktop; the aimo VS Code extension (the configuration follows
its documented `aimo.mcp.local.servers` format, and the server speaks the protocol revision it
uses, 2025-06-18). `list_vrfs` / `list_networks` have only seen empty lists.

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
