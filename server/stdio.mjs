#!/usr/bin/env node
/**
 * stdio.mjs — ndfc-mcp for clients that speak MCP over stdin/stdout.
 *
 * It is a bridge, not a second server: each JSON-RPC message read from stdin
 * (one per line) is POSTed to the HTTP server that is already running in this
 * container, and the answer is written to stdout as one line. So there is one
 * implementation of every rule — validation, redaction, the result budget, the
 * rate limit — and one controller session, however many clients attach.
 *
 * Run it INSIDE the running container, where the API key already is:
 *
 *   docker compose exec -T ndfc-mcp node /app/stdio.mjs
 *
 * The client needs no key and no port: being able to run `docker compose exec`
 * on this machine is the credential.
 *
 * THE TOOL LIST IS ANNOUNCED AT EVERY START. Which tools exist depends on how
 * the server is configured (NDFC_MCP_ACCESS), and a client may keep the list
 * it saw last time: one that stored the read tools of a read-only server would
 * go on showing those after the server was given write access. So over stdio
 * the server declares `tools.listChanged`, and the bridge sends
 * `notifications/tools/list_changed` once the client says it is initialized.
 * It costs a client one more tools/list per session. (Over HTTP the server is
 * stateless and cannot notify; an HTTP client lists the tools when it connects.)
 *
 * stdout carries protocol messages ONLY. Everything else goes to stderr.
 */
import http from "node:http";
import readline from "node:readline";

const PORT = Number.parseInt(process.env.NDFC_MCP_PORT || "3300", 10);
const KEY = process.env.NDFC_MCP_API_KEY || "";
// Longer than the longest the server may take to answer: a login (10 s), a
// read before the write (NDFC_TIMEOUT_MS, at most 25 s) and the write itself
// (NDFC_WRITE_TIMEOUT_MS, at most 300 s). node:http, not fetch: fetch gives up
// on an answer's headers after 300 s whatever it is told.
const waitMs = Number.parseInt(process.env.NDFC_MCP_STDIO_WAIT_MS || "", 10);
const WAIT_MS = Number.isInteger(waitMs) && waitMs >= 100 ? waitMs : 360_000;

/** POST one line to the server in this container. Resolves { status, text }. */
function postLine(line) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(line, "utf8");
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: "/mcp", method: "POST", agent: false, headers: { "Content-Type": "application/json", Accept: "application/json", "X-Api-Key": KEY, "Content-Length": body.length } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          clearTimeout(timer);
          resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString("utf8") });
        });
        res.on("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
      }
    );
    const timer = setTimeout(() => req.destroy(Object.assign(new Error("no answer in time"), { name: "TimeoutError" })), WAIT_MS);
    req.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    req.end(body);
  });
}

if (!KEY) {
  console.error("ndfc-mcp stdio: NDFC_MCP_API_KEY is not set in this environment (run this inside the ndfc-mcp container)");
  process.exit(1);
}

const out = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
let pending = 0;
let closed = false;
const maybeExit = () => {
  if (closed && pending === 0) process.exit(0);
};

async function relay(line) {
  let id = null;
  let isRequest = false;
  let isToolCall = false;
  let method = null;
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      id = parsed.id ?? null;
      isRequest = parsed.id !== undefined && parsed.id !== null && typeof parsed.method === "string";
      isToolCall = parsed.method === "tools/call";
      method = typeof parsed.method === "string" ? parsed.method : null;
    }
  } catch {
    // Let the server answer the parse error; it owns the wording.
    isRequest = true;
  }
  try {
    const res = await postLine(line);
    const text = res.text;
    if (!text.trim()) {
      // A notification: 202, nothing to say — except once the client is ready,
      // when it is told to read the tool list rather than trust a stored one.
      if (method === "notifications/initialized" && res.status === 202) out({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      return;
    }
    try {
      const body = JSON.parse(text);
      if (body && body.jsonrpc === "2.0") {
        // Over stdio the announcement above can be delivered, so it is declared.
        if (method === "initialize" && body.result?.capabilities?.tools) body.result.capabilities.tools.listChanged = true;
        return out(body);
      }
      // An HTTP-level refusal (401, 403, 413): turn it into the JSON-RPC error
      // a stdio client can read, for requests only.
      if (isRequest) out({ jsonrpc: "2.0", id, error: { code: -32000, message: `ndfc-mcp answered HTTP ${res.status}: ${body?.message || body?.error || "refused"}` } });
    } catch {
      if (isRequest) out({ jsonrpc: "2.0", id, error: { code: -32000, message: `ndfc-mcp answered HTTP ${res.status} with a non-JSON body` } });
    }
  } catch (error) {
    console.error(`ndfc-mcp stdio: ${error?.name === "TimeoutError" ? "the server did not answer in time" : "the server on 127.0.0.1 could not be reached"} (${error?.message})`);
    // The call may have reached the server, and through it the controller: a
    // lost answer to a change is not "nothing happened".
    const unknown = isToolCall ? ". If this call was a change, it may or may not have been applied: read the current state before repeating it" : "";
    if (isRequest) out({ jsonrpc: "2.0", id, error: { code: -32000, message: `the ndfc-mcp server in this container is not answering${unknown}` } });
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  // Windows PowerShell puts a byte-order mark before text piped in by hand.
  // No client sends one; without this, that first message is a parse error.
  if (line.charCodeAt(0) === 0xfeff) line = line.slice(1);
  if (!line.trim()) return;
  pending += 1;
  relay(line).finally(() => {
    pending -= 1;
    maybeExit();
  });
});
rl.on("close", () => {
  closed = true;
  maybeExit();
});
