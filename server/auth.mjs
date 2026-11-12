/**
 * WHO IS CALLING.
 *
 * THE API KEY — always. Every request except /healthz must carry the key in
 * X-Api-Key (or `Authorization: Bearer <key>`). The server refuses to start
 * without one. On a laptop the port is published on 127.0.0.1 only, and the
 * key is what stops another local process — or a web page that found the port
 * — from reading the fabric.
 *
 * THE USER ASSERTION — only in gateway mode. Two modes, chosen by
 * NDFC_MCP_MODE:
 *
 *   local (the default)  The person running the container is the caller. The
 *                        API key is the whole of authentication, and every
 *                        call is logged as user "local". A request that
 *                        carries a user assertion is REFUSED: nothing here
 *                        could verify it, and an unverifiable credential must
 *                        not be waved through.
 *
 *   gateway              The server sits behind a gateway that authenticates
 *                        people and forwards a short-lived signed statement of
 *                        who is calling, in X-GpuPool-User-Assertion.
 *                        tools/call requires it; it is verified on every
 *                        method on which it is present.
 *
 * In gateway mode the algorithm is chosen by CONFIGURATION, never by the
 * token's own header: a verifier that accepts whichever of RS256 and HS256 the
 * token names lets anyone holding the PUBLIC key sign an HS256 assertion with
 * the PEM text as the HMAC secret. Configure exactly one:
 *
 *   NDFC_MCP_ASSERTION_PUBLIC_KEY  RS256, pinned PEM
 *   NDFC_MCP_CP_URL                RS256, PEM fetched from
 *                                  <url>/api/identity/assertion-key (cached,
 *                                  refetched once on a failed verify so a
 *                                  rotated key self-heals)
 *   NDFC_MCP_ASSERTION_SECRET      HS256
 *
 * Claims: iss "gpupool"; aud = NDFC_MCP_SLUG, required, with no code default;
 * exp; iat, with a maximum age; sub.
 */
import crypto from "node:crypto";

export class AuthError extends Error {}

const CLOCK_SKEW_S = 30;
const MAX_AGE_S = 90;
const KEY_REFETCH_MS = 30_000;

/** Returns { config, missing[] }; the caller refuses to start on any `missing`. */
export function loadAuthConfig(env) {
  const missing = [];
  const apiKey = (env.NDFC_MCP_API_KEY || "").trim();
  if (apiKey.length < 24) missing.push("NDFC_MCP_API_KEY is not set (or is shorter than 24 characters)");

  const mode = (env.NDFC_MCP_MODE || "local").trim().toLowerCase();
  if (mode !== "local" && mode !== "gateway") missing.push('NDFC_MCP_MODE must be "local" or "gateway"');

  const slug = (env.NDFC_MCP_SLUG || "").trim();
  const pem = (env.NDFC_MCP_ASSERTION_PUBLIC_KEY || "").replace(/\\n/g, "\n").trim();
  const secret = env.NDFC_MCP_ASSERTION_SECRET || "";
  const cpUrl = (env.NDFC_MCP_CP_URL || "").trim().replace(/\/+$/, "");

  if (mode === "gateway") {
    if (!/^[a-z0-9-]{1,24}$/.test(slug)) missing.push("NDFC_MCP_SLUG is not set (gateway mode: it is the audience every assertion must carry)");
    if (secret && (pem || cpUrl)) missing.push("NDFC_MCP_ASSERTION_SECRET (HS256) is set together with an RS256 key source: configure exactly one algorithm");
    if (!secret && !pem && !cpUrl) missing.push("gateway mode has no assertion verifier: set NDFC_MCP_CP_URL or NDFC_MCP_ASSERTION_PUBLIC_KEY (RS256), or NDFC_MCP_ASSERTION_SECRET (HS256)");
    if (secret && secret.length < 32) missing.push("NDFC_MCP_ASSERTION_SECRET is shorter than 32 characters");
    if (pem && !pem.includes("BEGIN PUBLIC KEY")) missing.push("NDFC_MCP_ASSERTION_PUBLIC_KEY is not a PEM public key");
  } else if (mode === "local" && (slug || pem || secret || cpUrl)) {
    // Half a gateway configuration in local mode is a mistake worth stopping
    // for: the operator believes assertions are being checked, and they are not.
    missing.push('assertion settings (NDFC_MCP_SLUG / _CP_URL / _ASSERTION_*) are set but NDFC_MCP_MODE is "local": set NDFC_MCP_MODE=gateway, or remove them');
  }

  return {
    missing,
    config: { apiKey, mode, slug, alg: mode === "gateway" ? (secret ? "HS256" : "RS256") : null, publicKeyPem: pem || null, secret: secret || null, cpUrl: cpUrl || null },
  };
}

