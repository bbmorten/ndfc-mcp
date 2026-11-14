/**
 * WHO MAY WRITE.
 *
 * The server has a ceiling, NDFC_MCP_ACCESS: `read` (the default — the write
 * tools are not offered and the controller client cannot send a write) or
 * `write`. Under a `write` ceiling each CALLER has a role:
 *
 *   read    the read tools                       (the default for everyone)
 *   write   the read and the write tools
 *   admin   the same, plus grant_list / grant_set / grant_revoke
 *
 * local mode    There is one caller, the person running the container, and
 *               the ceiling is their role. No grants, no admin tools.
 *
 * gateway mode  The caller is the person the gateway vouches for. Their role
 *               is their GRANT, stored here by e-mail address; a person with
 *               no grant reads. NDFC_MCP_ADMIN_EMAILS names the administrators
 *               who can always manage grants (the way in when the file is
 *               empty or lost). A gateway's dashboard manages the grants by
 *               calling the three grant tools as an administrator.
 *
 * The grants live in ONE file, <NDFC_MCP_DATA_DIR>/grants.json, written whole
 * and atomically; every change is also appended to changelog.ndjson with who
 * made it. Neither file holds a secret. A grant that cannot be stored is
 * refused, never kept in memory only: a role that vanishes at the next restart
 * is worse than an error now.
 */
import fs from "node:fs";
import path from "node:path";

import { ToolError, assertSupportedSchema } from "./tools.mjs";

export const ROLES = ["read", "write", "admin"];
const RANK = { read: 0, write: 1, admin: 2 };
/** Does a caller holding `have` satisfy a tool that needs `need`? */
export const roleAllows = (have, need) => (RANK[have] ?? -1) >= (RANK[need] ?? 99);

const EMAIL = "^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,180}\\.[A-Za-z]{2,24}$";
const normEmail = (e) => String(e || "").trim().toLowerCase();

/** Read the access settings. Returns { config, missing[] }. */
export function loadAccessConfig(env, mode) {
  const missing = [];
  const access = (env.NDFC_MCP_ACCESS || "read").trim().toLowerCase();
  if (access !== "read" && access !== "write") missing.push('NDFC_MCP_ACCESS must be "read" or "write"');
  const adminEmails = (env.NDFC_MCP_ADMIN_EMAILS || "")
    .split(/[,\s]+/)
    .map(normEmail)
    .filter(Boolean);
  const dataDir = (env.NDFC_MCP_DATA_DIR || "").trim();
  const badAdmin = adminEmails.find((e) => !new RegExp(EMAIL, "u").test(e));
  if (badAdmin) missing.push("NDFC_MCP_ADMIN_EMAILS holds something that is not an e-mail address");
  if (mode === "gateway" && access === "write") {
    // Under a write ceiling someone has to be able to hand out the write role.
    if (!adminEmails.length) missing.push("NDFC_MCP_ACCESS=write in gateway mode needs NDFC_MCP_ADMIN_EMAILS: the people who may give others write access");
    if (!dataDir) missing.push("NDFC_MCP_ACCESS=write in gateway mode needs NDFC_MCP_DATA_DIR: the directory that keeps the grants");
  } else if (adminEmails.length || dataDir) {
    // Grant settings where no grant is ever read: the operator believes roles are being applied, and they are not.
    missing.push(
      mode === "gateway"
        ? "grant settings (NDFC_MCP_ADMIN_EMAILS / NDFC_MCP_DATA_DIR) are set but NDFC_MCP_ACCESS is not \"write\": set NDFC_MCP_ACCESS=write, or remove them"
        : "grant settings (NDFC_MCP_ADMIN_EMAILS / NDFC_MCP_DATA_DIR) are set in local mode, where the one caller's role is NDFC_MCP_ACCESS: remove them, or set NDFC_MCP_MODE=gateway"
    );
  }
  return { missing, config: { access, adminEmails, dataDir: dataDir || null } };
}

/**
 * The grant store (gateway mode under a write ceiling). Reads the file once;
 * every change rewrites it and appends to the changelog.
 */
