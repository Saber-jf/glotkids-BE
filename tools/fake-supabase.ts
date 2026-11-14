/**
 * A FAKE SUPABASE AUTH (GoTrue) for the tests and for trying the sign-in
 * before a real project exists (2026-10-22). It speaks the parts of the real
 * one the server, the panel (supabase-js) and the app use:
 *
 *   /auth/v1/.well-known/jwks.json      the public key its tokens are signed with (ES256)
 *   POST /auth/v1/otp                   a 6-digit code "by e-mail" (here: printed, and kept)
 *   POST /auth/v1/verify                the code -> a session
 *   POST /auth/v1/token?grant_type=     password · refresh_token · pkce · id_token (Apple)
 *   GET  /auth/v1/authorize?provider=   Google/Apple in a browser: no consent page,
 *                                       straight back to redirect_to with a code
 *   GET  /auth/v1/user · POST /auth/v1/logout
 *   /auth/v1/admin/users[/:id]          list, create, read, ban, set a password, delete (service key)
 *
 *   npm run auth:fake        on 127.0.0.1:54321; prints the .env lines to use
 *                            and every code it "sends"
 *
 * Nothing here is used by the server itself: it is the other side of the wire.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { exportJWK, generateKeyPair, SignJWT, type JWK } from "jose";

export interface FakeUser {
  id: string; email: string; provider: string; createdAt: number; lastSignInAt: number | null;
  bannedUntil: number | null; confirmed: boolean;
  /** the panel's password sign-in (2026-11-14); a fake, kept as it is */
  password?: string;
}
export interface FakeSupabase {
  url: string; anonKey: string; serviceKey: string;
  /** the last code "sent" to each e-mail */
  codes: Map<string, string>;
  users: Map<string, FakeUser>;
  /** a session for this e-mail, as a sign-in would give (makes the account if needed) */
  signIn(email: string, provider?: string): Promise<{ access_token: string; refresh_token: string }>;
  close(): Promise<void>;
}

