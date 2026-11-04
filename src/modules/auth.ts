/**
 * WHO MAY DO WHAT (2026-10-22: Supabase accounts; before, one shared key).
 *
 *   what a phone reads       `/api/app/*`, `/cdn/*`, `/api/health`: anyone
 *   a parent's own account   `/api/me…`: that account's access token
 *   the panel                everything else, for
 *                              - a signed-in account whose e-mail is on the
 *                                ADMINS list (`accounts.ts`; one role, user
 *                                decision) -- 403 ADMIN_FORBIDDEN for any
 *                                other account: signed in, but not a panel's
 *                              - ADMIN_TOKEN, when set: a machine's key (the
 *                                build pipeline's `PUT /inventory`, the restore
 *                                drill), never a person's login once there are
 *                                accounts
 *                              - nobody at all, while there are neither
 *                                accounts nor a key and the server listens on
 *                                127.0.0.1 only (development, as before)
 *
 * No key ever travels in a URL (S10): URLs end up in logs, history and
 * referrers. An <img> or <audio> cannot send a header, so the panel asks for a
 * MEDIA token (`GET /api/auth/media`): valid for an hour and only for reading
 * a file (`GET /api/assets/:id`), signed with a key of its own (derived from
 * ADMIN_TOKEN, or this database's own secret). The request log redacts it.
 *
 * A refused panel request answers `{ code: "ADMIN_UNAUTHORIZED" }`: the panel
 * shows its login only for that code -- a provider's own 401 (a wrong
 * ElevenLabs key) is a different code and never logs the panel out (S09).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { meta } from "../storage/sql.js";
import { accountsOn, NotSignedIn, verifyToken, type Who } from "../storage/supabase.js";
import { adminFor } from "./accounts.js";

/** what anyone may read: published content, files by hash, the health line */
const PUBLIC = [/^\/api\/app\//, /^\/cdn\//, /^\/api\/health$/];
/** a parent's own account: any signed-in account, for itself only */
const OWN = /^\/api\/me(\/|$)/;
/** what a media token may read */
const MEDIA = /^\/api\/assets\/[a-zA-Z0-9_-]{1,80}$/;
export const MEDIA_TTL_MS = 60 * 60 * 1000;

const same = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function tokenOf(req: FastifyRequest): string {
  const h = req.headers.authorization ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

/* ── who is asking ────────────────────────────────────────────────────────── */

/** how the panel request came in, for the audit and for "who am I" */
export interface Caller { actor: string; via: "account" | "key" | "open"; who: Who | null; name?: string }
const callers = new WeakMap<FastifyRequest, Caller>();
export const callerOf = (req: FastifyRequest): Caller => callers.get(req) ?? { actor: "?", via: "open", who: null };
const owners = new WeakMap<FastifyRequest, Who>();
/** the signed-in account of a `/api/me` request */
export const ownerOf = (req: FastifyRequest): Who => owners.get(req)!;

/** the panel needs nobody's key: no accounts, no key, local only */
export const panelOpen = () => !config.adminToken && !accountsOn();

/* ── media tokens ─────────────────────────────────────────────────────────── */

/* the media key is derived, so a leaked media token says nothing about any
   other key; without ADMIN_TOKEN it is a random secret kept in the database */
let secret = "";
export async function initMediaKey() {
  if (config.adminToken) { secret = config.adminToken; return; }
  let s = await meta.get("media-key");
  if (!s) { s = randomBytes(32).toString("hex"); await meta.set("media-key", s); }
  secret = s;
}
const mediaKey = () => createHash("sha256").update(`loplop-media:${secret}`).digest();
const sign = (exp: number) => createHmac("sha256", mediaKey()).update(`media:${exp}`).digest("base64url");

export function mediaToken(now = Date.now()): { token: string; expiresAt: number } {
  const exp = now + MEDIA_TTL_MS;
  return { token: `${exp}.${sign(exp)}`, expiresAt: exp };
}

export function mediaTokenOk(t: unknown, now = Date.now()): boolean {
  /* a query string can carry the parameter twice (an array): never a 500,
     just not a token */
  if (typeof t !== "string" || !secret) return false;
  const [e, sig] = t.split(".");
  const exp = Number(e);
  if (!sig || !Number.isFinite(exp) || exp < now || exp > now + MEDIA_TTL_MS + 60_000) return false;
  return same(sig, sign(exp));
}

/* ── the gate ─────────────────────────────────────────────────────────────── */

/**
 * Who this token opens the panel for: a caller; "forbidden" (a signed-in
 * account that is not an admin); "bad" (not a token of this project); or
 * null (no token -- open only while the panel is open).
 */
export async function panelCaller(token: string): Promise<Caller | "forbidden" | "bad" | null> {
  if (config.adminToken && token && same(token, config.adminToken)) return { actor: "anahtar", via: "key", who: null };
  if (accountsOn() && token) {
    let who: Who;
    try { who = await verifyToken(token); }
    catch (e) { if (e instanceof NotSignedIn) return "bad"; throw e; }
    const a = who.verified ? await adminFor(who) : null;
    return a ? { actor: who.email, via: "account", who, name: a.name } : "forbidden";
  }
  if (panelOpen()) return { actor: "yerel", via: "open", who: null };
  return token ? "bad" : null;
}

const refuse = (reply: FastifyReply) => reply.code(401).send({ error: "Giriş gerekli", code: "ADMIN_UNAUTHORIZED" });

export function installAuth(app: FastifyInstance) {
  const local = config.host === "127.0.0.1" || config.host === "localhost";
  if (!local && panelOpen())
    throw new Error(`HOST=${config.host} ile ne hesaplar (SUPABASE_URL) ne ADMIN_TOKEN var: panelin uçları o ağa açık kalırdı.`);
  /* reachable from outside (directly, or behind a proxy in production): a
     key must be a real secret (openssl rand -hex 32) */
  if (config.adminToken && (!local || process.env.NODE_ENV === "production") && config.adminToken.length < 32)
    throw new Error("ADMIN_TOKEN çok kısa: dışarıya açık bir sunucuda en az 32 karakterlik rastgele bir değer olmalı (openssl rand -hex 32).");

  app.addHook("onRequest", async (req, reply) => {
    const p = req.url.split("?")[0]!;
    if (PUBLIC.some((r) => r.test(p))) return;
    const token = tokenOf(req);

    /* a parent's own account */
    if (OWN.test(p)) {
      try { owners.set(req, await verifyToken(token)); return; }
      catch (e) {
        if (!(e instanceof NotSignedIn)) throw e;
        return reply.code(401).send({ error: accountsOn() ? "Giriş gerekli" : "Hesaplar bu sunucuda kurulmadı.",
                                      code: accountsOn() ? "SIGNED_OUT" : "ACCOUNTS_OFF" });
      }
    }

    /* the panel */
    const c = await panelCaller(token);
    if (c === "forbidden") return reply.code(403).send({ code: "ADMIN_FORBIDDEN",
      error: "Bu hesap panelin yöneticileri arasında değil. Bir yöneticiden sizi eklemesini isteyin." });
    if (c === "bad") return refuse(reply);
    if (c) { callers.set(req, c); return; }
    const m = (req.query as { m?: string }).m;
    if (m && (req.method === "GET" || req.method === "HEAD") && MEDIA.test(p) && mediaTokenOk(m)) return;
    return refuse(reply);
  });
}

export async function authRoutes(app: FastifyInstance) {
  /* a media token for <img>/<audio>/<video>; null when the panel is open (no one signs in) */
  app.get("/auth/media", async () => (panelOpen() ? { token: null, expiresAt: null } : mediaToken()));
  /* who the panel is open for */
  app.get("/auth/me", async (req) => {
    const c = callerOf(req);
    return { via: c.via, email: c.who?.email ?? null, name: c.name ?? null, accounts: accountsOn() };
  });
}
