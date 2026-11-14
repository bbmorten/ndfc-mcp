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
 * and atomically; every change is first appended to changelog.ndjson with who
 * made it (their address and the subject of their assertion). Neither file
 * holds a secret. A grant that cannot be stored or logged is refused, never
 * kept in memory only: a role that vanishes at the next restart is worse than
 * an error now. The file is re-read when it changes behind the server, so a
 * hand edit or a second server on the directory is honoured, not overwritten.
 */
import fs from "node:fs";
import path from "node:path";

import { ToolError, assertSupportedSchema } from "./tools.mjs";

export const ROLES = ["read", "write", "admin"];
const RANK = { read: 0, write: 1, admin: 2 };
/** Does a caller holding `have` satisfy a tool that needs `need`? */
export const roleAllows = (have, need) => (RANK[have] ?? -1) >= (RANK[need] ?? 99);

const EMAIL = "^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,180}\\.[A-Za-z]{2,24}$";
const EMAIL_RE = new RegExp(EMAIL, "u");
/** A configured or tool-supplied address (already held to the pattern), in the one form the store keeps. */
const normEmail = (e) => String(e || "").trim().toLowerCase();
/**
 * An address as an assertion or the grants file carries it. It is matched AS
 * RECEIVED against the pattern the grant tools enforce, and only then
 * lower-cased: trimming first, or lower-casing first, would let a string that
 * is not the granted address (a no-break space after it, a Kelvin sign for a
 * k) resolve to that person's role.
 */
const claimEmail = (e) => (typeof e === "string" && e.length <= 254 && EMAIL_RE.test(e) ? e.toLowerCase() : null);

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
  const badAdmin = adminEmails.find((e) => !EMAIL_RE.test(e));
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
 * The grant store (gateway mode under a write ceiling). The file is the
 * truth: it is read at start and again whenever it has changed behind this
 * process (a hand edit, another server on the same directory), and every
 * change appends to the changelog and then replaces the file.
 */
