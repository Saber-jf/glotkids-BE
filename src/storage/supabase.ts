/**
 * SUPABASE AUTH, from the server's side (2026-10-22).
 *
 * Supabase keeps the accounts: e-mail, the sign-in (a code by e-mail, Google,
 * Apple), bans. A signed-in panel or phone sends its ACCESS TOKEN (a JWT);
 * this file says whose it is, or that it is not one:
 *
 *   signed with the project's published keys  (ES256/RS256, `jwks.json`)
 *   or with the old shared secret             (HS256, SUPABASE_JWT_SECRET)
 *   issued by this project                    iss = <url>/auth/v1
 *   for a signed-in user                      aud = authenticated
 *   not expired
 *
 * And the ADMIN API (the service role key, this process only): list, read,
 * create, ban and delete accounts -- what the panel's "Kullanıcılar" does and
 * what deleting an account from the app needs.
 */
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from "jose";
import { config } from "../config.js";

export const accountsOn = () => !!config.supabase.url;

/** a signed-in person, as the token says */
export interface Who {
  id: string;
  email: string;
  /** how they signed in: email, google, apple */
  provider: string;
  /** the e-mail is the person's (confirmed, or vouched for by Google/Apple) */
  verified: boolean;
}

export class NotSignedIn extends Error {}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
const keys = () => (jwks ??= createRemoteJWKSet(new URL(`${config.supabase.url}/auth/v1/.well-known/jwks.json`),
                                                { cooldownDuration: 30_000, cacheMaxAge: 10 * 60_000 }));

/** whose token this is -- or NotSignedIn */
export async function verifyToken(token: string): Promise<Who> {
  if (!accountsOn() || !token || token.split(".").length !== 3) throw new NotSignedIn("token yok");
  let payload: JWTPayload;
  const opts = { issuer: `${config.supabase.url}/auth/v1`, audience: "authenticated" };
  try {
    const alg = decodeProtectedHeader(token).alg;
    if (alg === "HS256") {
      if (!config.supabase.jwtSecret) throw new NotSignedIn("HS256 anahtarı yok");
      payload = (await jwtVerify(token, new TextEncoder().encode(config.supabase.jwtSecret), { ...opts, algorithms: ["HS256"] })).payload;
    } else {
      payload = (await jwtVerify(token, keys(), { ...opts, algorithms: ["ES256", "RS256", "EdDSA"] })).payload;
    }
  } catch (e) {
    throw e instanceof NotSignedIn ? e : new NotSignedIn((e as Error).message);
  }
  const p = payload as JWTPayload & { email?: string; app_metadata?: { provider?: string }; user_metadata?: { email_verified?: boolean } };
  if (!p.sub) throw new NotSignedIn("sub yok");
  const provider = p.app_metadata?.provider ?? "email";
  return {
    id: p.sub, email: (p.email ?? "").toLowerCase(), provider,
    /* an e-mail code proves the address; Google and Apple vouch for theirs */
    verified: provider !== "email" || p.user_metadata?.email_verified !== false,
  };
}

/* ── the admin API ────────────────────────────────────────────────────────── */

export interface AuthUser {
  id: string; email: string; provider: string;
  createdAt: number; lastSignInAt: number | null;
  /** banned until (ms), or null */
  bannedUntil: number | null;
}

export class AuthApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

interface RawUser {
  id: string; email?: string; created_at?: string; last_sign_in_at?: string | null; banned_until?: string | null;
  app_metadata?: { provider?: string; providers?: string[] };
}

const ms = (t: string | null | undefined) => (t ? Date.parse(t) || null : null);
const asUser = (u: RawUser): AuthUser => ({
  id: u.id, email: (u.email ?? "").toLowerCase(), provider: u.app_metadata?.provider ?? "email",
  createdAt: ms(u.created_at) ?? 0, lastSignInAt: ms(u.last_sign_in_at),
  bannedUntil: ms(u.banned_until) && (ms(u.banned_until)! > Date.now()) ? ms(u.banned_until) : null,
});

async function admin(path: string, init: RequestInit = {}): Promise<unknown> {
  return (await adminRaw(path, init)).body;
}

