/**
 * ndfc-mcp — Cisco Nexus Dashboard Fabric Controller tools, served as a
 * stateless MCP server: streamable HTTP, protocol 2025-06-18, plain JSON
 * responses, no sessions. stdio.mjs is the same server for clients that speak
 * MCP over stdin/stdout.
 *
 * What it is: read tools and write tools over one controller's REST API
 * (tools.mjs), a controller client that sends only declared endpoints
 * (ndfc.mjs), and this plumbing.
 *
 * READ-ONLY UNLESS CONFIGURED OTHERWISE. NDFC_MCP_ACCESS is the server's
 * ceiling. `read` (the default): the write tools are not listed, cannot be
 * called, and the controller client is built with no write route at all — the
 * server changes nothing, by construction. `write`: the write tools are
 * offered, and each call needs a caller who holds the write role (grants.mjs):
 * in local mode that is the one person running the container; in gateway mode
 * it is a person an administrator granted it to.
 *
 * Who may call it (auth.mjs):
 *   - Every request carries the API key (X-Api-Key, or a bearer token). No
 *     key, no answer — discovery included.
 *   - local mode (default): the key is everything; calls are logged as "local".
 *   - gateway mode: `tools/call` also needs a verified user assertion from the
 *     gateway in front. `initialize` and `tools/list` need no person; an
 *     assertion that IS present is verified on every method, and a bad one is
 *     401 — a presented credential that fails is never ignored.
 *
 * The server uses ONE account on the controller (NDFC_USERNAME), so everyone
 * who can call it sees what that account sees, and a caller with the write role
 * changes the controller as that account. Give a read-only server a read-only
 * account.
 *
 * Env — required: NDFC_MCP_API_KEY, NDFC_URL, NDFC_USERNAME, NDFC_PASSWORD.
 * Optional: NDFC_MCP_PORT (3300), NDFC_LOGIN_DOMAIN (DefaultAuth),
 *   NDFC_TLS_CA_PEM | NDFC_TLS_INSECURE, NDFC_TIMEOUT_MS (20000),
 *   NDFC_MCP_RESULT_BUDGET_BYTES (26000), NDFC_MCP_MODE (local | gateway) and,
 *   for gateway mode, NDFC_MCP_SLUG plus one assertion verifier (auth.mjs).
 *   NDFC_MCP_ACCESS (read | write), NDFC_WRITE_TIMEOUT_MS (90000) and, for
 *   gateway mode under write, NDFC_MCP_ADMIN_EMAILS and NDFC_MCP_DATA_DIR
 *   (grants.mjs).
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AuthError, apiKeyOk, createAssertionVerifier, loadAuthConfig, presentedApiKey } from "./auth.mjs";
import { GRANT_TOOLS, createGrantStore, loadAccessConfig, roleAllows } from "./grants.mjs";
import { createNdfcClient, loadNdfcConfig } from "./ndfc.mjs";
import {
  READ_TOOLS,
  RESULT_BUDGET_BYTES,
  ToolError,
  WRITE_ENDPOINTS,
  WRITE_TOOLS,
  accessOf,
  createRateLimiter,
  encodeToolError,
  encodeToolResult,
  endpointsOf,
  instructionsFor,
  toolError,
  validateArgs,
} from "./tools.mjs";

const PROTOCOL_VERSION = "2025-06-18";
// A later request names the revision it negotiated. These are the revisions
// whose tools/call shape this server answers; anything else is a 400.
const KNOWN_PROTOCOL_VERSIONS = new Set(["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"]);
export const SERVER_INFO = { name: "ndfc-mcp", version: "0.3.1" };
const MAX_BODY_BYTES = 1024 * 1024;

/** Read every setting; returns { config, missing[] }. Nothing has a default that could be wrong. */
export function loadConfig(env = process.env) {
  const auth = loadAuthConfig(env);
  const ndfc = loadNdfcConfig(env);
  const access = loadAccessConfig(env, auth.config.mode);
  const missing = [...auth.missing, ...ndfc.missing, ...access.missing];
  const port = Number.parseInt(env.NDFC_MCP_PORT || "3300", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) missing.push("NDFC_MCP_PORT is not a port number");
  const budgetBytes = Number.parseInt(env.NDFC_MCP_RESULT_BUDGET_BYTES || String(RESULT_BUDGET_BYTES), 10);
  if (!Number.isInteger(budgetBytes) || budgetBytes < 2000 || budgetBytes > 900_000) missing.push("NDFC_MCP_RESULT_BUDGET_BYTES must be between 2000 and 900000");
  return { missing, config: { port, budgetBytes, auth: auth.config, ndfc: ndfc.config, access: access.config } };
}

/**
 * The tools this server offers, decided once from its configuration:
 * the read tools always; the write tools under a write ceiling; the grant
 * tools where there are grants to manage (gateway mode under a write ceiling).
 */