/** The key a request presents: X-Api-Key, or a bearer token. */
export function presentedApiKey(headers) {
  const direct = headers["x-api-key"];
  if (typeof direct === "string" && direct) return direct;
  const auth = headers.authorization;
  if (typeof auth === "string" && /^Bearer\s+\S/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  return null;
}

/** Constant-time comparison of the presented API key against the configured one. */
export function apiKeyOk(presented, expected) {
  if (typeof presented !== "string" || !presented || !expected) return false;
  const a = crypto.createHash("sha256").update(presented, "utf8").digest();
  const b = crypto.createHash("sha256").update(expected, "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

function b64urlJson(part) {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf-8"));
}

/** Gateway mode only. Returns async (header) => { userId, email, name }; throws AuthError. */
export function createAssertionVerifier(config, { now = () => Date.now(), fetchImpl = fetch } = {}) {
  let cachedPem = config.publicKeyPem;
  const pinned = Boolean(config.publicKeyPem);
  let lastFetch = 0;

  async function fetchKey() {
    // One bad assertion must not become a fetch storm against the gateway.
    if (now() - lastFetch < KEY_REFETCH_MS) return cachedPem;
    lastFetch = now();
    const res = await fetchImpl(`${config.cpUrl}/api/identity/assertion-key`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new AuthError(`assertion-key fetch failed: HTTP ${res.status}`);
    const body = await res.json();
    if (typeof body?.publicKeyPem !== "string" || !body.publicKeyPem.includes("BEGIN PUBLIC KEY")) throw new AuthError("assertion-key response carries no public key");
    cachedPem = body.publicKeyPem;
    return cachedPem;
  }

  const rsOk = (pem, data, sig) => {
    try {
      return crypto.verify("RSA-SHA256", data, pem, sig);
    } catch {
      return false;
    }
  };

  return async function verifyAssertion(header) {
    if (typeof header !== "string" || !header) throw new AuthError("no user assertion");
    const parts = header.split(".");
    if (parts.length !== 3) throw new AuthError("malformed user assertion");
    let head;
    let payload;
    try {
      head = b64urlJson(parts[0]);
      payload = b64urlJson(parts[1]);
    } catch {
      throw new AuthError("malformed user assertion");
    }
    // The CONFIGURED algorithm, not the token's choice.
    if (!head || head.alg !== config.alg) throw new AuthError(`assertion algorithm ${JSON.stringify(head?.alg)} is not accepted here`);
    const data = Buffer.from(`${parts[0]}.${parts[1]}`, "utf-8");
    const sig = Buffer.from(parts[2], "base64url");

    if (config.alg === "HS256") {
      const expect = crypto.createHmac("sha256", config.secret).update(data).digest();
      if (sig.length !== expect.length || !crypto.timingSafeEqual(sig, expect)) throw new AuthError("assertion signature invalid");
    } else {
      let pem = cachedPem;
      if (!pem) {
        try {
          pem = await fetchKey();
        } catch (e) {
          throw e instanceof AuthError ? e : new AuthError("the assertion public key could not be fetched from the gateway");
        }
      }
      if (!pem) throw new AuthError("no assertion public key available");
      let ok = rsOk(pem, data, sig);
      if (!ok && !pinned) {
        // One refetch so a rotated signing key self-heals on the next call.
        try {
          pem = await fetchKey();
        } catch {
          pem = null;
        }
        ok = pem ? rsOk(pem, data, sig) : false;
      }
      if (!ok) throw new AuthError("assertion signature invalid");
    }

    const t = Math.floor(now() / 1000);
    if (payload.iss !== "gpupool") throw new AuthError("assertion issuer is not the gateway");
    if (payload.aud !== config.slug) throw new AuthError("assertion audience is not this server");
    if (typeof payload.exp !== "number" || payload.exp + CLOCK_SKEW_S < t) throw new AuthError("assertion expired");
    if (typeof payload.iat !== "number") throw new AuthError("assertion carries no issue time");
    if (payload.iat - CLOCK_SKEW_S > t) throw new AuthError("assertion issued in the future");
    if (t - payload.iat > MAX_AGE_S + CLOCK_SKEW_S) throw new AuthError("assertion too old");
    if (typeof payload.sub !== "string" || !payload.sub) throw new AuthError("assertion carries no subject");
    return { userId: payload.sub, email: typeof payload.email === "string" ? payload.email : null, name: typeof payload.name === "string" ? payload.name : null };
  };
}