export async function startFakeSupabase(opts: { port?: number; log?: (m: string) => void } = {}): Promise<FakeSupabase> {
  const anonKey = "fake-anon-key", serviceKey = "fake-service-key";
  const { publicKey, privateKey } = await generateKeyPair("ES256");
  const kid = "fake-1";
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: "ES256", use: "sig" };
  const users = new Map<string, FakeUser>();
  const codes = new Map<string, string>();
  const refresh = new Map<string, string>();          /* refresh token -> user id */
  const authCodes = new Map<string, { user: string; challenge: string; method: string }>();
  let url = "";

  const byEmail = (email: string) => [...users.values()].find((u) => u.email === email.toLowerCase());
  const make = (email: string, provider = "email"): FakeUser => {
    const u: FakeUser = { id: randomUUID(), email: email.toLowerCase(), provider, createdAt: Date.now(), lastSignInAt: null,
                          bannedUntil: null, confirmed: true };
    users.set(u.id, u);
    return u;
  };
  const banned = (u: FakeUser) => !!u.bannedUntil && u.bannedUntil > Date.now();
  const raw = (u: FakeUser) => ({
    id: u.id, aud: "authenticated", role: "authenticated", email: u.email,
    email_confirmed_at: u.confirmed ? new Date(u.createdAt).toISOString() : null,
    created_at: new Date(u.createdAt).toISOString(), updated_at: new Date().toISOString(),
    last_sign_in_at: u.lastSignInAt ? new Date(u.lastSignInAt).toISOString() : null,
    banned_until: u.bannedUntil ? new Date(u.bannedUntil).toISOString() : null,
    app_metadata: { provider: u.provider, providers: [u.provider] }, user_metadata: { email_verified: true }, identities: [],
  });
  const session = async (u: FakeUser) => {
    u.lastSignInAt = Date.now();
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const access_token = await new SignJWT({ email: u.email, role: "authenticated", app_metadata: { provider: u.provider },
                                             user_metadata: { email_verified: true }, session_id: randomUUID() })
      .setProtectedHeader({ alg: "ES256", kid, typ: "JWT" }).setSubject(u.id).setIssuer(`${url}/auth/v1`)
      .setAudience("authenticated").setIssuedAt().setExpirationTime(exp).sign(privateKey);
    const refresh_token = randomUUID().replace(/-/g, "");
    refresh.set(refresh_token, u.id);
    return { access_token, token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token, user: raw(u) };
  };

  const send = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "Content-Type": "application/json", ...cors, ...headers });
    res.end(body === undefined ? "" : JSON.stringify(body));
  };
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
                 "Access-Control-Allow-Headers": "apikey,authorization,content-type,x-client-info,x-supabase-api-version",
                 "Access-Control-Expose-Headers": "x-total-count" };
  const err = (res: ServerResponse, status: number, msg: string, code = "") => send(res, status, { code: status, error_code: code, msg });
  const body = (req: IncomingMessage) => new Promise<Record<string, unknown>>((ok) => {
    let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch { ok({}); } });
  });

  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const p = u.pathname;
    if (req.method === "OPTIONS") return send(res, 204);
    if (p === "/auth/v1/.well-known/jwks.json") return send(res, 200, { keys: [jwk] });
    if (p === "/auth/v1/settings") return send(res, 200, { external: { email: true, google: true, apple: true }, disable_signup: false });
    /* Google/Apple in a browser: back at once, signed in as <provider>.user@ornek.test (or login_hint) */
    if (p === "/auth/v1/authorize") {
      const provider = u.searchParams.get("provider") ?? "google";
      const to = u.searchParams.get("redirect_to") ?? "/";
      const email = (u.searchParams.get("login_hint") ?? `${provider}.user@ornek.test`).toLowerCase();
      const usr = byEmail(email) ?? make(email, provider);
      if (banned(usr)) { res.writeHead(302, { Location: `${to}${to.includes("?") ? "&" : "?"}error=access_denied&error_description=User+is+banned` }); return res.end(); }
      const code = randomUUID();
      authCodes.set(code, { user: usr.id, challenge: u.searchParams.get("code_challenge") ?? "", method: u.searchParams.get("code_challenge_method") ?? "plain" });
      res.writeHead(302, { Location: `${to}${to.includes("?") ? "&" : "?"}code=${code}` });
      return res.end();
    }
    const key = String(req.headers.apikey ?? "");
    if (key !== anonKey && key !== serviceKey) return err(res, 401, "Invalid API key", "no_authorization");
    const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /, "");

    /* ── the admin API ── */
    if (p.startsWith("/auth/v1/admin/")) {
      if (bearer !== serviceKey) return err(res, 403, "User not allowed", "not_admin");
      const m = /^\/auth\/v1\/admin\/users(?:\/([^/]+))?$/.exec(p);
      if (!m) return err(res, 404, "Not found");
      if (!m[1] && req.method === "GET") {
        const page = Math.max(1, Number(u.searchParams.get("page") ?? 1)), per = Math.max(1, Number(u.searchParams.get("per_page") ?? 50));
        const list = [...users.values()].sort((a, b) => b.createdAt - a.createdAt);
        return send(res, 200, { users: list.slice((page - 1) * per, page * per).map(raw), aud: "authenticated" }, { "x-total-count": String(list.length) });
      }
      if (!m[1] && req.method === "POST") {
        const b = await body(req);
        const email = String(b.email ?? "").toLowerCase();
        if (!email) return err(res, 400, "email required");
        if (byEmail(email)) return err(res, 422, "A user with this email address has already been registered", "email_exists");
        const nu = make(email);
        if (typeof b.password === "string") nu.password = b.password;
        return send(res, 200, raw(nu));
      }
      const usr = users.get(decodeURIComponent(m[1] ?? ""));
      if (!usr) return err(res, 404, "User not found", "user_not_found");
      if (req.method === "GET") return send(res, 200, raw(usr));
      if (req.method === "DELETE") { users.delete(usr.id); return send(res, 200, {}); }
      if (req.method === "PUT") {
        const b = await body(req);
        if (typeof b.password === "string") usr.password = b.password;
        if (b.ban_duration === "none") usr.bannedUntil = null;
        else if (typeof b.ban_duration === "string") usr.bannedUntil = Date.now() + (parseInt(b.ban_duration, 10) || 1) * 3_600_000;
        return send(res, 200, raw(usr));
      }
      return err(res, 405, "Method not allowed");
    }

    /* ── signing in ── */
    if (p === "/auth/v1/otp" && req.method === "POST") {
      const b = await body(req);
      const email = String(b.email ?? "").toLowerCase();
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) return err(res, 400, "Unable to validate email address: invalid format", "validation_failed");
      let usr = byEmail(email);
      if (!usr && b.create_user === false) return err(res, 422, "Signups not allowed for otp", "otp_disabled");
      usr ??= make(email);
      if (banned(usr)) return err(res, 400, "User is banned", "user_banned");
      const code = String(Math.floor(100000 + Math.random() * 900000));
      codes.set(email, code);
      opts.log?.(`KOD  ${email}  →  ${code}`);
      return send(res, 200, {});
    }
    if (p === "/auth/v1/verify" && req.method === "POST") {
      const b = await body(req);
      const email = String(b.email ?? "").toLowerCase();
      const usr = byEmail(email);
      if (!usr || codes.get(email) !== String(b.token ?? "")) return err(res, 403, "Token has expired or is invalid", "otp_expired");
      codes.delete(email);
      if (banned(usr)) return err(res, 400, "User is banned", "user_banned");
      return send(res, 200, await session(usr));
    }
    if (p === "/auth/v1/token" && req.method === "POST") {
      const grant = u.searchParams.get("grant_type");
      const b = await body(req);
      let usr: FakeUser | undefined;
      if (grant === "password") {
        const cand = byEmail(String(b.email ?? ""));
        if (!cand || !cand.password || cand.password !== String(b.password ?? "")) return err(res, 400, "Invalid login credentials", "invalid_credentials");
        usr = cand;
      } else if (grant === "refresh_token") {
        const id = refresh.get(String(b.refresh_token ?? ""));
        refresh.delete(String(b.refresh_token ?? ""));
        usr = id ? users.get(id) : undefined;
        if (!usr) return err(res, 400, "Invalid Refresh Token: Refresh Token Not Found", "refresh_token_not_found");
      } else if (grant === "pkce") {
        const a = authCodes.get(String(b.auth_code ?? ""));
        authCodes.delete(String(b.auth_code ?? ""));
        const v = String(b.code_verifier ?? "");
        const want = a?.method.toLowerCase() === "s256" ? createHash("sha256").update(v).digest("base64url") : v;
        if (!a || (a.challenge && want !== a.challenge)) return err(res, 400, "invalid flow state", "flow_state_not_found");
        usr = users.get(a.user);
      } else if (grant === "id_token") {
        /* the fake's Apple token: "fake-apple:<e-mail>" */
        const m = /^fake-(apple|google):(.+)$/.exec(String(b.id_token ?? ""));
        if (!m) return err(res, 400, "Bad ID token", "bad_jwt");
        usr = byEmail(m[2]!) ?? make(m[2]!, m[1]!);
      } else return err(res, 400, "unsupported grant type");
      if (!usr) return err(res, 400, "User not found");
      if (banned(usr)) return err(res, 400, "User is banned", "user_banned");
      return send(res, 200, await session(usr));
    }
    if (p === "/auth/v1/user" && req.method === "GET") {
      try {
        const payload = JSON.parse(Buffer.from(bearer.split(".")[1] ?? "", "base64url").toString()) as { sub?: string };
        const usr = payload.sub ? users.get(payload.sub) : undefined;
        return usr ? send(res, 200, raw(usr)) : err(res, 401, "invalid JWT", "bad_jwt");
      } catch { return err(res, 401, "invalid JWT", "bad_jwt"); }
    }
    if (p === "/auth/v1/logout") return send(res, 204);
    return err(res, 404, `Not found: ${p}`);
  });

  await new Promise<void>((ok) => server.listen(opts.port ?? 0, "127.0.0.1", ok));
  const addr = server.address();
  url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : opts.port}`;
  return {
    url, anonKey, serviceKey, codes, users,
    signIn: async (email, provider = "email") => session(byEmail(email) ?? make(email, provider)),
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

/* npm run auth:fake */
if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const f = await startFakeSupabase({ port: Number(process.env.FAKE_SUPABASE_PORT ?? 54321), log: (m) => console.log(m) });
  console.log(`Sahte Supabase: ${f.url}  (yalnız deneme; hesaplar bellekte, kapatınca gider)
Sunucunun .env dosyasına:
  SUPABASE_URL=${f.url}
  SUPABASE_ANON_KEY=${f.anonKey}
  SUPABASE_SERVICE_ROLE_KEY=${f.serviceKey}
  ADMIN_EMAILS=<sizin e-postanız>
E-posta kodları buraya yazılır. Google/Apple düğmeleri onay sormadan <sağlayıcı>.user@ornek.test olarak döner.`);
}
