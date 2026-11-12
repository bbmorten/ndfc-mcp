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
 * stdout carries protocol messages ONLY. Everything else goes to stderr.
 */
import readline from "node:readline";

const PORT = Number.parseInt(process.env.NDFC_MCP_PORT || "3300", 10);
const KEY = process.env.NDFC_MCP_API_KEY || "";
const URL_ = `http://127.0.0.1:${PORT}/mcp`;

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
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      id = parsed.id ?? null;
      isRequest = parsed.id !== undefined && parsed.id !== null && typeof parsed.method === "string";
    }
  } catch {
    // Let the server answer the parse error; it owns the wording.
    isRequest = true;
  }
  try {
    const res = await fetch(URL_, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", "X-Api-Key": KEY },
      body: line,
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    if (!text.trim()) return; // a notification: 202, nothing to say
    try {
      const body = JSON.parse(text);
      if (body && body.jsonrpc === "2.0") return out(body);
      // An HTTP-level refusal (401, 403, 413): turn it into the JSON-RPC error
      // a stdio client can read, for requests only.
      if (isRequest) out({ jsonrpc: "2.0", id, error: { code: -32000, message: `ndfc-mcp answered HTTP ${res.status}: ${body?.message || body?.error || "refused"}` } });
    } catch {
      if (isRequest) out({ jsonrpc: "2.0", id, error: { code: -32000, message: `ndfc-mcp answered HTTP ${res.status} with a non-JSON body` } });
    }
  } catch (error) {
    console.error(`ndfc-mcp stdio: ${error?.name === "TimeoutError" ? "the server did not answer in time" : "the server on 127.0.0.1 could not be reached"} (${error?.message})`);
    if (isRequest) out({ jsonrpc: "2.0", id, error: { code: -32000, message: "the ndfc-mcp server in this container is not answering" } });
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