export function createGrantStore({ dataDir, adminEmails = [], now = () => Date.now() }) {
  const file = path.join(dataDir, "grants.json");
  const logFile = path.join(dataDir, "changelog.ndjson");
  const admins = new Set(adminEmails.map(normEmail));
  let grants = new Map(); // email -> { role, by, bySub, at }
  let loadError = null;
  let ignored = 0; // entries of the file that are not an address with a role
  let seen = null; // what grants.json looked like when it was last read or written

  const signature = () => {
    try {
      const st = fs.statSync(file);
      return `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch (e) {
      return e?.code === "ENOENT" ? "absent" : `unreadable:${e?.code || "error"}`;
    }
  };

  function load() {
    seen = signature();
    grants = new Map();
    loadError = null;
    ignored = 0;
    try {
      if (!fs.existsSync(file)) return;
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      const rows = parsed && typeof parsed === "object" && parsed.grants && typeof parsed.grants === "object" && !Array.isArray(parsed.grants) ? parsed.grants : null;
      if (!rows) throw new Error("no grants object");
      for (const [email, g] of Object.entries(rows)) {
        const key = claimEmail(email);
        // An entry the grant tools could not have written is not honoured, and /healthz counts it.
        if (!key || !ROLES.includes(g?.role)) {
          ignored += 1;
          continue;
        }
        grants.set(key, { role: g.role, by: String(g.by || ""), bySub: String(g.bySub || ""), at: String(g.at || "") });
      }
    } catch (e) {
      // A grants file that cannot be read gives nobody a role it might not hold:
      // everyone reads, the administrators named in the environment still manage.
      loadError = e?.message || "unreadable";
      grants = new Map();
    }
  }
  load();
  const refresh = () => {
    if (signature() !== seen) load();
  };

  function persist(entry) {
    const rows = Object.fromEntries(
      [...grants.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([email, g]) => [email, { role: g.role, by: g.by, ...(g.bySub ? { bySub: g.bySub } : {}), at: g.at }])
    );
    const tmp = `${file}.${process.pid}.tmp`;
    let logged = false;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, grants: rows }, null, 2)}\n`, { mode: 0o600 });
      // The changelog line goes in BEFORE the file is replaced: when it cannot
      // be written, grants.json is untouched and "nothing was changed" is true.
      fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
      logged = true;
      fs.renameSync(tmp, file);
      loadError = null;
      seen = signature();
    } catch (e) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // nothing to clean up
      }
      if (logged) {
        // The line is in and the file is not: say so in the changelog, so it never records a change that did not happen.
        try {
          fs.appendFileSync(logFile, `${JSON.stringify({ at: entry.at, actor: entry.actor, action: "not_stored", of: entry.action, email: entry.email })}\n`, { mode: 0o600 });
        } catch {
          // the tool's error below is what the administrator reads
        }
      }
      throw new ToolError(500, "grants_not_stored", `The grant could not be stored (${e?.code || "write failed"}): the server's data directory is not writable. Nothing was changed.`);
    }
  }

  const actorOf = (actor) => ({ actor: claimEmail(actor?.email) || "", ...(actor?.sub ? { actorSub: String(actor.sub).slice(0, 128) } : {}) });
  const RANK_FIRST = { admin: 0, write: 1, read: 2 };

  return {
    /** The role of a verified caller. An assertion without an address, or with something that is not one, matches no grant: read. */
    roleOf(email) {
      refresh();
      const e = claimEmail(email);
      if (!e) return "read";
      if (admins.has(e)) return "admin";
      return grants.get(e)?.role || "read";
    },
    /** Administrators by configuration, then every stored grant: admin, write, read, each by address. */
    list() {
      refresh();
      return [
        ...[...admins].sort().map((email) => ({ email, role: "admin", source: "server configuration" })),
        ...[...grants.entries()]
          .sort(([a, ga], [b, gb]) => RANK_FIRST[ga.role] - RANK_FIRST[gb.role] || a.localeCompare(b))
          .map(([email, g]) => ({
            email,
            role: g.role,
            // A stored grant under a configured administrator has no effect today, and would the day they leave the configuration.
            source: admins.has(email) ? "grant (not in effect: an administrator by server configuration)" : "grant",
            grantedBy: g.by || undefined,
            grantedAt: g.at || undefined,
          })),
      ];
    },
    set(email, role, actor) {
      refresh();
      const e = normEmail(email);
      let setAside = null;
      if (loadError) {
        // A new grant is the repair of an unreadable file. The file is kept
        // under another name, never overwritten unseen.
        setAside = `grants.json.unreadable-${new Date(now()).toISOString().replace(/[:.]/g, "-")}`;
        try {
          fs.renameSync(file, path.join(dataDir, setAside));
        } catch (err) {
          throw new ToolError(500, "grants_not_stored", `The unreadable grants file could not be set aside (${err?.code || "rename failed"}). Nothing was changed.`);
        }
      }
      const before = new Map(grants);
      const previous = grants.get(e)?.role || null;
      const at = new Date(now()).toISOString();
      const who = actorOf(actor);
      grants.set(e, { role, by: who.actor, bySub: who.actorSub || "", at });
      try {
        persist({ at, ...who, action: "grant_set", email: e, role, previous, ...(setAside ? { setAside } : {}) });
      } catch (err) {
        grants = before;
        throw err;
      }
      return { email: e, role, previous, setAside };
    },
    revoke(email, actor) {
      refresh();
      // A revoke that cannot be recorded would come back with the file.
      if (loadError) {
        throw new ToolError(409, "grants_suspended", "The grants file cannot be read, so every granted role is suspended and no grant can be revoked. Repair grants.json in the server's data directory, or use grant_set, which sets the unreadable file aside and starts a new one.");
      }
      const e = normEmail(email);
      const previous = grants.get(e)?.role || null;
      if (!previous) return { email: e, previous: null };
      const before = new Map(grants);
      const at = new Date(now()).toISOString();
      grants.delete(e);
      try {
        persist({ at, ...actorOf(actor), action: "grant_revoke", email: e, previous });
      } catch (err) {
        grants = before;
        throw err;
      }
      return { email: e, previous };
    },
    isConfiguredAdmin: (email) => admins.has(normEmail(email)),
    hasGrant(email) {
      refresh();
      return grants.has(normEmail(email));
    },
    /** True while grants.json cannot be read: every granted role is suspended. */
    suspended() {
      refresh();
      return Boolean(loadError);
    },
    stats() {
      refresh();
      return {
        grants: grants.size,
        administrators: admins.size,
        ...(ignored ? { ignoredEntries: ignored } : {}),
        ...(loadError ? { loadError: "the grants file could not be read; every granted role is suspended" } : {}),
      };
    },
  };
}

