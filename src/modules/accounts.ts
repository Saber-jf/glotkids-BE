/**
 * ACCOUNTS (Supabase Auth, 2026-10-22).
 *
 *   ADMINS      who may open the panel: an e-mail list, one role (user
 *               decision). Added by an admin (or ADMIN_EMAILS at start); the
 *               account is made confirmed in Supabase so its owner can sign
 *               in with a code at once. Nobody removes themselves, and the
 *               last one is never removed.
 *   PARENTS     the app's accounts: optional, behind the grown-up's gate.
 *               They keep the child's PROGRESS -- the phone's own progress
 *               document (`../loplop/src/core/progress.ts`: a random profile
 *               id, words met, stops finished; no name, no birth date) -- so
 *               it survives a lost phone and continues on another. The phone
 *               merges; here it is stored whole, a version (`rev`) at a time:
 *               a write based on an older version is refused with the current
 *               one, never overwrites it.
 *   USERS       the panel's list of every account (Supabase's), with what
 *               this server knows of each; ban, unban, delete, forget the
 *               progress. Deleting an account in the app is the same delete
 *               (a store requires it to be possible in the app).
 *   AUDIT       every change to an account or to the admins, by whom.
 *
 *   app    GET /api/app/auth                          (public: how to sign in)
 *          GET /api/me · DELETE /api/me
 *          GET/PUT /api/me/progress
 *   admin  GET /api/admins · POST /api/admins · DELETE /api/admins/:email
 *          GET /api/users · GET/DELETE /api/users/:id
 *          POST /api/users/:id/ban · DELETE /api/users/:id/progress
 *          GET /api/audit
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { all, one, run, tx } from "../storage/sql.js";
import { accountsOn, AuthApiError, deleteUser, ensureUser, getUser, listUsers, setBanned,
         type AuthUser, type Who } from "../storage/supabase.js";
import { callerOf, ownerOf } from "./auth.js";

/* ── admins ───────────────────────────────────────────────────────────────── */

interface AdminRow { email: string; user_id: string | null; name: string; added_by: string; created_at: number; last_login_at: number | null }

/** the admin this account is, or null; binds the account to its row at the first sign-in */
export async function adminFor(who: Who): Promise<AdminRow | null> {
  if (!who.email) return null;
  const a = await one<AdminRow>("SELECT * FROM admins WHERE email = ?", who.email);
  if (!a) return null;
  /* the row is the e-mail's; an account that took over the address (deleted
     and made again) is a new account -- bound again, and said in the audit */
  const now = Date.now();
  if (a.user_id !== who.id || !a.last_login_at || now - a.last_login_at > 10 * 60_000) {
    await run("UPDATE admins SET user_id = ?, last_login_at = ? WHERE email = ?", who.id, now, who.email);
    if (a.user_id && a.user_id !== who.id) await audit(who.email, "admin.rebind", who.email, `eski hesap ${a.user_id}`);
  }
  return a;
}

/**
 * ADMIN_EMAILS: added at every start, never removed from here -- and each
 * gets its account in Supabase (confirmed), since the panel sends a code
 * only to an account that exists. The accounts are made in the background:
 * a Supabase that is away does not stop the server from starting.
 */
export async function seedAdmins(log: (m: string) => void = () => {}): Promise<number> {
  let n = 0;
  for (const email of config.adminEmails) {
    const r = await run("INSERT INTO admins(email, name, added_by, created_at) VALUES(?, '', 'ADMIN_EMAILS', ?) ON CONFLICT(email) DO NOTHING",
                        email, Date.now());
    if (r.changes) { n++; await audit("ADMIN_EMAILS", "admin.add", email, "açılışta"); }
  }
  if (accountsOn())
    void Promise.all(config.adminEmails.map((e) => ensureUser(e).catch((err: Error) =>
      log(`yönetici hesabı açılamadı (${e}): ${err.message} — Supabase'e ulaşılınca bir sonraki açılışta denenir`))));
  return n;
}

export async function audit(actor: string, action: string, target: string, detail = "") {
  await run("INSERT INTO audit(at, actor, action, target, detail) VALUES(?, ?, ?, ?, ?)", Date.now(), actor, action, target, detail.slice(0, 500));
}

/* ── parents and their progress ───────────────────────────────────────────── */