async function adminRaw(path: string, init: RequestInit = {}): Promise<{ body: unknown; headers: Headers }> {
  if (!accountsOn()) throw new AuthApiError(503, "Hesaplar kurulmadı (SUPABASE_URL yok).");
  let r: Response;
  try {
    r = await fetch(`${config.supabase.url}/auth/v1${path}`, {
      ...init,
      /* the new secret keys (`sb_secret_…`) are not JWTs: they go in `apikey`
         only, never as a Bearer (Supabase rejects or rewrites that). The old
         service_role key is a JWT and keeps both, as before. */
      headers: { apikey: config.supabase.serviceKey,
                 ...(config.supabase.serviceKey.startsWith("sb_") ? {} : { Authorization: `Bearer ${config.supabase.serviceKey}` }),
                 "Content-Type": "application/json", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    throw new AuthApiError(502, `Supabase'e ulaşılamadı: ${(e as Error).message}`);
  }
  const text = await r.text();
  const body = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null;
  if (!r.ok) {
    const b = body as { msg?: string; message?: string; error_description?: string; error?: string } | null;
    throw new AuthApiError(r.status, b?.msg ?? b?.message ?? b?.error_description ?? b?.error ?? `Supabase ${r.status}`);
  }
  return { body, headers: r.headers };
}

/** one page of accounts (Supabase's order: newest first), and how many there are in all */
export async function listUsers(page: number, perPage: number): Promise<{ users: AuthUser[]; total: number | null }> {
  const r = await adminRaw(`/admin/users?page=${page}&per_page=${perPage}`);
  const b = r.body as { users?: RawUser[] };
  /* Supabase says the count in a header */
  const total = Number(r.headers.get("x-total-count"));
  return { users: (b.users ?? []).map(asUser), total: Number.isFinite(total) && r.headers.has("x-total-count") ? total : null };
}

export async function getUser(id: string): Promise<AuthUser | null> {
  try { return asUser(await admin(`/admin/users/${encodeURIComponent(id)}`) as RawUser); }
  catch (e) { if (e instanceof AuthApiError && e.status === 404) return null; throw e; }
}

/** an account for this e-mail, confirmed -- so its owner can sign in with a code; the existing one if there is */
export async function ensureUser(email: string): Promise<{ created: boolean }> {
  try {
    await admin("/admin/users", { method: "POST", body: JSON.stringify({ email, email_confirm: true }) });
    return { created: true };
  } catch (e) {
    /* "already registered": nothing to do */
    if (e instanceof AuthApiError && (e.status === 422 || e.status === 409)) return { created: false };
    throw e;
  }
}

/** the account of this e-mail, looked for page by page (the admin API has no lookup by e-mail) */
export async function findUserByEmail(email: string): Promise<AuthUser | null> {
  const want = email.trim().toLowerCase();
  for (let page = 1; page <= 200; page++) {
    const { users } = await listUsers(page, 200);
    const u = users.find((x) => x.email?.toLowerCase() === want);
    if (u) return u;
    if (users.length < 200) return null;
  }
  return null;
}

/** the minimum a panel password must be (Supabase's own default is 6) */
export const MIN_PASSWORD = 8;

/**
 * An admin's password (2026-11-14: the panel signs in with e-mail and
 * password -- the e-mail code needs a template the project's role could not
 * change). The account is made, confirmed, if there is none. The password
 * goes to Supabase and nowhere else: never logged, never stored here.
 */
export async function setPassword(email: string, password: string): Promise<{ created: boolean }> {
  if (password.length < MIN_PASSWORD) throw new AuthApiError(400, `Şifre en az ${MIN_PASSWORD} karakter olmalı.`);
  const { created } = await ensureUser(email);
  const u = await findUserByEmail(email);
  if (!u) throw new AuthApiError(404, "Bu e-postanın hesabı bulunamadı.");
  await admin(`/admin/users/${encodeURIComponent(u.id)}`, { method: "PUT", body: JSON.stringify({ password }) });
  return { created };
}

/** a ban for (practically) ever, or none */
export async function setBanned(id: string, banned: boolean): Promise<void> {
  await admin(`/admin/users/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify({ ban_duration: banned ? "876000h" : "none" }) });
}

export async function deleteUser(id: string): Promise<void> {
  try { await admin(`/admin/users/${encodeURIComponent(id)}`, { method: "DELETE" }); }
  catch (e) { if (!(e instanceof AuthApiError && e.status === 404)) throw e; }
}