export function offeredTools(config) {
  const writing = config.access.access === "write";
  return [...READ_TOOLS, ...(writing ? WRITE_TOOLS : []), ...(writing && config.auth.mode === "gateway" ? GRANT_TOOLS : [])];
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    let chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) return void chunks.push(chunk);
      // Over the cap: stop keeping it, but keep READING, so the caller can be
      // answered 413 instead of seeing its socket reset mid-upload. A body
      // many times the cap is not a mistake; that one is cut off.
      tooLarge = true;
      chunks = [];
      if (size > 8 * MAX_BODY_BYTES) req.destroy();
    });
    req.on("end", () => (tooLarge ? reject(new Error("body too large")) : resolve(Buffer.concat(chunks).toString("utf-8"))));
    req.on("error", reject);
  });
}

function send(res, status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(text);
}

const rpcError = (res, id, code, message, httpStatus = 200) => send(res, httpStatus, { jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const rpcResult = (res, id, result) => send(res, 200, { jsonrpc: "2.0", id, result });

/**
 * Build the HTTP server. `deps` lets the offline harness inject a clock, a
 * fetch for the assertion-key path and its own limiter sizes; production
 * passes nothing.
 */
export function createServer(config, deps = {}) {
  const gateway = config.auth.mode === "gateway";
  const verifyAssertion = gateway ? deps.verifyAssertion || createAssertionVerifier(config.auth, deps) : null;
  const writing = config.access.access === "write";
  const tools = offeredTools(config);
  // A read-only server builds a client with no write route: it cannot change
  // the controller whatever reaches tools/call.
  const ndfc = deps.ndfc || createNdfcClient(config.ndfc, { ...deps, writeEndpoints: writing ? WRITE_ENDPOINTS : [] });
  const grants = writing && gateway ? deps.grants || createGrantStore({ dataDir: config.access.dataDir, adminEmails: config.access.adminEmails, now: deps.now }) : null;
  /** The caller's role: the ceiling itself in local mode, the person's grant in gateway mode. Never above the ceiling. */
  const roleOf = (user) => (!writing ? "read" : gateway ? grants.roleOf(user.email) : "write");
  const instructions = instructionsFor({ writing });
  // Per caller, and across all callers: every call is a request to a network
  // controller that has better things to do than serve a tool loop.
  const perUser = createRateLimiter({ capacity: 30, refillPerSecond: 1, ...(deps.userLimit || {}) });
  const perService = createRateLimiter({ capacity: 120, refillPerSecond: 4, ...(deps.serviceLimit || {}) });
  const log = deps.log || ((line) => console.log(line));
  // An exception that is not a ToolError is a bug here, not an answer: it is
  // logged with its stack and the caller gets a generic tool_failed.
  const onUnexpected = deps.onUnexpected || ((e) => console.error('level=error msg="unexpected tool error"', e));
  // Changes whose handler is running: what a shutdown has to wait for, and say.
  const inFlight = new Set();

  async function handle(req, res) {
    let url;
    try {
      url = new URL(req.url, "http://localhost");
    } catch {
      // "GET //" is not a URL. It is a bad request, never a crashed server.
      return send(res, 400, { error: "bad request" });
    }

    // Independent of the controller on purpose: a controller or VPN outage
    // must surface as tool errors, not as a restarting container.
    if (req.method === "GET" && url.pathname === "/healthz") {
      return send(res, 200, {
        ok: true,
        server: SERVER_INFO.name,
        version: SERVER_INFO.version,
        tools: tools.length,
        mode: config.auth.mode,
        access: config.access.access,
        ...(grants ? { grants: grants.stats() } : {}),
        controllerHost: config.ndfc.host,
        controllerTls: config.ndfc.tlsMode,
        ...(gateway ? { assertionAlg: config.auth.alg } : {}),
        controller: ndfc.stats ? ndfc.stats() : null,
      });
    }

    if (!["/", "/mcp"].includes(url.pathname)) return send(res, 404, { error: "not found" });

    // The API key, before any method — discovery included.
    if (!apiKeyOk(presentedApiKey(req.headers), config.auth.apiKey)) {
      return send(res, 401, { error: "unauthorized", message: "Send the server's API key in the X-Api-Key header." });
    }

    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" });
      return res.end();
    }

    // MCP clients are programs, not pages: a request that carries an Origin
    // came from a browser, and a browser has no business here (DNS rebinding).
    if (req.headers.origin) return send(res, 403, { error: "forbidden", message: "Cross-origin requests are not accepted." });

    const proto = req.headers["mcp-protocol-version"];
    if (proto !== undefined && !KNOWN_PROTOCOL_VERSIONS.has(String(proto))) {
      return rpcError(res, null, -32600, `unsupported MCP-Protocol-Version: ${String(proto).slice(0, 32)}`, 400);
    }

    let message;
    try {
      message = JSON.parse((await readBody(req)) || "null");
    } catch (error) {
      if (error.message === "body too large") return send(res, 413, { error: "payload too large" });
      return rpcError(res, null, -32700, "parse error");
    }
    // One message per request. A gateway scans and audits per call; a batch
    // would slip past it.
    if (Array.isArray(message)) return rpcError(res, null, -32600, "batch requests are not supported");
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return rpcError(res, message?.id, -32600, "invalid JSON-RPC request");
    }

    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;

    // Who is calling. Local mode: the holder of the key. Gateway mode: the
    // person the gateway vouches for — verified on EVERY method on which an
    // assertion is present.
    let user = gateway ? null : { userId: "local" };
    const assertion = req.headers["x-gpupool-user-assertion"];
    if (assertion !== undefined) {
      if (!gateway) {
        log(`level=warn msg="user assertion refused: this server runs in local mode and cannot verify one" method=${method}`);
        return rpcError(res, id, -32001, "this server runs in local mode and does not accept a user assertion", 401);
      }
      try {
        user = await verifyAssertion(Array.isArray(assertion) ? assertion[0] : assertion);
      } catch (error) {
        if (!(error instanceof AuthError)) console.error('level=error msg="assertion verification crashed"', error);
        log(`level=warn msg="assertion rejected" method=${method} reason=${JSON.stringify(error instanceof AuthError ? error.message : "internal")}`);
        return rpcError(res, id, -32001, "the user assertion could not be verified", 401);
      }
    }

    try {
      switch (method) {
        case "initialize":
          return rpcResult(res, id, {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
            instructions,
          });

        case "notifications/initialized":
        case "notifications/cancelled":
          res.writeHead(202);
          return res.end();

        case "ping":
          return rpcResult(res, id, {});

        case "tools/list":
          return rpcResult(res, id, {
            tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations })),
          });

        case "tools/call": {
          // A tool this server does not offer does not exist here: on a read-only
          // server `create_vrf` is as unknown as `no_such_tool`.
          const tool = tools.find((t) => t.name === params?.name);
          if (!tool) return rpcError(res, id, -32602, `unknown tool: ${String(params?.name).slice(0, 64)}`);
          const args = params?.arguments ?? {};
          const need = accessOf(tool);
          const changes = need !== "read";
          const envelope = (result) => ({ jsonrpc: "2.0", id, result });
          const started = Date.now();
          let validated = false;
          // Set when the handler hands THE write to the controller client. A
          // failure before that cannot have changed the controller.
          let writeAttempted = false;
          let flight = null;
          // A change is logged with what was asked for — once its arguments
          // have passed validation, which is what makes them names and
          // numbers and never something a caller pasted by mistake.
          const what = () => (changes ? ` access=${need}${validated ? ` args=${JSON.stringify(JSON.stringify(args)).slice(0, 600)}` : ""}` : "");
          const done = (body, outcome) => {
            if (flight) inFlight.delete(flight);
            log(`level=info msg="tool call" tool=${tool.name} user=${user ? user.userId : "-"}${what()} outcome=${outcome} ms=${Date.now() - started} bytes=${Buffer.byteLength(body)}`);
            return send(res, 200, body);
          };
          const fail = (err) =>
            done(encodeToolError(err, envelope, { log: onUnexpected, write: changes, notSent: need === "write" && (!writeAttempted || err?.notSent === true) }), err instanceof ToolError ? err.code : "tool_failed");

          // Everything abnormal from here on is a tool RESULT, not an RPC
          // error: the model can read it and adapt.
          if (!user) return fail(toolError(401, "identity_required", "This tool needs to know who is calling. Call it through a client that signs you in; a shared service key cannot be used here."));
          if (!perUser(`user:${user.userId}`) || !perService("svc")) return fail(toolError(429, "rate_limited", "Too many tool calls; wait and retry."));
          // The role, before the arguments: a read-only caller learns nothing
          // about what a write would have accepted.
          if (!roleAllows(roleOf(user), need)) {
            return fail(
              need === "admin"
                ? toolError(403, "admin_required", "This tool manages who may use the server and needs the admin role.")
                : toolError(403, "write_not_allowed", "You have read-only access to this server; this tool changes the controller.")
            );
          }
          const problems = validateArgs(tool.inputSchema, args);
          if (problems.length) return fail(toolError(400, "invalid_arguments", problems.join("; ")));
          validated = true;
          if (changes) {
            // Before the handler runs, so a change that is at the controller
            // when this process stops has still left a line.
            flight = { line: `tool=${tool.name} user=${user.userId}${what()}` };
            inFlight.add(flight);
            log(`level=info msg="tool call started" ${flight.line}`);
          }
          try {
            let value;
            if (need === "admin") value = await tool.handler({ args, user, store: grants });
            else {
              const declared = endpointsOf(tool);
              // One entry point for every controller call a handler makes: the
              // endpoint must be one the tool declared, and its method decides
              // whether it is a read or THE write.
              const api = (endpoint, path, { query, body } = {}) => {
                if (!declared.includes(endpoint)) throw new ToolError(500, "endpoint_mismatch", "The tool tried to call an endpoint it did not declare.");
                if (endpoint.startsWith("GET ")) return ndfc.get(endpoint, path, query);
                writeAttempted = true;
                return ndfc.send(endpoint, path, { query, body });
              };
              value = await tool.handler({ args, api, callApi: (path, query) => api(tool.endpoint, path, { query }) });
            }
            return done(encodeToolResult(value, envelope, { budgetBytes: config.budgetBytes, hint: tool.narrowHint }), "ok");
          } catch (error) {
            return fail(error);
          }
        }

        default:
          if (isNotification) {
            res.writeHead(202);
            return res.end();
          }
          return rpcError(res, id, -32601, `method not found: ${method.slice(0, 64)}`);
      }
    } catch (error) {
      console.error('level=error msg="request failed"', error);
      return rpcError(res, id, -32603, "internal error");
    }
  }

  // Nothing a request does may take the process down: a change in flight for
  // another caller would lose its answer and its log line.
  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      console.error('level=error msg="request failed"', error);
      try {
        if (res.headersSent) res.destroy();
        else send(res, 500, { error: "internal error" });
      } catch {
        res.destroy();
      }
    });
  });

  server.on("close", () => ndfc.close?.());
  /** The changes whose handler is still running, as log fragments. */
  server.changesInFlight = () => [...inFlight].map((f) => f.line);
  return server;
}