async function seen(who: Who) {
  const now = Date.now();
  await run(`INSERT INTO accounts(user_id, email, provider, created_at, last_seen_at) VALUES(?, ?, ?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET email = excluded.email, provider = excluded.provider, last_seen_at = excluded.last_seen_at`,
            who.id, who.email, who.provider, now, now);
}

interface BackupRow { user_id: string; data: string; schema: number; rev: number; bytes: number; device: string; updated_at: number }

/** a progress document as a person reads it: how many children, how far each */
export interface ProgressSummary {
  profiles: { label: string; stops: number; words: number; series: number; at: string | null }[];
}
export function summarize(data: string): ProgressSummary {
  try {
    const d = JSON.parse(data) as { profiles?: { label?: string; stops?: unknown[]; words?: object; series?: object; at?: string | null }[] };
    return { profiles: (Array.isArray(d.profiles) ? d.profiles : []).map((p) => ({
      label: String(p.label ?? "?"), stops: Array.isArray(p.stops) ? p.stops.length : 0,
      words: p.words && typeof p.words === "object" ? Object.keys(p.words).length : 0,
      series: p.series && typeof p.series === "object" ? Object.keys(p.series).length : 0,
      at: typeof p.at === "string" ? p.at : null })) };
  } catch { return { profiles: [] }; }
}

/** a whole progress document, at most this big (a child's progress is a few KB) */
export const PROGRESS_MAX_BYTES = 512 * 1024;

const Put = z.object({
  /** the version this write was based on; null: there was none */
  rev: z.number().int().min(0).nullable(),
  data: z.looseObject({ schema: z.number().int().min(1), profiles: z.array(z.unknown()).max(20) }),
  device: z.string().max(80).default(""),
});

/* ── routes ───────────────────────────────────────────────────────────────── */

const off = (reply: FastifyReply) =>
  reply.code(503).send({ code: "ACCOUNTS_OFF", error: "Hesaplar bu sunucuda kurulmadı (SUPABASE_URL, anahtarlar)." });
const authFail = (reply: FastifyReply, e: unknown) => {
  if (e instanceof AuthApiError) return reply.code(e.status >= 500 ? 502 : e.status).send({ code: "AUTH_PROVIDER", error: e.message });
  throw e;
};
const emailOk = z.string().trim().toLowerCase().email().max(200);

