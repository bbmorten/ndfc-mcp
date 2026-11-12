#!/usr/bin/env node
/**
 * live-check — the REAL server against a REAL controller, end to end.
 *
 *   node test/live-check.mjs [--env .env] [--insecure]
 *
 * Starts ndfc-mcp in this process on a loopback port, in gateway mode (the
 * stricter of the two: API key plus a signed user assertion, HS256 with a
 * secret generated here), and calls every tool over HTTP. It needs the
 * controller to be reachable from THIS machine — node on the host, not the
 * container — so on a machine that reaches it only through the VPN sidecar,
 * use the compose stack and a client instead.
 *
 * Reads the controller address and login from an env file (never printed):
 *   NEXUS_DASHBOARD_URL / NEXUS_DASHBOARD_USERNAME / NEXUS_DASHBOARD_PASSWORD
 *   (or NDFC_URL / NDFC_USERNAME / NDFC_PASSWORD).
 *
 * TLS: it fetches the controller's certificate and PINS it (NDFC_TLS_CA_PEM),
 * which is the mode a deployment should use; --insecure skips verification
 * instead. If pinning is refused it says so and stops, rather than quietly
 * falling back.
 *
 * EXITS NON-ZERO on any failed check, so it can gate a deploy.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

import { createServer, loadConfig } from "../server/server.mjs";
import { TOOLS } from "../server/tools.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const envFile = argv.includes("--env") ? argv[argv.indexOf("--env") + 1] : path.join(HERE, "..", ".env");
const insecure = argv.includes("--insecure");

function readEnvFile(file) {
  const out = {};
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const i = line.indexOf("=");
    let v = line.slice(i + 1).trim();
    if (v.length >= 2 && v[0] === v[v.length - 1] && "'\"".includes(v[0])) v = v.slice(1, -1);
    out[line.slice(0, i).trim().replace(/^export\s+/, "")] = v;
  }
  return out;
}

function fetchCertificatePem(origin) {
  const u = new URL(origin);
  return new Promise((resolve, reject) => {
    // SNI names a host, never an address: Node refuses an IP as servername.
    const sni = /^[0-9.]+$|:/.test(u.hostname) ? {} : { servername: u.hostname };
    const socket = tls.connect({ host: u.hostname, port: Number(u.port || 443), rejectUnauthorized: false, ...sni }, () => {
      // Walk to the TOP of the chain the controller presents. Nexus Dashboard
      // serves a leaf (CN=sn-apigw) issued by its own per-cluster CA; pinning
      // the leaf fails with SELF_SIGNED_CERT_IN_CHAIN, pinning that CA works.
      // A controller with a single self-signed certificate is its own top.
      let cert = socket.getPeerX509Certificate();
      const leaf = cert;
      const seen = new Set();
      while (cert && cert.issuerCertificate && !seen.has(cert.fingerprint256)) {
        seen.add(cert.fingerprint256);
        cert = cert.issuerCertificate;
      }
      socket.end();
      if (!cert) return reject(new Error("the controller presented no certificate"));
      resolve({ pem: cert.toString(), subject: cert.subject, leafSubject: leaf.subject, validTo: cert.validTo, fingerprint256: cert.fingerprint256 });
    });
    socket.setTimeout(10_000, () => socket.destroy(new Error("timed out fetching the certificate")));
    socket.on("error", reject);
  });
}

let failed = 0;
const ok = (name, pass, detail = "") => {
  if (!pass) failed += 1;
  console.log(`  ${pass ? "✓" : "✗"} ${name}${detail ? `  — ${detail}` : ""}`);
};

const file = readEnvFile(envFile);
const origin = file.NDFC_URL || file.NEXUS_DASHBOARD_URL;
const username = file.NDFC_USERNAME || file.NEXUS_DASHBOARD_USERNAME;
const password = file.NDFC_PASSWORD || file.NEXUS_DASHBOARD_PASSWORD;
if (!origin || !username || !password) {
  console.error(`${envFile}: needs the controller URL, username and password`);
  process.exit(2);
}

const assertionSecret = crypto.randomBytes(32).toString("hex");
const apiKey = crypto.randomBytes(24).toString("hex");
const env = {
  NDFC_MCP_API_KEY: apiKey,
  NDFC_MCP_MODE: "gateway",
  NDFC_MCP_SLUG: "ndfc",
  NDFC_MCP_ASSERTION_SECRET: assertionSecret,
  NDFC_MCP_PORT: "3300",
  NDFC_URL: origin,
  NDFC_USERNAME: username,
  NDFC_PASSWORD: password,
};

console.log(`controller: ${origin}`);
if (insecure) {
  env.NDFC_TLS_INSECURE = "true";
  console.log("TLS: --insecure (certificate NOT verified)");
} else {
  const cert = await fetchCertificatePem(origin);
  env.NDFC_TLS_CA_PEM = cert.pem;
  console.log(`TLS: pinning the CA the controller presents (${cert.subject.replace(/\n/g, ", ")}; valid to ${cert.validTo}; sha256 ${cert.fingerprint256.slice(0, 23)}…) for leaf ${cert.leafSubject.replace(/\n/g, ", ")}`);
}

const { config, missing } = loadConfig(env);
if (missing.length) {
  for (const m of missing) console.error(`configuration: ${m}`);
  process.exit(2);
}

const lines = [];
const server = createServer(config, { log: (l) => lines.push(l) });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

function signAssertion(claims = {}) {
  const now = Math.floor(Date.now() / 1000);
  const head = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ iss: "gpupool", aud: "ndfc", sub: "live-check-user", email: "live-check@example.invalid", iat: now, exp: now + 60, ...claims })).toString("base64url");
  const sig = crypto.createHmac("sha256", assertionSecret).update(`${head}.${body}`).digest("base64url");
  return `${head}.${body}.${sig}`;
}

async function rpc(method, params, { assertion = true } = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": apiKey, "MCP-Protocol-Version": "2025-06-18", ...(assertion ? { "X-GpuPool-User-Assertion": signAssertion() } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null };
}

const everything = [];
async function call(name, args = {}) {
  const started = Date.now();
  const r = await rpc("tools/call", { name, arguments: args });
  const result = r.json?.result;
  const inner = result?.content?.[0]?.text ? JSON.parse(result.content[0].text) : null;
  everything.push(r.text);
  return { isError: result?.isError === true, data: inner, bytes: Buffer.byteLength(r.text), ms: Date.now() - started, http: r.status };
}

try {
  console.log("\nprotocol");
  const init = await rpc("initialize", {}, { assertion: false });
  ok("initialize answers without a user", init.status === 200 && init.json.result?.protocolVersion === "2025-06-18");
  const list = await rpc("tools/list", {}, { assertion: false });
  ok(`tools/list returns the ${TOOLS.length} declared tools, all read-only`, list.json.result?.tools?.length === TOOLS.length && list.json.result.tools.every((t) => t.annotations?.readOnlyHint === true));
  const nokey = await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  ok("a request without the API key is 401", nokey.status === 401);
  const anon = await rpc("tools/call", { name: "list_fabrics", arguments: {} }, { assertion: false });
  ok("a tool call without a user assertion is refused", anon.json.result?.isError === true && anon.text.includes("identity_required"));

  console.log("\ntools against the live controller");
  const info = await call("get_controller_info");
  ok("get_controller_info", !info.isError && typeof info.data?.version === "string", info.isError ? JSON.stringify(info.data) : `version ${info.data.version}, mode ${info.data.mode} (${info.ms} ms)`);
  if (info.isError && info.data?.error === "upstream_tls") {
    console.error("\nThe pinned certificate was not accepted. Re-run with --insecure to tell a pinning problem from a controller problem.");
    throw new Error("tls");
  }

  const fabrics = await call("list_fabrics");
  const names = (fabrics.data?.fabrics || []).map((f) => f.fabricName);
  ok("list_fabrics", !fabrics.isError && names.length > 0, fabrics.isError ? JSON.stringify(fabrics.data) : names.map((n, i) => `${n} [${fabrics.data.fabrics[i].technology}, ${fabrics.data.fabrics[i].operStatus}]`).join("; "));

  const switches = await call("list_switches");
  const rows = switches.data?.switches || [];
  ok("list_switches", !switches.isError && rows.length > 0, switches.isError ? JSON.stringify(switches.data) : rows.map((s) => `${s.hostName}(${s.role}, ${s.configStatus})`).join(" "));

  // Prefer a VXLAN fabric and one of ITS leaves, so the fabric-scoped calls have something to show.
  const fabricName = (fabrics.data?.fabrics || []).find((f) => /vxlan/i.test(f.technology || ""))?.fabricName || names[0];
  const sw = rows.find((s) => s.fabricName === fabricName && s.role === "leaf") || rows[0];

  const one = await call("list_switches", { fabricName });
  ok(`list_switches fabricName=${fabricName}`, !one.isError && one.data.switches.every((s) => s.fabricName === fabricName), `${one.data?.totalRows} of ${rows.length}`);

  const fab = await call("get_fabric", { fabricName });
  ok(`get_fabric ${fabricName}`, !fab.isError && fab.data.settingCounts?.total > 0, fab.isError ? JSON.stringify(fab.data) : `${JSON.stringify(fab.data.settingCounts)} ${fab.bytes} bytes`);
  const bgp = await call("get_fabric", { fabricName, settingContains: "BGP" });
  ok("get_fabric settingContains=BGP narrows the settings", !bgp.isError && Object.keys(bgp.data.settings).every((k) => /bgp/i.test(k)), Object.keys(bgp.data?.settings || {}).join(" "));

  const ov = await call("get_fabric_overview", { fabricName });
  ok("get_fabric_overview", !ov.isError && typeof ov.data.switchesByRole === "object", JSON.stringify({ health: ov.data?.switchesByHealth, config: ov.data?.switchesByConfigStatus, roles: ov.data?.switchesByRole }));

  const ifs = await call("list_interfaces", { serialNumber: sw.serialNumber });
  ok(`list_interfaces ${sw.hostName}`, !ifs.isError && ifs.data.interfaces.length > 0, ifs.isError ? JSON.stringify(ifs.data) : `${ifs.data.interfaces.length} listed of ${ifs.data.totalRows}${ifs.data.truncated ? " (truncated)" : ""}, ${ifs.bytes} bytes`);
  ok("list_interfaces stays under the 30,000-character client cap", ifs.bytes < 30_000, `${ifs.bytes} bytes`);
  const up = await call("list_interfaces", { serialNumber: sw.serialNumber, nameContains: "loopback" });
  ok("list_interfaces nameContains=loopback", !up.isError && up.data.interfaces.every((i) => /loopback/i.test(i.ifName)), (up.data?.interfaces || []).map((i) => `${i.ifName}=${i.ipAddress || "-"}`).join(" "));

  const links = await call("list_links", { fabricName });
  ok("list_links", !links.isError && Array.isArray(links.data.links), links.isError ? JSON.stringify(links.data) : `${links.data.totalRows} links, e.g. ${links.data.links[0]?.a?.switch}:${links.data.links[0]?.a?.interface} — ${links.data.links[0]?.b?.switch}:${links.data.links[0]?.b?.interface}`);

  const pol = await call("list_switch_policies", { serialNumber: sw.serialNumber });
  ok(`list_switch_policies ${sw.hostName}`, !pol.isError && pol.data.policies.length > 0, pol.isError ? JSON.stringify(pol.data) : `${pol.data.policies.length} listed of ${pol.data.totalRows}${pol.data.truncated ? " (truncated)" : ""}, ${pol.bytes} bytes`);
  const polBgp = await call("list_switch_policies", { serialNumber: sw.serialNumber, templateContains: "bgp" });
  ok("list_switch_policies templateContains=bgp", !polBgp.isError && polBgp.data.policies.every((p) => /bgp/i.test(p.templateName)), (polBgp.data?.policies || []).map((p) => p.templateName).join(" "));

  const vrfs = await call("list_vrfs", { fabricName });
  ok("list_vrfs", !vrfs.isError && Array.isArray(vrfs.data.vrfs), `${vrfs.data?.totalRows} VRFs`);
  const nets = await call("list_networks", { fabricName });
  ok("list_networks", !nets.isError && Array.isArray(nets.data.networks), `${nets.data?.totalRows} networks`);

  const alarms = await call("list_alarms");
  ok("list_alarms", !alarms.isError && Array.isArray(alarms.data.alarms), alarms.isError ? JSON.stringify(alarms.data) : `${alarms.data.alarms.length} listed of ${alarms.data.totalRows}${alarms.data.truncated ? " (truncated)" : ""}, ${alarms.bytes} bytes; first: ${alarms.data.alarms[0]?.severity} ${alarms.data.alarms[0]?.deviceName} ${alarms.data.alarms[0]?.message}`);

  const hist = await call("list_deploy_history", { fabricName, limit: 5 });
  ok("list_deploy_history limit=5", !hist.isError && hist.data.deployments.length <= 5, hist.isError ? JSON.stringify(hist.data) : `${hist.data.deployments.length} of ${hist.data.totalRows}; first: ${hist.data.deployments[0]?.hostName} ${hist.data.deployments[0]?.entityName} ${hist.data.deployments[0]?.status} (${hist.data.deployments[0]?.commandCount} commands)`);

  console.log("\nnegative cases against the live controller");
  const ghost = await call("get_fabric", { fabricName: "no_such_fabric_xyz" });
  ok("an unknown fabric is an error result with guidance, never data", ghost.isError && typeof ghost.data?.guidance === "string", `${ghost.data?.error} httpStatus ${ghost.data?.httpStatus}: ${ghost.data?.message}`);
  const walk = await call("get_fabric", { fabricName: ".." });
  ok("a path-walking fabric name is refused before the controller is called", walk.isError && walk.data?.error === "invalid_arguments");
  const extra = await call("list_fabrics", { asUser: "admin" });
  ok("an undeclared argument is refused", extra.isError && extra.data?.error === "invalid_arguments");

  console.log("\nwhat never appears in any result");
  const all = everything.join("\n");
  ok("the controller password", !all.includes(password));
  ok("a bearer token or the login body", !/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/.test(all) && !all.includes("userPasswd"));
  ok("rendered device configuration (generatedConfig, command text)", !all.includes("generatedConfig") && !all.includes("cliResp") && !/username \S+ password/i.test(all));

  const health = await (await fetch(`${base}/healthz`)).json();
  console.log(`\ncontroller logins made by the server: ${health.controller.logins} (failures ${health.controller.loginFailures}) for ${everything.length} tool calls; TLS mode ${health.controllerTls}`);
  ok("one login served every call (the token is cached)", health.controller.logins === 1 && health.controller.loginFailures === 0);
} catch (error) {
  if (error.message !== "tls") {
    failed += 1;
    console.error("live-check crashed:", error);
  } else failed += 1;
} finally {
  server.close();
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
