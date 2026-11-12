# ndfc-mcp

A read-only [MCP](https://modelcontextprotocol.io) server for **Cisco Nexus Dashboard Fabric
Controller (NDFC)**. It lets an AI assistant — Claude Code, Claude Desktop, aimo for VS Code —
answer questions about your data-center fabric: which fabrics exist, which switches are in them
and whether they are in sync, what an interface is doing, what is alarming, what was deployed.

It runs on your own machine with Docker Compose and **brings its own VPN**: a sidecar container
opens the Cisco AnyConnect tunnel to the controller's network, so your laptop's own network and
VPN stay as they are.

It cannot change anything. Every tool is a `GET`; the server has no code path to a write.

## The tools

| Tool | Answers |
| --- | --- |
| `get_controller_info` | Which NDFC version is this, and does it answer? |
| `list_fabrics` | Which fabrics does the controller manage, and how healthy are they? |
| `get_fabric` | What are this fabric's settings (routing, ranges, VLANs, MTU, …)? |
| `get_fabric_overview` | How many switches are healthy, in sync, in each role? |
| `list_switches` | Which switches: name, serial, IP, role, model, release, sync state? |
| `list_interfaces` | One switch's interfaces: state, mode, speed, IP, VLANs, neighbours |
| `list_links` | One fabric's links, both ends of each |
| `list_switch_policies` | Which templates configure this switch |
| `list_vrfs`, `list_networks` | The VRFs and overlay networks of a fabric |
| `list_alarms` | What is alarming, where, since when |
| `list_deploy_history` | What the controller deployed, to which switch, with what outcome |

Start with `list_fabrics` (it gives the fabric names the others take) and `list_switches` (it
gives the serial numbers).

## What you need

- **Docker** with Compose v2 (Docker Desktop on macOS/Windows, Docker Engine on Linux).
- **A controller** — Nexus Dashboard with the Fabric Controller service — and an account on it.
  A read-only account (role `network-operator`) is all the server needs.
- **The VPN details** for the controller's network, as you would type them into Cisco
  AnyConnect / Secure Client: gateway (`host` or `host:port`), username, password.

No controller of your own? Cisco's free DevNet sandbox
[*vNexus Dashboard Fabric Controller*](https://developer.cisco.com/sandbox/detail/vnexus-dashboard-sandbox)
gives you one for a few hours. Reserve it; its page lists the controller login under
**Access details** (row `ndfc`) and the VPN gateway and login under **VPN access**.

## Start it

```bash
cd ndfc-mcp
cp .env.example .env
```

Edit `.env`. It asks for three things:

| Setting | What |
| --- | --- |
| `NDFC_MCP_API_KEY` | A key of your own for this server. Generate it: `openssl rand -hex 24` |
| `NDFC_URL`, `NDFC_USERNAME`, `NDFC_PASSWORD` | The controller and the account to read it with |
| `VPN_SERVER`, `VPN_USERNAME`, `VPN_PASSWORD` | The VPN gateway and login |

Put a value that contains `$` in `'single quotes'`. `.env` is git-ignored; keep it that way.

```bash
docker compose up -d --build
docker compose ps
```

Both containers should read `healthy` within a minute: `vpn` once the tunnel is up, then
`ndfc-mcp`. Check the server and the controller in one go:

```bash
curl -s http://127.0.0.1:3300/healthz
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_controller_info","arguments":{}}}' \
  | docker compose exec -T ndfc-mcp node /app/stdio.mjs
```

The second command prints the controller's version. If it prints an error instead, the message
says which part failed — see [Troubleshooting](#troubleshooting).

### Already on the controller's network?

If your machine reaches the controller without this VPN (you are on the management network, or
your own VPN client is connected), skip the sidecar:

```bash
docker compose -f compose.direct.yaml up -d --build
```

Same server, same `.env` (the `VPN_*` lines are ignored), same port. Use
`-f compose.direct.yaml` in every `docker compose` command below, and `bin/client-config direct`.

## Connect a client

`bin/client-config` prints everything below with the real paths of **your** checkout filled in,
ready to paste. Run it once and copy the block for your client.

There are two ways in, and both reach the same server:

- **stdio** — the client runs `docker compose exec … node /app/stdio.mjs`. Nothing to configure
  on the client but that command; being able to run Docker on this machine is the credential.
- **HTTP** — the client calls `http://127.0.0.1:3300/mcp` and sends the API key in `X-Api-Key`.

### Claude Code

```bash
# stdio
claude mcp add --transport stdio ndfc -- docker compose -f "$(pwd)/compose.yaml" exec -T ndfc-mcp node /app/stdio.mjs

# or HTTP
claude mcp add --transport http ndfc http://127.0.0.1:3300/mcp \
  --header "X-Api-Key: $(grep -E '^NDFC_MCP_API_KEY=' .env | cut -d= -f2-)"
```

Start a new session and type `/mcp`: `ndfc` should show **Connected** with 12 tools. Add
`--scope user` to either command to have it in every project instead of only the current one.

To share it with a team through a repository, commit a `.mcp.json` like this and let each person
export `NDFC_MCP_API_KEY` in their shell — the key itself stays out of git:

```json
{
  "mcpServers": {
    "ndfc": {
      "type": "http",
      "url": "http://127.0.0.1:3300/mcp",
      "headers": { "X-Api-Key": "${NDFC_MCP_API_KEY}" }
    }
  }
}
```

### Claude Desktop

Settings → Developer → **Edit Config** opens `claude_desktop_config.json`. Add the `ndfc` entry
that `bin/client-config` prints under `"mcpServers"` (it carries the full path of `docker` and of
your compose file, which a desktop app needs), then quit and reopen Claude Desktop.

### aimo for VS Code

Open your user `settings.json` (Command Palette → **Preferences: Open User Settings (JSON)**) and
paste the stdio block that `bin/client-config` prints. It looks like this, with your path:

```json
"aimo.mcp.local.enabled": true,
"aimo.mcp.local.servers": {
  "ndfc": {
    "type": "stdio",
    "command": "docker",
    "args": ["compose", "-f", "REPLACE_ME_with_the_compose_path_from_bin/client-config", "exec", "-T", "ndfc-mcp", "node", "/app/stdio.mjs"],
    "description": "Read-only Cisco NDFC: fabrics, switches, interfaces, links, policies, alarms"
  }
}
```

The server appears in the **Tool Servers** view, and the model sees it as `own_ndfc`. Before it
first runs, aimo shows the exact command and asks; after that its tools run without a prompt,
because every one is marked read-only.

Prefer stdio here. The HTTP form works too (`bin/client-config` prints it), but its API key must
be stored with **AIMO: Set Local Server Secret**, and aimo then asks for approval on *every* call
to a server that receives a secret.

Two things your organisation controls, not this server: while you are signed in to the platform,
each call is checked and recorded by it before it runs, and an administrator can switch
people's own tool servers off — a call then answers that own tool servers are not allowed.

## Try it

- *"Which fabrics does the controller manage, and are their switches in sync?"*
- *"Show me the interfaces on leaf1 that are down, and why."*
- *"What are the BGP settings of DevNet_Fabric?"*
- *"Which alarms are raised right now, grouped by switch?"*
- *"What was the last thing deployed to spine1, and did it succeed?"*

## What it will and will not tell you

- **Read-only.** No tool creates, changes, deploys or deletes anything.
- **One account.** Everyone who can reach this server sees what `NDFC_USERNAME` sees.
- **Secrets stay on the controller.** Secret fabric settings come back as `[redacted]` (it means
  *a value is set*). Free-form configuration text is omitted. The rendered device configuration
  of a policy and the command text of a deployment are never returned: they contain password
  hashes. You get "renders configuration: yes/no" and command counts instead.
- **Long answers are cut by rows, never mid-row,** and say so: `truncated`, how many rows of how
  many, and which filter narrows the list (`nameContains`, `templateContains`, `severity`, …).
- **An error is an error.** A controller that is down, still starting or unreachable produces an
  error result that says there is no data — not an empty list.

## The VPN sidecar

`compose.yaml` runs two containers. `vpn` runs [OpenConnect](https://www.infradead.org/openconnect/),
the open-source client for Cisco AnyConnect gateways, and owns the tunnel. `ndfc-mcp` shares
`vpn`'s network namespace, so it reaches the controller through the tunnel and is otherwise an
unprivileged, read-only container. Only `vpn` holds extra privileges (`NET_ADMIN` and
`/dev/net/tun`), and the tunnel exists only inside these two containers: routes, DNS and any VPN
on the host are untouched, so you can stay connected to your own network while the server talks
to the fabric.

| Setting | When |
| --- | --- |
| `VPN_PROTOCOL` | Not AnyConnect: `gp` (GlobalProtect), `pulse`, `fortinet`, `nc`, `f5` |
| `VPN_AUTHGROUP` | The gateway asks for a group / tunnel-group |
| `VPN_SERVERCERT` | The gateway's certificate is private. OpenConnect refuses it and prints the `pin-sha256:…` value to put here |
| `VPN_EXTRA_ARGS` | Any other OpenConnect argument |
| `VPN_HEALTH_URL` | Also require this URL to answer through the tunnel before the server starts, e.g. `https://10.10.20.60/version.json` |

`docker compose logs vpn` shows each connection attempt and OpenConnect's own messages. The
sidecar reconnects by itself when a session ends. A gateway that needs a second factor typed
interactively cannot be automated this way; use your own VPN client and `compose.direct.yaml`.

## The controller's certificate

Nexus Dashboard serves a certificate issued by its own private CA, so it is not trusted by
default. `.env.example` starts with `NDFC_TLS_INSECURE=true`, which skips the check — fine for a
lab, and the server says so in its log and in `/healthz`. For anything else, pin the CA:

```bash
docker compose exec -T ndfc-mcp node /app/pin-ca.mjs
```

It prints the certificate's subject, expiry and SHA-256 fingerprint, and one line starting
`NDFC_TLS_CA_PEM=`. Put that line in `.env`, delete `NDFC_TLS_INSECURE`, and run
`docker compose up -d`. `/healthz` then reports `"controllerTls":"pin"`.

## Day to day

```bash
docker compose ps                     # are both healthy?
docker compose logs -f ndfc-mcp       # one line per tool call: tool, outcome, ms, bytes
docker compose logs -f vpn            # the tunnel
docker compose up -d --build          # after changing .env or pulling new code
docker compose down                   # stop; the tunnel closes with it
```

## Troubleshooting

| You see | It means | Do |
| --- | --- | --- |
| `set VPN_SERVER in .env …` when starting | A required setting is empty | Fill it in `.env` |
| `vpn` stays `starting` / `unhealthy` | The tunnel did not come up | `docker compose logs vpn`: wrong gateway, login, group, or a certificate to pin (`VPN_SERVERCERT`) |
| `ndfc-mcp` never starts | It waits for `vpn` to be healthy | Fix the VPN first |
| Tool error `upstream_unreachable` / `upstream_timeout` | The server cannot reach `NDFC_URL` | VPN up? Right address? `docker compose exec vpn curl -sk https://<controller>/version.json` |
| Tool error `upstream_tls` | The controller's certificate was not accepted | See [The controller's certificate](#the-controllers-certificate) |
| Tool error `controller_login_failed` | The controller refused `NDFC_USERNAME` / `NDFC_PASSWORD` | Check them; a local account uses login domain `DefaultAuth` (`NDFC_LOGIN_DOMAIN` to change it) |
| Tool error `controller_error`, HTTP 500, "There was a problem proxying the request" | Nexus Dashboard is up but its Fabric Controller service is not (yet) | Wait; on a DevNet sandbox that stays this way, end the reservation and take a new one |
| Client shows the server as failed, HTTP 401 | The API key the client sends is not the one in `.env` | Re-add the server; restart it after changing the key |
| HTTP 403 | The request carried an `Origin` header (it came from a web page) | Call it from an MCP client, not a browser |
| `truncated: true` in an answer | The list did not fit one tool result | Ask again with the filter the answer names |

## Tests

```bash
node test/verify-local.mjs    # 174 checks against a stub controller; no network, no credentials
node test/live-check.mjs      # every tool against the real controller in .env (run where node can reach it)
```

Both need only Node.js 20 or later; the server has no npm dependencies.

## Status

Version 0.2.0. Verified on 2026-11-12 against the DevNet sandbox (NDFC 12.2.2 on Nexus Dashboard
3.2): all twelve tools, both transports with Claude Code, the image run read-only without
capabilities, and the CA pin. **Not yet verified:** the VPN sidecar against a real gateway (its
refusals and retry loop are tested; an actual AnyConnect login is not), Claude Desktop, and the
aimo extension — the configuration follows each client's documented format. `list_vrfs` and
`list_networks` have only seen empty lists, because the sandbox fabric defines none.

`spec/` holds Cisco's OpenAPI document for NDFC 12.2.2 (Apache 2.0), which the tests hold the
tools to.