export async function accountRoutes(app: FastifyInstance) {
  /* how to sign in: public, the panel and the app read it before anyone has */
  app.get("/app/auth", async () => accountsOn()
    ? { enabled: true, url: config.supabase.url, anonKey: config.supabase.anonKey, providers: config.authProviders }
    : { enabled: false, url: null, anonKey: null, providers: [] });

  /* ── the parent's own account ── */
  app.get("/me", async (req) => {
    const who = ownerOf(req);
    await seen(who);
    const b = await one<BackupRow>("SELECT rev, bytes, updated_at, device FROM progress_backups WHERE user_id = ?", who.id);
    return { id: who.id, email: who.email, provider: who.provider,
             backup: b ? { rev: b.rev, bytes: b.bytes, updatedAt: b.updated_at, device: b.device } : null };
  });

  app.get("/me/progress", async (req, reply) => {
    const who = ownerOf(req);
    await seen(who);
    const b = await one<BackupRow>("SELECT * FROM progress_backups WHERE user_id = ?", who.id);
    if (!b) return reply.code(404).send({ code: "NO_BACKUP", error: "Bu hesapta yedek yok." });
    return { rev: b.rev, updatedAt: b.updated_at, device: b.device, data: JSON.parse(b.data) };
  });

  app.put("/me/progress", (req, reply) => tx(async () => {
    const who = ownerOf(req);
    const b = Put.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: `Geçersiz ilerleme belgesi: ${b.error.issues[0]?.message ?? ""}` });
    const text = JSON.stringify(b.data.data);
    if (Buffer.byteLength(text) > PROGRESS_MAX_BYTES) return reply.code(413).send({ error: "İlerleme belgesi çok büyük." });
    await seen(who);
    const cur = await one<BackupRow>("SELECT * FROM progress_backups WHERE user_id = ?", who.id);
    /* written from an older version: the phone merges the current one and tries again */
    if ((cur?.rev ?? null) !== b.data.rev)
      return reply.code(409).send({ code: "STALE", error: "Yedek başka bir cihazdan değişti.",
                                    current: cur ? { rev: cur.rev, updatedAt: cur.updated_at, data: JSON.parse(cur.data) } : null });
    const rev = (cur?.rev ?? 0) + 1, now = Date.now();
    await run(`INSERT INTO progress_backups(user_id, data, schema, rev, bytes, device, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, schema = excluded.schema, rev = excluded.rev,
                 bytes = excluded.bytes, device = excluded.device, updated_at = excluded.updated_at`,
              who.id, text, b.data.data.schema, rev, Buffer.byteLength(text), b.data.device, now);
    return { rev, updatedAt: now };
  }));

  /* the account deleted from the app: the account itself (Supabase) and everything kept here */
  app.delete("/me", async (req, reply) => {
    const who = ownerOf(req);
    if (who.email && await one("SELECT email FROM admins WHERE email = ?", who.email))
      return reply.code(409).send({ code: "IS_ADMIN", error: "Bu hesap panelin bir yöneticisi: uygulamadan silinemez. Önce yöneticilerden çıkarılmalı." });
    try { await deleteUser(who.id); } catch (e) { return authFail(reply, e); }
    await run("DELETE FROM accounts WHERE user_id = ?", who.id);
    await audit(who.email || who.id, "account.delete", who.id, "uygulamadan, kendisi");
    return { ok: true };
  });

  /* ── the panel: admins ── */
  app.get("/admins", async () => (await all<AdminRow>("SELECT * FROM admins ORDER BY created_at, email")).map((a) => ({
    email: a.email, name: a.name, addedBy: a.added_by, createdAt: a.created_at, lastLoginAt: a.last_login_at, bound: !!a.user_id,
    seeded: config.adminEmails.includes(a.email) })));

  app.post("/admins", async (req, reply) => {
    const b = z.object({ email: emailOk, name: z.string().trim().max(80).default("") }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "Geçerli bir e-posta yazın." });
    const me = callerOf(req).actor;
    const r = await tx(async () => {
      if (await one("SELECT email FROM admins WHERE email = ?", b.data.email)) return null;
      await run("INSERT INTO admins(email, name, added_by, created_at) VALUES(?, ?, ?, ?)", b.data.email, b.data.name, me, Date.now());
      await audit(me, "admin.add", b.data.email, b.data.name);
      return true;
    });
    if (!r) return reply.code(409).send({ error: "Bu e-posta zaten yöneticiler arasında." });
    /* the account, confirmed, so the code sign-in works at once (outside the transaction: the network) */
    let account: "created" | "existing" | "later" = "later";
    if (accountsOn()) {
      try { account = (await ensureUser(b.data.email)).created ? "created" : "existing"; }
      catch { account = "later"; }
    }
    reply.code(201);
    return { email: b.data.email, account };
  });

  app.delete("/admins/:email", (req, reply) => tx(async () => {
    const email = decodeURIComponent((req.params as { email: string }).email).toLowerCase();
    const me = callerOf(req);
    if (me.who?.email === email) return reply.code(400).send({ error: "Kendinizi yöneticilerden çıkaramazsınız." });
    if (config.adminEmails.includes(email))
      return reply.code(400).send({ error: "Bu e-posta sunucunun ayarında (ADMIN_EMAILS): oradan çıkarılmadıkça her açılışta geri eklenir." });
    const n = (await one<{ n: number }>("SELECT COUNT(*) AS n FROM admins"))!.n;
    if (!(await one("SELECT email FROM admins WHERE email = ?", email))) return reply.code(404).send({ error: "Böyle bir yönetici yok." });
    if (n <= 1) return reply.code(400).send({ error: "Son yönetici çıkarılamaz." });
    await run("DELETE FROM admins WHERE email = ?", email);
    await audit(me.actor, "admin.remove", email);
    return { ok: true };
  }));

  /* ── the panel: every account ── */
  const decorate = async (users: AuthUser[]) => {
    if (!users.length) return [];
    const ids = users.map((u) => u.id), marks = ids.map(() => "?").join(",");
    const [accs, backs, admins] = await Promise.all([
      all<{ user_id: string; last_seen_at: number }>(`SELECT user_id, last_seen_at FROM accounts WHERE user_id IN (${marks})`, ...ids),
      all<BackupRow>(`SELECT * FROM progress_backups WHERE user_id IN (${marks})`, ...ids),
      all<{ email: string }>("SELECT email FROM admins"),
    ]);
    const adminSet = new Set(admins.map((a) => a.email));
    return users.map((u) => {
      const b = backs.find((x) => x.user_id === u.id);
      return { ...u, admin: adminSet.has(u.email), lastSeenAt: accs.find((x) => x.user_id === u.id)?.last_seen_at ?? null,
               backup: b ? { rev: b.rev, bytes: b.bytes, updatedAt: b.updated_at, device: b.device, summary: summarize(b.data) } : null };
    });
  };

  app.get("/users", async (req, reply) => {
    if (!accountsOn()) return off(reply);
    const q = z.object({ page: z.coerce.number().int().min(1).default(1), perPage: z.coerce.number().int().min(1).max(200).default(50),
                         q: z.string().trim().toLowerCase().max(200).default("") }).parse(req.query);
    try {
      if (!q.q) {
        const r = await listUsers(q.page, q.perPage);
        return { users: await decorate(r.users), total: r.total, page: q.page, perPage: q.perPage };
      }
      /* a search: Supabase lists, it does not search -- look through at most 5000 */
      const hits: AuthUser[] = [];
      for (let p = 1; p <= 25; p++) {
        const r = await listUsers(p, 200);
        hits.push(...r.users.filter((u) => u.email.includes(q.q) || u.id === q.q));
        if (r.users.length < 200) break;
      }
      const from = (q.page - 1) * q.perPage;
      return { users: await decorate(hits.slice(from, from + q.perPage)), total: hits.length, page: q.page, perPage: q.perPage };
    } catch (e) { return authFail(reply, e); }
  });

  app.get("/users/:id", async (req, reply) => {
    if (!accountsOn()) return off(reply);
    const id = (req.params as { id: string }).id;
    let u: AuthUser | null;
    try { u = await getUser(id); } catch (e) { return authFail(reply, e); }
    if (!u) return reply.code(404).send({ error: "Böyle bir hesap yok." });
    const [d] = await decorate([u]);
    const events = await all("SELECT * FROM audit WHERE target = ? OR target = ? ORDER BY at DESC LIMIT 50", u.id, u.email);
    return { ...d, events };
  });

  app.post("/users/:id/ban", async (req, reply) => {
    if (!accountsOn()) return off(reply);
    const id = (req.params as { id: string }).id;
    const b = z.object({ banned: z.boolean() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "Geçersiz istek" });
    const me = callerOf(req);
    if (me.who?.id === id) return reply.code(400).send({ error: "Kendi hesabınızı engelleyemezsiniz." });
    try {
      const u = await getUser(id);
      if (!u) return reply.code(404).send({ error: "Böyle bir hesap yok." });
      await setBanned(id, b.data.banned);
      await audit(me.actor, b.data.banned ? "account.ban" : "account.unban", id, u.email);
      return (await decorate([(await getUser(id))!]))[0];
    } catch (e) { return authFail(reply, e); }
  });

  app.delete("/users/:id", async (req, reply) => {
    if (!accountsOn()) return off(reply);
    const id = (req.params as { id: string }).id;
    const me = callerOf(req);
    if (me.who?.id === id) return reply.code(400).send({ error: "Kendi hesabınızı buradan silemezsiniz." });
    try {
      const u = await getUser(id);
      if (u && await one("SELECT email FROM admins WHERE email = ?", u.email))
        return reply.code(409).send({ code: "IS_ADMIN", error: "Bu hesap bir yönetici: önce yöneticilerden çıkarın." });
      await deleteUser(id);
      await run("DELETE FROM accounts WHERE user_id = ?", id);
      await audit(me.actor, "account.delete", id, u?.email ?? "");
      return { ok: true };
    } catch (e) { return authFail(reply, e); }
  });

  app.delete("/users/:id/progress", async (req) => {
    const id = (req.params as { id: string }).id;
    const r = await run("DELETE FROM progress_backups WHERE user_id = ?", id);
    if (r.changes) await audit(callerOf(req).actor, "progress.delete", id);
    return { ok: true, deleted: r.changes > 0 };
  });

  app.get("/audit", async (req) => {
    const q = z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) }).parse(req.query);
    return all("SELECT * FROM audit ORDER BY at DESC, id DESC LIMIT ?", q.limit);
  });
}