// Compared as real file paths, so `node server\server.mjs` on Windows counts as
// well as `node /app/server.mjs` in the container (and a symlinked checkout).
const samePath = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
const realPath = (p) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};
const isMain = Boolean(process.argv[1]) && samePath(realPath(process.argv[1]), realPath(fileURLToPath(import.meta.url)));
if (isMain) {
  const { config, missing } = loadConfig();
  if (missing.length) {
    // Fail closed: a server that starts without its key or its controller is a
    // server that answers wrongly.
    for (const m of missing) console.error(`level=error msg="configuration" problem=${JSON.stringify(m)}`);
    console.error(`level=error msg="ndfc-mcp refuses to start: ${missing.length} configuration problem(s)"`);
    process.exit(1);
  }
  if (config.ndfc.tlsMode === "insecure") {
    console.log('level=warn msg="NDFC_TLS_INSECURE is set: the controller certificate is NOT verified. Pin its CA with NDFC_TLS_CA_PEM outside a lab."');
  }
  const srv = createServer(config);
  srv.listen(config.port, () => {
    if (config.access.access === "write") {
      console.log(
        `level=warn msg="NDFC_MCP_ACCESS=write: this server offers tools that change the controller and deploy to switches" ` +
          (config.auth.mode === "gateway" ? `administrators=${config.access.adminEmails.length}` : 'who="anyone holding the API key"')
      );
    }
    console.log(
      `level=info msg="ndfc-mcp ${SERVER_INFO.version} listening" port=${config.port} tools=${offeredTools(config).length} mode=${config.auth.mode} access=${config.access.access} ` +
        `controller=${config.ndfc.host} tls=${config.ndfc.tlsMode}`
    );
  });
  // A rejection nobody handled is a bug to log, not a reason to drop a change in flight.
  process.on("unhandledRejection", (error) => console.error('level=error msg="unhandled rejection"', error));
  // docker stop sends SIGTERM; node as PID 1 ignores it unless told otherwise.
  let stopping = false;
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      if (stopping) return;
      stopping = true;
      const waiting = srv.changesInFlight();
      // A change that is at the controller is waited for (the compose files give
      // the container the time), and said: if the wait is cut short, this line
      // is what the log holds about a change that may have been applied.
      for (const line of waiting) console.log(`level=warn msg="stopping with a change in flight: its outcome is unknown unless a later line reports it" ${line}`);
      srv.close(() => process.exit(0));
      srv.closeIdleConnections?.();
      setTimeout(() => process.exit(0), waiting.length ? config.ndfc.writeTimeoutMs + 15_000 : 3000).unref();
      if (waiting.length) {
        // Leave as soon as the last change has been answered and logged.
        const tick = setInterval(() => {
          if (srv.changesInFlight().length) return;
          clearInterval(tick);
          srv.closeIdleConnections?.();
          setTimeout(() => process.exit(0), 500).unref();
        }, 250);
        tick.unref();
      }
    });
  }
}
