# ndfc-mcp

An [MCP](https://modelcontextprotocol.io) server for **Cisco Nexus Dashboard Fabric Controller
(NDFC)**. It lets an AI assistant — Claude Code, Claude Desktop, aimo for VS Code — answer
questions about your data-center fabric: which fabrics exist, which switches are in them and
whether they are in sync, what an interface is doing, what is alarming, what was deployed. Given
write access, it can also create, attach, deploy and delete VRFs and overlay networks.

It runs on your own machine with Docker Compose and **brings its own VPN**: a sidecar container
opens the Cisco AnyConnect tunnel to the controller's network, so your laptop's own network and
VPN stay as they are.

**It is read-only unless you say otherwise.** As it starts by default, every tool is a `GET`
and the server cannot send a change to the controller. [Write access](#write-access) is one
setting, and who may use it is decided per person when the server runs behind a gateway.

## The tools

These are always there, and none of them changes anything:

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
| `list_vrf_attachments`, `list_network_attachments` | Which switches a VRF or network is attached to, and its state on each (`NA`, `PENDING`, `DEPLOYED`, …) |
| `list_alarms` | What is alarming, where, since when |
| `list_deploy_history` | What the controller deployed, to which switch, with what outcome; newest first, at most 200 rows from the controller, so name the switch |

Start with `list_fabrics` (it gives the fabric names the others take) and `list_switches` (it
gives the serial numbers).

With [write access](#write-access) turned on, these are offered as well:

| Tool | Does |
| --- | --- |
| `create_vrf`, `delete_vrf` | Creates or deletes a VRF on the controller |
| `create_network`, `delete_network` | Creates or deletes an overlay network (routed in a VRF, or layer 2 only) |
| `attach_vrf`, `detach_vrf` | Attaches a VRF to one switch, or detaches it |
| `attach_network`, `detach_network` | Attaches a network to one switch and its ports, or detaches it |
| `deploy_vrf`, `deploy_network` | **Configures switches:** pushes the pending changes of one VRF or network |
| `recalculate_fabric_config` | NDFC's *Recalculate Config* for one fabric |
| `deploy_fabric_config` | **Configures switches:** NDFC's *Deploy Config* for one fabric |

## What you need

- **Docker** with Compose v2 (Docker Desktop on macOS/Windows, Docker Engine on Linux). On
  Windows, see [On Windows](#on-windows) for the commands.
- **A controller** — Nexus Dashboard with the Fabric Controller service — and an account on it.
  A read-only account (role `network-operator`) is all a read-only server needs. With write
  access the account needs a role that may write (`network-admin`).
- **The VPN details** for the controller's network, as you would type them into Cisco
  AnyConnect / Secure Client: gateway (`host` or `host:port`), username, password.

No controller of your own? Cisco's free DevNet sandbox
[*vNexus Dashboard Fabric Controller*](https://developer.cisco.com/sandbox/detail/vnexus-dashboard-sandbox)
gives you one for a few hours. Reserve it; its page lists the controller login under
**Access details** (row `ndfc`) and the VPN gateway and login under **VPN access**.

## Start it

The quick way — one command after cloning, which asks its questions right away:

```bash
cd ndfc-mcp
./setup            # or: ./setup --yes   to take every default without asking
```

It needs Docker and Node 18 or newer on this machine. It asks how the controller is reached (the
VPN sidecar or directly), the controller and VPN logins, the certificate mode, the API key, the
port, and whether the server may only read or also write (read only, unless you choose
otherwise). Every answer comes pre-filled, so Enter keeps it. Then it writes `.env`, builds and
starts the containers, and checks that the controller answers through the server. Last, it
registers the server with **Claude Code** (`.mcp.json` here, or user/local scope through the
`claude` CLI), **Claude Desktop** and **aimo for VS Code**. It changes only the `ndfc` entry in
each client file and keeps a `.bak-<time>` copy beside it. Passwords are typed hidden and never
printed. Run it again whenever a value changes: a new DevNet reservation brings a new VPN login.

The defaults come from `defaults.env`, which is **committed on purpose**. It holds the values
this project runs with, including the lab's API key, the controller login and the VPN login.
Anyone who can read the repository can read them, so never put a production controller's
credentials in it. A `.env` already in the checkout takes precedence over it.

The manual way:

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
`NDFC_MCP_ACCESS=write` is the fourth, optional one: see [Write access](#write-access).

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

The same file serves a controller that the host reaches only through a **local port forward**,
for example one opened through an SSH or SOCKS proxy to the controller's network. Point
`NDFC_URL` at the forward as the container sees it, `https://host.docker.internal:<port>`, and
keep `NDFC_TLS_INSECURE=true` or a pinned CA: the certificate does not name that address. (Seen
working with Docker Desktop on macOS, 2026-11-14.)

### On Windows

Everything above works on Windows with **Docker Desktop** (Linux containers, the WSL 2 backend)
and **Node 18 or newer**. The containers are the same Linux images; only the commands you type
differ. In PowerShell or cmd:

```powershell
cd ndfc-mcp
.\setup                 # or: .\setup --yes
bin\client-config       # or: bin\client-config direct
```

`setup.cmd` and `bin\client-config.cmd` start the same two Node scripts that macOS and Linux
start through their shebang. Type the leading `.\` for `setup`. In Git Bash, `./setup` and
`bin/client-config` work as they do on macOS.

`bin\client-config` prints Windows paths, and its two `claude mcp add` lines are written for
PowerShell. Copy them from there instead of from this page: the examples under
[Connect a client](#connect-a-client) are for a POSIX shell.

The manual way, in PowerShell:

```powershell
Copy-Item .env.example .env
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"   # a value for NDFC_MCP_API_KEY
docker compose up -d --build
curl.exe -s http://127.0.0.1:3300/healthz
'{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"get_controller_info","arguments":{}}}' | docker compose exec -T ndfc-mcp node /app/stdio.mjs
```

Write `curl.exe`: in Windows PowerShell, plain `curl` is a different command.

Clone with Git and the line endings take care of themselves (`.gitattributes` keeps the shell
scripts LF). A ZIP download or a clone older than that file has CRLF scripts; the `vpn` image
strips them when it is built, so `docker compose up -d --build` is enough.

Windows has no `chmod 600`: `.env` is protected by the permissions of your user folder, so keep
the checkout inside it.

## Connect a client

`./setup` does this for you (see [Start it](#start-it)). To do it by hand, `bin/client-config`
prints everything below with the real paths of **your** checkout filled in, ready to paste. Run it
once and copy the block for your client.

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

Start a new session and type `/mcp`: `ndfc` should show **Connected** with 14 tools (26 with
write access). Add
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
first runs, aimo shows the exact command and asks; after that its read tools run without a
prompt, because each is marked read-only. The write tools are not, and the ones that delete,
detach or deploy are marked destructive, so a client that asks before a change asks before each.

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

[PROMPTS.md](PROMPTS.md) has thirteen longer ones that combine several tools — rebuilding the
topology as a diagram, triaging alarms, investigating out-of-sync switches, auditing the underlay
addressing — with what the first four found on the sandbox.

## What it will and will not tell you

- **Read-only by default.** Unless `NDFC_MCP_ACCESS=write` is set, no tool creates, changes,
  deploys or deletes anything, and the server has no way to send a change.
- **One account.** Everyone who can reach this server sees what `NDFC_USERNAME` sees, and with
  write access changes the controller as that account.
- **Secrets stay on the controller.** Secret fabric settings come back as `[redacted]` (it means
  *a value is set*). Free-form configuration text is omitted. The rendered device configuration
  of a policy and the command text of a deployment are never returned: they contain password
  hashes. You get "renders configuration: yes/no" and command counts instead.
- **Long answers are cut by rows, never mid-row,** and say so: `truncated`, how many rows of how
  many, and which filter narrows the list (`nameContains`, `templateContains`, `severity`, …).
- **An error is an error.** A controller that is down, still starting or unreachable produces an
  error result that says there is no data — not an empty list.

## Write access

Set `NDFC_MCP_ACCESS=write` in `.env` (or answer *Read and write* in `./setup`) and run
`docker compose up -d`. `/healthz` then reports `"access":"write"`, the twelve write tools are
listed, and the server's instructions tell the model how to use them. Remove the line and the
server is read-only again: the write tools are gone and a call to one is an unknown tool.

What a change is, here:

- **Intent first, switches second.** `create_*`, `attach_*` and `detach_*` change the
  controller only; the object or attachment becomes `PENDING`. Nothing reaches a switch until a
  `deploy_*` tool runs. The usual order is create → attach → deploy, and to remove: detach →
  deploy → delete. The controller refuses a delete while something is attached, deployed or
  waiting for a deployment, and says why.
- **Names and numbers, never configuration text.** A write tool takes a fabric, a name, a VNI, a
  VLAN, a gateway address, switch ports and a plain-text description. It takes no template name,
  no free-form configuration and no raw request body, and every string is held to a pattern that
  admits no newline, quote or command separator. Each tool sends one change to one route. Some
  read first: a create reads the template's default values from the controller and sends them
  under its own (without them the switch gets the template's placeholders, such as
  `ip address 192.0.2.1/24 tag $$tag$$`, and refuses the gateway), and without an id it reads
  the controller's next free one; taking ports out of a network reads its attachment, because
  that request sent for a switch the network is not on would attach it there. `default`,
  `management` and `NA` are refused as VRF names.
- **Only these routes.** The controller documents 385 write operations; this server can send
  the ten its tools declare. Policies, interfaces, templates, switch discovery, credentials and
  every bulk or import route are out of reach.
- **Every change is in the log** with who asked and what for, twice: a `tool call started` line
  before it is sent, and the outcome,
  `tool=create_vrf user=local access=write args="{…}" outcome=ok`. A container stopped while a
  change is at the controller waits for the answer (up to two minutes) and says so in the log.
- **An error says whether anything changed.** A refusal by the controller is
  `controller_refused_change` with its reason and "nothing was changed"; so is a failure before
  the change was sent (the login, the connection, a read the tool makes first). A change that
  was sent and whose answer did not arrive or was not the controller's (a timeout, a cut
  connection, a redirect, a page of HTML) is `write_outcome_unknown`: it may or may not have
  been applied, so the state is read before anything is tried again. An attach that the
  controller saved for one switch and refused for another is `write_partly_applied`. A write is
  never repeated on its own.
- **A deploy result says `accepted`, not `changed`, and then how the switches ended.** The
  controller answers a deployment when it has taken the request. `deploy_vrf` and
  `deploy_network` then read the object's attachments every 3 s until no switch is `PENDING` or
  `IN PROGRESS` (`waitSeconds`, default 60, at most 90; 0 does not wait) and return each
  switch's state as `outcome`, with `settled: false` and the busy switches when the wait ran
  out. Deploy one object at a time: on the sandbox (2026-11-14), three networks deployed one
  right after another left one of them `OUT-OF-SYNC`, its `member vni` line on `nve1` never
  sent. The commands' outcomes are in `list_deploy_history`.
- **The last network takes its VRF along.** On the sandbox, a deployment that removed the last
  network of a VRF from a switch removed the VRF there too (`no vrf context …`), and a
  `detach_vrf` after it was refused: *is already in detached state*.

In local mode, the mode you get on your own machine, whoever holds the API key may use the write
tools. Deploying configures switches in a running network: give the server write access on a
controller where you would make the same change by hand.

### Behind a gateway: read or write, per person

When the server runs behind a gateway that signs people in (`NDFC_MCP_MODE=gateway`; the
gateway forwards a signed statement of who is calling), write access is given **per person**:

```bash
NDFC_MCP_MODE=gateway
NDFC_MCP_SLUG=ndfc                              # the audience every assertion must carry
NDFC_MCP_CP_URL=https://gateway.example.net     # where the assertion's public key is fetched
NDFC_MCP_ACCESS=write
NDFC_MCP_ADMIN_EMAILS=first.admin@example.net   # who may hand out write access
NDFC_MCP_DATA_DIR=/data                         # where the grants are kept (a volume)
```

Everyone the gateway lets through can read. A person can write only when an administrator has
granted it, and the administrators are the addresses in `NDFC_MCP_ADMIN_EMAILS` plus anyone they
make one. Three more tools, for administrators only, manage this, and a gateway's dashboard can
call them:

| Tool | Does |
| --- | --- |
| `grant_list` | Who holds which role, administrators and writers first (`role` and `emailContains` narrow it); everyone else reads |
| `grant_set` | Gives one person `read`, `write` or `admin` |
| `grant_revoke` | Removes a person's grant, which leaves them with read |

A person without the role who calls a write tool gets `write_not_allowed` and nothing happens.
Grants are kept in `grants.json` under `NDFC_MCP_DATA_DIR`, with every change in
`changelog.ndjson` beside it (who made it, by address and by the subject of their sign-in);
neither holds a secret. With `NDFC_MCP_ACCESS` left at `read`, a gateway-mode server is
read-only for everyone, whatever was granted. A few rules of the grant file:

- The address is compared as the gateway sends it, lower-cased. An address with a stray space
  or a look-alike letter is nobody.
- The file is read again whenever it changes, so an edit by hand takes effect on the next call
  and is not overwritten. An entry that is not an address with a role is ignored, and
  `/healthz` counts it (`ignoredEntries`).
- A file that cannot be read suspends every grant. `/healthz` and `grant_list` say so,
  `grant_revoke` refuses, and `grant_set` keeps the unreadable file as
  `grants.json.unreadable-<time>` and starts a new one.
- A person named in `NDFC_MCP_ADMIN_EMAILS` stays an administrator whatever is granted. If
  they also hold a stored grant, `grant_list` shows it and `grant_revoke` removes it, so that
  taking them out of the setting leaves them with read.

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
| `failed to connect to the docker API at npipe:////./pipe/docker_engine` (Windows) | Docker Desktop is installed but not running | Start Docker Desktop, wait for it to say it is running, run the command again |
| `vpn` stays `starting` / `unhealthy`, or `dependency failed to start: container ndfc-mcp-vpn-1 is unhealthy` | The tunnel did not come up | `docker compose logs vpn`: wrong gateway, login, group, or a certificate to pin (`VPN_SERVERCERT`). `Login failed.` is the gateway refusing the VPN login: a DevNet reservation that ended takes its login with it, so run `setup` again with the new one |
| `ndfc-mcp` never starts | It waits for `vpn` to be healthy | Fix the VPN first |
| Tool error `upstream_unreachable` / `upstream_timeout` | The server cannot reach `NDFC_URL` | VPN up? Right address? `docker compose exec vpn curl -sk https://<controller>/version.json` |
| Tool error `upstream_tls` | The controller's certificate was not accepted | See [The controller's certificate](#the-controllers-certificate) |
| Tool error `controller_login_failed` | The controller refused `NDFC_USERNAME` / `NDFC_PASSWORD` | Check them; a local account uses login domain `DefaultAuth` (`NDFC_LOGIN_DOMAIN` to change it) |
| Tool error `controller_error`, HTTP 500, "There was a problem proxying the request" | Nexus Dashboard is up but its Fabric Controller service is not (yet) | Wait; on a DevNet sandbox that stays this way, end the reservation and take a new one |
| Client shows the server as failed, HTTP 401 | The API key the client sends is not the one in `.env` | Re-add the server; restart it after changing the key |
| HTTP 403 | The request carried an `Origin` header (it came from a web page) | Call it from an MCP client, not a browser |
| `truncated: true` in an answer | The list did not fit one tool result | Ask again with the filter the answer names |
| `unknown tool: create_vrf` (or another write tool) | The server is read-only | Set `NDFC_MCP_ACCESS=write`; see [Write access](#write-access) |
| A client still lists only the read tools after `NDFC_MCP_ACCESS=write` (aimo's Tool Servers shows every tool as `read-only`) | The client is showing the tool list it stored when the server was read-only | Over stdio the server announces its tool list at every start, so use the server once from a chat (any question that calls it) and the list is read again. An HTTP client reads the list when it reconnects |
| Tool error `write_not_allowed` | Behind a gateway: the caller has no write grant | An administrator runs `grant_set` for them |
| Tool error `controller_refused_change` | The controller refused the change; nothing changed | The message is the controller's reason: the object exists, is still attached, is under deployment, or the switch cannot take it |
| Tool error `controller_refused`, HTTP 403, on a write | The controller account may not write | Give `NDFC_USERNAME` a role that may (`network-admin`) |
| Tool error `write_outcome_unknown` | A change was sent and its answer did not arrive within `NDFC_WRITE_TIMEOUT_MS` (90 s), or the connection broke, or the answer was not the controller's | Read the state (`list_vrf_attachments`, `list_deploy_history`) before retrying. A deployment to a switch the controller cannot reach does this, and so can `deploy_fabric_config` on a fabric whose switches were all just reset: on the sandbox (2026-11-14) it ran past 90 s and finished on its own two minutes later |
| An attachment is `OUT-OF-SYNC` after several networks were deployed one right after another | A deployment sent while another was still running on the same switch: on the sandbox (2026-11-14) the later network's `member vni` line on `nve1` was never sent | Deploy one object at a time, the next only when the previous one's `outcome.settled` is true (the deploy tools wait for it). `recalculate_fabric_config` and `deploy_fabric_config` brought the switch back in sync |
| Tool error `write_partly_applied` | The controller saved an attach or detach for one switch and refused it for another | The message names both. Read `list_vrf_attachments` or `list_network_attachments` before a deploy |
| The VPN connects and drops every 10 to 15 seconds (`Internal Error` in `docker compose logs vpn`) | Another client is signed in with the same VPN login: some gateways, the DevNet sandbox's among them, keep one session per login, and the two knock each other off | Stop the other client (another copy of this stack, a VPN app, another machine), or use a second login |
| `Delete is not allowed as the Network is under a Deployment operation` | A detach is still `PENDING` | Deploy it first; while the switch is unreachable the controller keeps the object |

## Tests

```bash
node test/verify-local.mjs    # 350 checks against a stub controller; no network, no credentials
node test/live-check.mjs      # every read tool against the real controller in .env (run where node can reach it)
node test/live-check.mjs --write            # also the roles, and a VRF and a network created and deleted
node test/live-check.mjs --write --deploy   # also attached to a leaf, deployed, detached, deployed
```

Both need only Node.js 20 or later; the server has no npm dependencies. The live check needs
the controller reachable from where node runs. When only the VPN sidecar reaches it, run the
check inside the stack's network instead of opening a second VPN session:

```bash
docker run --rm --network container:ndfc-mcp-vpn-1 -v "$PWD":/src:ro --entrypoint node \
  ndfc-mcp:local /src/test/live-check.mjs --env /src/.env
```
 Without `--write` the
live check changes nothing. `--write` creates `MCPCHK_VRF` and `MCPCHK_NET` and deletes them
again; `--deploy` configures one leaf and is skipped when the controller does not reach it. A
run that stops half way removes what it made before it exits, and says what it could not
remove. Run those two against a lab. `--url <origin>` replaces the controller address, for a port forward.

## Status

Version 0.3.1. Version 0.2.0 was verified on 2026-11-12 against the DevNet sandbox (NDFC 12.2.2
on Nexus Dashboard 3.2): the twelve read tools it had, both transports with Claude Code, the
image run read-only without capabilities, the CA pin, and the VPN sidecar — it logged in to the
sandbox's AnyConnect gateway (group `SSLClient`, DTLS), took the split-tunnel routes, and the
server answered through it over HTTP and stdio. **Not yet verified:** Claude Desktop, and a
gateway other than the sandbox's.

Write access (0.3.0) was verified on 2026-11-14 against a new reservation of the same sandbox,
reached through a port forward: `live-check.mjs` read-only (29 checks, CA pinned, no write
sent) and with `--write` (the roles, then a VRF and a network created, read back and deleted,
the controller left as it was). The attach, detach, recalculate and deploy tools were called
through the server and the image, over HTTP and stdio. **Not verified: a deployment that
succeeds.** The sandbox's switches were still starting, so the controller reached none of the
leaves; `deploy_network` ended as `write_outcome_unknown`, and the `--deploy` cycle skipped
itself. The answer of a successful `deploy_*` or `deploy_fabric_config` is therefore taken from
Cisco's API document, not seen. No MCP client was driven with the write tools, and the server
was not run behind a real gateway: the grants were exercised with assertions signed by the tests.

0.3.1 (2026-11-14) fixes what an independent review of 0.3.0 found, none of it rated high: how
an error tells "not sent" from "outcome unknown", a request that could stop the server, the
ports-only detach, the grant file's edge cases, hidden text in results. It was verified the
same day with the compose stack and its VPN sidecar in write mode: a VRF created, read back
and deleted over HTTP, the same by Claude Code as the MCP client over stdio, and
`live-check.mjs --write` all passing with the CA pinned.

Later the same day, with the sandbox's switches rebuilt and reachable, **deployments were seen
succeed**: a fabric recalculate and deploy, then nineteen prompts run by Claude Code over stdio,
each in a new conversation (VRFs and networks created, attached to two leaves and the border
with ports, deployed, a port moved between leaves, everything detached, deployed and deleted;
six refusals). They found three faults, fixed in 0.3.1 before the final run: a create left the
template's defaults out (the switches refused `ip address … tag $$tag$$`), the deployment
history returned the controller's oldest rows, and deployments sent back to back left a switch
out of sync, which is why the deploy tools now wait for the switches. Harness 350/350. **Still
not verified:** a real gateway.

On Windows 11 with Docker Desktop (same day): the 175 checks pass, and `.\setup` built and
started the server without the sidecar, saw it healthy, and reached it over HTTP and over stdio
through `docker compose exec`. With the sidecar, the `vpn` container reached the sandbox gateway,
which refused the login of a reservation that had ended. So **a tunnel that comes up, and a real
controller behind it, have not been seen from Windows.**

`spec/` holds Cisco's OpenAPI document for NDFC 12.2.2 (Apache 2.0), which the tests hold the
tools to.
