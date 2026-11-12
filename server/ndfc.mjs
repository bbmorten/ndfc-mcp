/**
 * The controller client: one Nexus Dashboard login, cached, and GET requests
 * to the NDFC API under it. Nothing else.
 *
 * Four properties carry it, and each closes a way this goes wrong:
 *
 *   GET ONLY, ONE ENDPOINT PER CALL. `get()` takes the calling tool's declared
 *   endpoint and refuses any path that does not match it, before a byte leaves
 *   the server. The single POST this module makes is the login, to a fixed
 *   path, with no caller-supplied part.
 *
 *   NO REDIRECTS. node:http(s) never follows one, and a 3xx is an error here:
 *   the bearer token and the login body must never travel to another origin.
 *
 *   ONE LOGIN AT A TIME. The token is cached until shortly before it expires
 *   (the JWT's own `exp`), concurrent callers share one in-flight login, and a
 *   401 on a data call drops the token and retries exactly once — a revoked
 *   session heals, a wrong password does not loop.
 *
 *   TLS IS A DECISION, NOT A DEFAULT. Nexus Dashboard ships with a self-signed
 *   certificate. Three modes, chosen in configuration: `verify` (the system
 *   trust store, the default), `pin` (trust exactly the PEM in
 *   NDFC_TLS_CA_PEM — the controller's own certificate or its issuing CA — with
 *   the hostname check off, because that certificate rarely names the address
 *   it is reached at), and `insecure` (no verification at all; for a lab, said
 *   out loud at start and in /healthz). Plain http is accepted only for a
 *   loopback address, which is what the offline harness uses.
 *
 * No npm dependency: node:https, because fetch cannot be given a CA or told
 * to skip verification without an undici dispatcher.
 */
import http from "node:http";
import https from "node:https";

import { API_BASE_PATH, ToolError, UpstreamError } from "./tools.mjs";

const LOGIN_PATH = "/login";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const TOKEN_MARGIN_MS = 60_000;
const TOKEN_FALLBACK_MS = 15 * 60_000; // the controller's default session is 20 minutes

const isLoopback = (host) => host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";

/**
 * Read the controller settings. Returns { config, missing[] }: the caller
 * prints every missing or invalid variable and refuses to start.
 */
export function loadNdfcConfig(env) {
  const missing = [];
  const need = (name) => {
    const v = (env[name] || "").trim();
    if (!v) missing.push(`${name} is not set`);
    return v;
  };
  const rawUrl = need("NDFC_URL");
  const username = need("NDFC_USERNAME");
  const password = env.NDFC_PASSWORD || "";
  if (!password) missing.push("NDFC_PASSWORD is not set");

  let base = null;
  if (rawUrl) {
    try {
      base = new URL(rawUrl);
      if (base.pathname.replace(/\/+$/, "") !== "" || base.search || base.hash || base.username || base.password) {
        missing.push("NDFC_URL must be an origin only, for example https://ndfc.example.net (no path, query or credentials)");
      } else if (base.protocol === "http:" && !isLoopback(base.hostname)) {
        missing.push("NDFC_URL must be https (plain http is accepted for a loopback address only)");
      } else if (base.protocol !== "https:" && base.protocol !== "http:") {
        missing.push("NDFC_URL must be an https URL");
      }
    } catch {
      missing.push("NDFC_URL is not a valid URL");
    }
  }

  const caPem = (env.NDFC_TLS_CA_PEM || "").replace(/\\n/g, "\n").trim();
  const insecure = /^(1|true|yes)$/i.test(env.NDFC_TLS_INSECURE || "");
  if (caPem && insecure) missing.push("NDFC_TLS_CA_PEM and NDFC_TLS_INSECURE are both set: choose one");
  if (caPem && !caPem.includes("BEGIN CERTIFICATE")) missing.push("NDFC_TLS_CA_PEM is not a PEM certificate");
  const tlsMode = caPem ? "pin" : insecure ? "insecure" : "verify";

  const timeoutMs = Number.parseInt(env.NDFC_TIMEOUT_MS || "20000", 10);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 25_000) missing.push("NDFC_TIMEOUT_MS must be between 1000 and 25000");

  return {
    missing,
    config: {
      origin: base ? base.origin : null,
      host: base ? base.host : null,
      username,
      password,
      domain: (env.NDFC_LOGIN_DOMAIN || "DefaultAuth").trim(),
      tlsMode,
      caPem: caPem || null,
      timeoutMs,
    },
  };
}

