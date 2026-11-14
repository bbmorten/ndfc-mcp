#!/usr/bin/env node
/**
 * live-check — the REAL server against a REAL controller, end to end.
 *
 *   node test/live-check.mjs [--env .env] [--insecure] [--url <origin>] [--write] [--deploy]
 *
 * Starts ndfc-mcp in this process on a loopback port, in gateway mode (the
 * stricter of the two: API key plus a signed user assertion, HS256 with a
 * secret generated here), and calls every read tool over HTTP. It needs the
 * controller to be reachable from THIS machine — node on the host, not the
 * container — so on a machine that reaches it only through the VPN sidecar,
 * use the compose stack and a client instead. --url replaces the controller
 * address from the env file, for a local port forward to it.
 *
 * WITHOUT --write the server under test is read-only and nothing is changed.
 *
 * --write   CHANGES THE CONTROLLER, and puts it back: under NDFC_MCP_ACCESS=write
 *           it checks the roles (a reader is refused, an administrator grants
 *           write), then creates a VRF and a network named MCPCHK_*, reads them
 *           back, and deletes both. Nothing is attached, so no switch is
 *           touched and the deletes are not refused. Use a lab.
 * --deploy  with --write: also attaches the VRF and the network to one leaf,
 *           deploys, detaches, deploys again, then deletes. THIS CONFIGURES A
 *           SWITCH. It is skipped, with a line saying so, when the controller
 *           does not report that leaf as reachable: an attachment that cannot
 *           be deployed stays PENDING and blocks the deletes.
 *
 * A --write run that stops half way (a failed read, a crash) runs a teardown
 * before it exits: detach and deploy if it had attached, then the two deletes,
 * each step best effort, and it prints what is still on the controller.
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
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { fileURLToPath } from "node:url";

import { GRANT_TOOLS } from "../server/grants.mjs";
import { createServer, loadConfig } from "../server/server.mjs";
import { READ_TOOLS, WRITE_TOOLS } from "../server/tools.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const envFile = argv.includes("--env") ? argv[argv.indexOf("--env") + 1] : path.join(HERE, "..", ".env");
const insecure = argv.includes("--insecure");
const urlOverride = argv.includes("--url") ? argv[argv.indexOf("--url") + 1] : null;
const doWrite = argv.includes("--write");
const doDeploy = argv.includes("--deploy");
if (doDeploy && !doWrite) {
  console.error("--deploy needs --write");
  process.exit(2);
}

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
const origin = urlOverride || file.NDFC_URL || file.NEXUS_DASHBOARD_URL;
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
const ADMIN_EMAIL = "live-check-admin@example.invalid";
const WRITER_EMAIL = "live-check-writer@example.invalid";
const dataDir = doWrite ? fs.mkdtempSync(path.join(os.tmpdir(), "ndfc-mcp-live-")) : null;
if (doWrite) {
  env.NDFC_MCP_ACCESS = "write";
  env.NDFC_MCP_ADMIN_EMAILS = ADMIN_EMAIL;
  env.NDFC_MCP_DATA_DIR = dataDir;
}

console.log(`controller: ${origin}`);
console.log(doWrite ? `access: WRITE — this run changes the controller${doDeploy ? " AND CONFIGURES A SWITCH" : ""}` : "access: read (nothing is changed)");
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

async function rpc(method, params, { assertion = true, as = null } = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": apiKey, "MCP-Protocol-Version": "2025-06-18", ...(assertion ? { "X-GpuPool-User-Assertion": signAssertion(as ? { sub: as, email: as } : {}) } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? JSON.parse(text) : null };
}

const everything = [];
async function call(name, args = {}, as = null) {
  const started = Date.now();
  const r = await rpc("tools/call", { name, arguments: args }, { as });
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
  const offered = [...READ_TOOLS, ...(doWrite ? [...WRITE_TOOLS, ...GRANT_TOOLS] : [])];
  const listedTools = list.json.result?.tools || [];
  ok(
    doWrite ? `tools/list returns ${READ_TOOLS.length} read, ${WRITE_TOOLS.length} write and ${GRANT_TOOLS.length} grant tools` : `tools/list returns the ${READ_TOOLS.length} read tools, all read-only, and no write tool`,
    listedTools.map((t) => t.name).join() === offered.map((t) => t.name).join() && listedTools.filter((t) => READ_TOOLS.some((r) => r.name === t.name)).every((t) => t.annotations?.readOnlyHint === true)
  );
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

  if (doWrite) {
    const VRF = "MCPCHK_VRF";
    const NET = "MCPCHK_NET";
    const vrfNames = async () => ((await call("list_vrfs", { fabricName })).data?.vrfs || []).map((v) => v.vrfName);
    const netNames = async () => ((await call("list_networks", { fabricName })).data?.networks || []).map((v) => v.networkName);
    const line = (r) => (r.isError ? `${r.data?.error} httpStatus ${r.data?.httpStatus}: ${r.data?.message}` : JSON.stringify(r.data));
    // What this run may have left on the controller, for the teardown in the finally below.
    const left = { vrf: false, net: false, leaf: null };
    try {

    console.log("\nroles (gateway mode, NDFC_MCP_ACCESS=write)");
    const before = { vrfs: await vrfNames(), nets: await netNames() };
    const denied = await call("create_vrf", { fabricName, vrfName: VRF }, WRITER_EMAIL);
    ok("a person with no grant is refused a write (write_not_allowed)", denied.isError && denied.data?.error === "write_not_allowed", line(denied));
    ok("and the controller was not changed", !(await vrfNames()).includes(VRF) || before.vrfs.includes(VRF));
    const notAdmin = await call("grant_set", { email: WRITER_EMAIL, role: "write" }, WRITER_EMAIL);
    ok("that person cannot grant themselves write (admin_required)", notAdmin.isError && notAdmin.data?.error === "admin_required", line(notAdmin));
    const granted = await call("grant_set", { email: WRITER_EMAIL, role: "write" }, ADMIN_EMAIL);
    ok("the administrator grants them write", !granted.isError && granted.data?.role === "write", line(granted));

    console.log("\nwrite tools against the live controller (as the granted person)");
    if (before.vrfs.includes(VRF) || before.nets.includes(NET)) {
      ok(`${VRF} / ${NET} do not exist before the run`, false, "left over from an earlier run: delete them on the controller, then run again");
      throw new Error("leftover");
    }
    left.vrf = true;
    const mkVrf = await call("create_vrf", { fabricName, vrfName: VRF, description: "ndfc-mcp live-check" }, WRITER_EMAIL);
    ok("create_vrf", !mkVrf.isError && mkVrf.data?.changed === true, `${line(mkVrf)} (${mkVrf.ms} ms)`);
    ok("list_vrfs shows it", (await vrfNames()).includes(VRF));
    const dup = await call("create_vrf", { fabricName, vrfName: VRF }, WRITER_EMAIL);
    ok("creating it again is the controller's refusal, as an error result", dup.isError && dup.data?.error === "controller_refused_change", line(dup));
    left.net = true;
    const mkNet = await call("create_network", { fabricName, networkName: NET, vrfName: VRF, gatewayIpAddress: "192.0.2.1/24", description: "ndfc-mcp live-check" }, WRITER_EMAIL);
    ok("create_network", !mkNet.isError && mkNet.data?.changed === true, `${line(mkNet)} (${mkNet.ms} ms)`);
    ok("list_networks shows it", (await netNames()).includes(NET));
    const vAtt = await call("list_vrf_attachments", { fabricName, vrfName: VRF });
    ok("list_vrf_attachments: attached nowhere", !vAtt.isError && vAtt.data.attachments.every((a) => a.attached === false), `${vAtt.data?.totalRows} switches: ${(vAtt.data?.attachments || []).map((a) => `${a.switch}=${a.state}`).join(" ")}`);
    const nAtt = await call("list_network_attachments", { fabricName, networkName: NET });
    ok("list_network_attachments: attached nowhere", !nAtt.isError && nAtt.data.attachments.every((a) => a.attached === false), `${nAtt.data?.totalRows} switches`);
    const early = await call("delete_vrf", { fabricName, vrfName: VRF }, WRITER_EMAIL);
    ok("delete_vrf while it has a network is refused by the controller", early.isError && early.data?.error === "controller_refused_change", line(early));
    const spine = rows.find((s) => s.fabricName === fabricName && s.role === "spine");
    if (spine) {
      const onSpine = await call("attach_vrf", { fabricName, vrfName: VRF, serialNumber: spine.serialNumber }, WRITER_EMAIL);
      ok("attach_vrf to a spine is refused (a refusal inside an HTTP 200)", onSpine.isError && onSpine.data?.error === "controller_refused_change", line(onSpine));
    }

    if (doDeploy) {
      const leaf = ((await call("list_switches", { fabricName })).data?.switches || []).find((s) => s.role === "leaf");
      if (!leaf || leaf.status !== "ok") {
        console.log(`  – deploy cycle SKIPPED: ${leaf ? `${leaf.hostName} is "${leaf.status}"` : "no leaf"} — an attachment that cannot be deployed stays PENDING and blocks the deletes`);
      } else {
        console.log(`\ndeploy cycle on ${leaf.hostName} (${leaf.serialNumber}) — THIS CONFIGURES THE SWITCH`);
        left.leaf = leaf.serialNumber;
        // A read that fails while the controller is deploying is "state unknown": poll again, never crash.
        const rowOf = async (tool, a) => {
          const r = await call(tool, a);
          return r.isError || !Array.isArray(r.data?.attachments) ? null : r.data.attachments.find((x) => x.serialNumber === leaf.serialNumber) || {};
        };
        const state = async () => {
          const a = await rowOf("list_vrf_attachments", { fabricName, vrfName: VRF });
          const b = await rowOf("list_network_attachments", { fabricName, networkName: NET });
          return `vrf ${a ? `${a.attached}/${a.state}` : "unknown (the read failed)"}, network ${b ? `${b.attached}/${b.state}` : "unknown (the read failed)"}`;
        };
        const settle = async (want) => {
          for (let i = 0; i < 24; i += 1) {
            const s = await state();
            if (want.test(s)) return s;
            await new Promise((r) => setTimeout(r, 5000));
          }
          return state();
        };
        const steps = [
          ["attach_vrf", { fabricName, vrfName: VRF, serialNumber: leaf.serialNumber }],
          ["attach_network", { fabricName, networkName: NET, serialNumber: leaf.serialNumber }],
          ["deploy_vrf", { fabricName, vrfName: VRF }],
          ["deploy_network", { fabricName, networkName: NET }],
        ];
        for (const [tool, a] of steps) {
          const r = await call(tool, a, WRITER_EMAIL);
          ok(tool, !r.isError, `${line(r)} (${r.ms} ms)`);
        }
        const up = await settle(/vrf true\/DEPLOYED, network true\/DEPLOYED/);
        ok("both are DEPLOYED on the leaf", /vrf true\/DEPLOYED, network true\/DEPLOYED/.test(up), up);
        for (const [tool, a] of [
          ["detach_network", { fabricName, networkName: NET, serialNumber: leaf.serialNumber }],
          ["deploy_network", { fabricName, networkName: NET }],
          ["detach_vrf", { fabricName, vrfName: VRF, serialNumber: leaf.serialNumber }],
          ["deploy_vrf", { fabricName, vrfName: VRF }],
        ]) {
          const r = await call(tool, a, WRITER_EMAIL);
          ok(tool, !r.isError, `${line(r)} (${r.ms} ms)`);
        }
        const down = await settle(/vrf false\/NA, network false\/NA/);
        ok("both are detached (NA) again", /vrf false\/NA, network false\/NA/.test(down), down);
        if (/vrf false\/NA, network false\/NA/.test(down)) left.leaf = null;
      }
    }

    const rmNet = await call("delete_network", { fabricName, networkName: NET }, WRITER_EMAIL);
    ok("delete_network", !rmNet.isError && rmNet.data?.changed === true, `${line(rmNet)} (${rmNet.ms} ms)`);
    if (!rmNet.isError) left.net = false;
    const rmVrf = await call("delete_vrf", { fabricName, vrfName: VRF }, WRITER_EMAIL);
    ok("delete_vrf", !rmVrf.isError && rmVrf.data?.changed === true, `${line(rmVrf)} (${rmVrf.ms} ms)`);
    if (!rmVrf.isError) left.vrf = false;
    const after = { vrfs: await vrfNames(), nets: await netNames() };
    ok("the controller is as it was: the same VRFs and networks as before the run", JSON.stringify(after) === JSON.stringify(before), `VRFs ${after.vrfs.length}, networks ${after.nets.length}`);
    const gone = await call("delete_vrf", { fabricName, vrfName: VRF }, WRITER_EMAIL);
    ok("deleting it again is the controller's refusal", gone.isError && gone.data?.error === "controller_refused_change", line(gone));

    const revoked = await call("grant_revoke", { email: WRITER_EMAIL }, ADMIN_EMAIL);
    ok("the administrator revokes the grant", !revoked.isError && revoked.data?.role === "read");
    const again = await call("create_vrf", { fabricName, vrfName: VRF }, WRITER_EMAIL);
    ok("and the person is read-only again", again.isError && again.data?.error === "write_not_allowed");
    ok("every change is in the server's log with who made it, and was logged before it was sent", lines.filter((l) => /access=write/.test(l) && /outcome=ok/.test(l)).every((l) => l.includes(`user=${WRITER_EMAIL}`)) && lines.some((l) => /tool=create_vrf .*access=write.*outcome=ok/.test(l)) && lines.some((l) => /msg="tool call started" tool=create_vrf /.test(l)));
    } finally {
      // The run stopped before its own deletes: put the controller back as far as it lets us.
      if (left.vrf || left.net) {
        console.log("\nteardown after a run that did not finish (best effort, as the administrator)");
        const attempt = async (tool, a) => {
          try {
            const r = await call(tool, a, ADMIN_EMAIL);
            console.log(`  ${r.isError ? "✗" : "·"} ${tool}: ${line(r)}`);
          } catch (e) {
            console.log(`  ✗ ${tool}: ${e.message}`);
          }
        };
        if (left.leaf) {
          await attempt("detach_network", { fabricName, networkName: NET, serialNumber: left.leaf });
          await attempt("deploy_network", { fabricName, networkName: NET });
          await attempt("detach_vrf", { fabricName, vrfName: VRF, serialNumber: left.leaf });
          await attempt("deploy_vrf", { fabricName, vrfName: VRF });
          await new Promise((r) => setTimeout(r, 20_000)); // the controller refuses a delete while a deployment runs
        }
        if (left.net) await attempt("delete_network", { fabricName, networkName: NET });
        if (left.vrf) await attempt("delete_vrf", { fabricName, vrfName: VRF });
        const still = [...(await vrfNames().catch(() => [VRF])).filter((n) => n === VRF), ...(await netNames().catch(() => [NET])).filter((n) => n === NET)];
        ok("the teardown removed the test objects", still.length === 0, still.length ? `STILL ON THE CONTROLLER: ${still.join(", ")} — detach, deploy and delete them there` : "");
      }
    }
  }

  console.log("\nwhat never appears in any result");
  const all = everything.join("\n");
  ok("the controller password", !all.includes(password));
  ok("a bearer token or the login body", !/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/.test(all) && !all.includes("userPasswd"));
  ok("rendered device configuration (generatedConfig, command text)", !all.includes("generatedConfig") && !all.includes("cliResp") && !/username \S+ password/i.test(all));

  const health = await (await fetch(`${base}/healthz`)).json();
  console.log(`\ncontroller logins made by the server: ${health.controller.logins} (failures ${health.controller.loginFailures}) for ${everything.length} tool calls; TLS mode ${health.controllerTls}`);
  ok("one login served every call (the token is cached)", health.controller.logins === 1 && health.controller.loginFailures === 0);
  ok(doWrite ? "the server sent writes, and /healthz counts them" : "a read-only run sent no write", doWrite ? health.controller.writes > 0 : health.controller.writes === 0, `${health.controller.writes} writes, ${health.controller.writeFailures} refused or failed`);
} catch (error) {
  if (error.message === "leftover") {
    // already reported as a failed check
  } else if (error.message !== "tls") {
    failed += 1;
    console.error("live-check crashed:", error);
  } else failed += 1;
} finally {
  server.close();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