export function createGrantStore({ dataDir, adminEmails = [], now = () => Date.now() }) {
  const file = path.join(dataDir, "grants.json");
  const logFile = path.join(dataDir, "changelog.ndjson");
  const admins = new Set(adminEmails.map(normEmail));
  let grants = new Map(); // email -> { role, by, at }
  let loadError = null;

  try {
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const rows = parsed && typeof parsed === "object" && parsed.grants && typeof parsed.grants === "object" ? parsed.grants : null;
      if (!rows) throw new Error("no grants object");
      for (const [email, g] of Object.entries(rows)) {
        if (ROLES.includes(g?.role)) grants.set(normEmail(email), { role: g.role, by: String(g.by || ""), at: String(g.at || "") });
      }
    }
  } catch (e) {
    // A grants file that cannot be read gives nobody a role it might not hold:
    // everyone reads, the administrators named in the environment still manage.
    loadError = e?.message || "unreadable";
    grants = new Map();
  }

  function persist(entry) {
    const rows = Object.fromEntries([...grants.entries()].sort(([a], [b]) => a.localeCompare(b)));
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, grants: rows }, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, file);
      fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      loadError = null;
    } catch (e) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // nothing to clean up
      }
      throw new ToolError(500, "grants_not_stored", `The grant could not be stored (${e?.code || "write failed"}): the server's data directory is not writable. Nothing was changed.`);
    }
  }

  return {
    /** The role of a verified caller. No e-mail in the assertion means no grant can match: read. */
    roleOf(email) {
      const e = normEmail(email);
      if (!e) return "read";
      if (admins.has(e)) return "admin";
      return grants.get(e)?.role || "read";
    },
    list() {
      return [
        ...[...admins].sort().map((email) => ({ email, role: "admin", source: "server configuration" })),
        ...[...grants.entries()]
          .filter(([email]) => !admins.has(email))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([email, g]) => ({ email, role: g.role, source: "grant", grantedBy: g.by || undefined, grantedAt: g.at || undefined })),
      ];
    },
    set(email, role, actor) {
      const e = normEmail(email);
      const before = new Map(grants);
      const previous = grants.get(e)?.role || null;
      const at = new Date(now()).toISOString();
      grants.set(e, { role, by: normEmail(actor), at });
      try {
        persist({ at, actor: normEmail(actor), action: "grant_set", email: e, role, previous });
      } catch (err) {
        grants = before;
        throw err;
      }
      return { email: e, role, previous };
    },
    revoke(email, actor) {
      const e = normEmail(email);
      const previous = grants.get(e)?.role || null;
      if (!previous) return { email: e, previous: null };
      const before = new Map(grants);
      const at = new Date(now()).toISOString();
      grants.delete(e);
      try {
        persist({ at, actor: normEmail(actor), action: "grant_revoke", email: e, previous });
      } catch (err) {
        grants = before;
        throw err;
      }
      return { email: e, previous };
    },
    isConfiguredAdmin: (email) => admins.has(normEmail(email)),
    stats: () => ({ grants: grants.size, administrators: admins.size, ...(loadError ? { loadError: "the grants file could not be read; every granted role is suspended" } : {}) }),
  };
}

const ADMIN = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const EMAIL_ARG = { type: "string", pattern: EMAIL, maxLength: 254, description: "The person's e-mail address, as they sign in with it." };

/**
 * The three grant tools. They touch this server's own grant file, never the
 * controller, and exist only in gateway mode under a write ceiling. Names and
 * shapes follow the platform's other per-user gates (grant_list / grant_set /
 * grant_revoke), so one dashboard pattern manages them all.
 */
export const GRANT_TOOLS = [
  {
    name: "grant_list",
    title: "Who has which access",
    access: "admin",
    description:
      "ADMINISTRATION. Lists who holds a role on this server: the administrators named in the server's " +
      "configuration, and every person granted read, write or admin. Anyone not listed has read access. It reads " +
      "this server's own grant list, not the controller.",
    annotations: Object.freeze({ readOnlyHint: true, openWorldHint: false }),
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async ({ store }) => {
      const rows = store.list();
      return { grants: rows, totalRows: rows.length, everyoneElse: "read" };
    },
  },
  {
    name: "grant_set",
    title: "Give a person access",
    access: "admin",
    description:
      "ADMINISTRATION. Sets one person's role on this server: read (the read tools only), write (also the tools " +
      "that change the controller and deploy to switches) or admin (also these grant tools). It replaces the " +
      "person's previous role and takes effect on their next call.",
    annotations: ADMIN,
    inputSchema: {
      type: "object",
      properties: { email: EMAIL_ARG, role: { type: "string", enum: ROLES, description: "read, write or admin." } },
      required: ["email", "role"],
      additionalProperties: false,
    },
    handler: async ({ args, user, store }) => {
      if (store.isConfiguredAdmin(args.email)) throw new ToolError(409, "configured_administrator", "That person is an administrator by the server's configuration; a grant cannot change it.");
      const r = store.set(args.email, args.role, user.email);
      return { changed: r.previous !== r.role, email: r.email, role: r.role, previousRole: r.previous ?? "read (no grant)" };
    },
  },
  {
    name: "grant_revoke",
    title: "Take a person's grant away",
    access: "admin",
    description:
      "ADMINISTRATION. Removes one person's grant on this server, which leaves them with read access. It takes " +
      "effect on their next call. An administrator named in the server's configuration cannot be revoked here.",
    annotations: ADMIN,
    inputSchema: { type: "object", properties: { email: EMAIL_ARG }, required: ["email"], additionalProperties: false },
    handler: async ({ args, user, store }) => {
      if (store.isConfiguredAdmin(args.email)) throw new ToolError(409, "configured_administrator", "That person is an administrator by the server's configuration; remove them from NDFC_MCP_ADMIN_EMAILS instead.");
      const r = store.revoke(args.email, user.email);
      return { changed: r.previous !== null, email: r.email, role: "read", previousRole: r.previous ?? "read (no grant)" };
    },
  },
];

// Fail at load time, not at the first call.
for (const tool of GRANT_TOOLS) assertSupportedSchema(tool.inputSchema, `${tool.name}.inputSchema`, { root: true });