const templateSegments = (endpoint) => String(endpoint).replace(/^[A-Z]+\s+/, "").split("/").filter(Boolean);
const safeDecode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Does `pathname` (relative to the API base) instantiate the endpoint template? */
export function matchesEndpoint(pathname, endpoint) {
  const t = templateSegments(endpoint);
  const p = String(pathname).split("/").filter(Boolean);
  return t.length === p.length && t.every((seg, i) => (/^\{[^}]+\}$/.test(seg) ? !["", ".", ".."].includes(safeDecode(p[i])) : seg === p[i]));
}

const clip = (s, n = 240) => {
  const t = String(s).replace(/[\u0000-\u001F\u007F-\u009F]/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The controller's own words for a failed call, from whichever shape it used. */
function upstreamMessage(text, status) {
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (data && typeof data === "object") {
    if (typeof data.error === "string" && data.error.trim()) return clip(data.error);
    if (data.error && typeof data.error === "object" && typeof data.error.message === "string") return clip(data.error.message);
    if (typeof data.message === "string" && data.message.trim()) return clip(data.message);
    if (typeof data.messages?.[0]?.message === "string") return clip(data.messages[0].message);
  }
  return `The controller answered HTTP ${status}.`;
}

export function createNdfcClient(config, { now = () => Date.now() } = {}) {
  const base = new URL(config.origin);
  const lib = base.protocol === "https:" ? https : http;
  const tls =
    base.protocol !== "https:"
      ? {}
      : config.tlsMode === "pin"
        ? { ca: config.caPem, rejectUnauthorized: true, checkServerIdentity: () => undefined }
        : config.tlsMode === "insecure"
          ? { rejectUnauthorized: false }
          : { rejectUnauthorized: true };
  // One keep-alive agent: a tool call is one request, and a login per call
  // would be a TLS handshake per call.
  const agent = new lib.Agent({ keepAlive: true, maxSockets: 8, ...tls });

  /** One request. Resolves { status, text }; rejects with an UpstreamError. Never follows a redirect. */
  function request(method, pathAndQuery, { headers = {}, body, timeoutMs = config.timeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
      const req = lib.request(
        {
          protocol: base.protocol,
          hostname: base.hostname,
          port: base.port || (base.protocol === "https:" ? 443 : 80),
          method,
          path: pathAndQuery,
          agent,
          headers: {
            Accept: "application/json",
            ...headers,
            ...(payload ? { "Content-Type": "application/json", "Content-Length": payload.length } : {}),
          },
        },
        (res) => {
          const status = res.statusCode || 0;
          if (status >= 300 && status < 400) {
            res.resume();
            return reject(new UpstreamError(502, "upstream_redirect", "The controller answered with a redirect; this server does not follow redirects with credentials."));
          }
          const chunks = [];
          let size = 0;
          res.on("data", (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
              req.destroy();
              return reject(new UpstreamError(502, "upstream_too_large", "The controller's response exceeded the size limit."));
            }
            chunks.push(chunk);
          });
          res.on("end", () => resolve({ status, text: Buffer.concat(chunks).toString("utf8") }));
          res.on("error", () => reject(new UpstreamError(502, "upstream_unreachable", "The controller's response was cut off.")));
        }
      );
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error("timeout"));
      });
      req.on("error", (e) => {
        if (e instanceof ToolError) return reject(e);
        if (e?.message === "timeout") return reject(new UpstreamError(504, "upstream_timeout", "The controller did not answer in time."));
        const tlsFault = /certificate|self.signed|SSL|TLS|altnames/i.test(`${e?.code || ""} ${e?.message || ""}`);
        if (tlsFault) return reject(new UpstreamError(502, "upstream_tls", "The controller's certificate was not accepted by this server's TLS settings."));
        return reject(new UpstreamError(502, "upstream_unreachable", "The controller could not be reached."));
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  let token = null; // { value, expiresAt }
  let loginInFlight = null;
  const stats = { logins: 0, loginFailures: 0, lastLoginAt: null, lastLoginError: null };

  async function login() {
    stats.logins += 1;
    let res;
    try {
      res = await request("POST", LOGIN_PATH, {
        body: { userName: config.username, userPasswd: config.password, domain: config.domain },
        timeoutMs: Math.min(config.timeoutMs, 10_000),
      });
    } catch (e) {
      stats.loginFailures += 1;
      stats.lastLoginError = e.code || "error";
      throw e;
    }
    if (res.status !== 200) {
      stats.loginFailures += 1;
      stats.lastLoginError = `http_${res.status}`;
      // The controller's message for a bad login never contains the password;
      // it is still not echoed, so nothing account-specific reaches a result.
      const status = res.status === 401 || res.status === 403 ? 401 : 502;
      throw new UpstreamError(status, "controller_login_failed", `The controller refused this server's login (HTTP ${res.status}).`);
    }
    let value = null;
    try {
      const body = JSON.parse(res.text);
      value = body?.jwttoken || body?.token || null;
    } catch {
      value = null;
    }
    if (typeof value !== "string" || !value) {
      stats.loginFailures += 1;
      stats.lastLoginError = "no_token";
      throw new UpstreamError(502, "controller_login_failed", "The controller's login answer carried no token.");
    }
    let expiresAt = now() + TOKEN_FALLBACK_MS;
    try {
      const claims = JSON.parse(Buffer.from(value.split(".")[1], "base64url").toString("utf8"));
      if (typeof claims.exp === "number") expiresAt = claims.exp * 1000;
    } catch {
      // Not a JWT we can read: keep the fallback lifetime.
    }
    token = { value, expiresAt };
    stats.lastLoginAt = new Date(now()).toISOString();
    stats.lastLoginError = null;
    return value;
  }

  async function getToken() {
    if (token && token.expiresAt - TOKEN_MARGIN_MS > now()) return token.value;
    if (!loginInFlight) {
      loginInFlight = login().finally(() => {
        loginInFlight = null;
      });
    }
    return loginInFlight;
  }

  /**
   * GET one endpoint. `endpoint` is the calling tool's declared endpoint
   * ("GET /path/{param}"); `path` is that template filled in; `query` holds
   * validated arguments only.
   */
  async function get(endpoint, path, query = {}) {
    const raw = String(path);
    if (!/^GET\s/.test(String(endpoint))) throw new ToolError(500, "endpoint_mismatch", "The tool declared an endpoint that is not a GET.");
    if (!raw.startsWith("/") || raw.includes("\\") || /[?#]/.test(raw) || raw.split("/").some((s) => s === "." || s === ".." || [".", ".."].includes(safeDecode(s)))) {
      throw new ToolError(400, "invalid_path", "The tool built an invalid API path.");
    }
    if (!matchesEndpoint(raw, endpoint)) throw new ToolError(500, "endpoint_mismatch", "The tool tried to call a route other than its declared endpoint.");
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
    const target = `${API_BASE_PATH}${raw}${qs.size ? `?${qs}` : ""}`;

    let res;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const bearer = await getToken();
      res = await request("GET", target, { headers: { Authorization: `Bearer ${bearer}` } });
      if (res.status !== 401 || attempt === 1) break;
      token = null; // the session was revoked or expired early: one fresh login, one retry
    }
    if (res.status < 200 || res.status >= 300) {
      throw new UpstreamError(res.status, res.status === 401 || res.status === 403 ? "controller_refused" : "controller_error", upstreamMessage(res.text, res.status));
    }
    try {
      return res.text ? JSON.parse(res.text) : null;
    } catch {
      throw new UpstreamError(502, "upstream_invalid", `The controller returned a non-JSON body (HTTP ${res.status}).`);
    }
  }

  return {
    get,
    stats: () => ({ ...stats, tokenCached: Boolean(token && token.expiresAt - TOKEN_MARGIN_MS > now()) }),
    close: () => agent.destroy(),
  };
}