const ADMIN = Object.freeze({ readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false });
const EMAIL_ARG = { type: "string", pattern: EMAIL, maxLength: 254, description: "The person's e-mail address, as they sign in with it." };
const actorFrom = (user) => ({ email: user.email, sub: user.userId });

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
      "configuration, then every person granted admin, write or read. Anyone not listed has read access. role and " +
      "emailContains narrow a long list. It reads this server's own grant list, not the controller.",
    annotations: Object.freeze({ readOnlyHint: true, openWorldHint: false }),
    narrowHint: "Administrators and writers are listed first. Narrow the list with role or emailContains.",
    inputSchema: {
      type: "object",
      properties: {
        role: { type: "string", enum: ROLES, description: "Keep only people who hold this role." },
        emailContains: { type: "string", minLength: 1, maxLength: 64, description: "Keep only addresses that contain this text (case-insensitive)." },
      },
      additionalProperties: false,
    },
    handler: async ({ args, store }) => {
      const needle = args.emailContains ? args.emailContains.toLowerCase() : null;
      const rows = store.list().filter((r) => (!args.role || r.role === args.role) && (!needle || r.email.includes(needle)));
      return {
        grants: rows,
        totalRows: rows.length,
        everyoneElse: "read",
        ...(store.suspended() ? { suspended: "The grants file cannot be read: every granted role is suspended and the grants stored in it are not listed. grant_set sets that file aside and starts a new one." } : {}),
      };
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
      const r = store.set(args.email, args.role, actorFrom(user));
      return {
        changed: r.previous !== r.role,
        email: r.email,
        role: r.role,
        previousRole: r.previous ?? "read (no grant)",
        ...(r.setAside ? { note: `The grants file could not be read. It was kept as ${r.setAside} and a new one was started: the grants stored in the old file are not in effect.` } : {}),
      };
    },
  },
  {
    name: "grant_revoke",
    title: "Take a person's grant away",
    access: "admin",
    description:
      "ADMINISTRATION. Removes one person's grant on this server, which leaves them with read access. It takes " +
      "effect on their next call. An administrator named in the server's configuration stays an administrator; " +
      "a grant stored for them is removed, so that taking them out of the configuration leaves them with read.",
    annotations: ADMIN,
    inputSchema: { type: "object", properties: { email: EMAIL_ARG }, required: ["email"], additionalProperties: false },
    handler: async ({ args, user, store }) => {
      const configured = store.isConfiguredAdmin(args.email);
      if (configured && !store.hasGrant(args.email)) {
        throw new ToolError(409, "configured_administrator", "That person is an administrator by the server's configuration and holds no stored grant; remove them from NDFC_MCP_ADMIN_EMAILS instead.");
      }
      const r = store.revoke(args.email, actorFrom(user));
      if (configured) {
        return { changed: true, email: r.email, role: "admin", previousRole: r.previous, note: "Still an administrator by the server's configuration (NDFC_MCP_ADMIN_EMAILS). The stored grant is gone, so removing them from that setting now leaves them with read access." };
      }
      return { changed: r.previous !== null, email: r.email, role: "read", previousRole: r.previous ?? "read (no grant)" };
    },
  },
];

// Fail at load time, not at the first call.
for (const tool of GRANT_TOOLS) assertSupportedSchema(tool.inputSchema, `${tool.name}.inputSchema`, { root: true });
