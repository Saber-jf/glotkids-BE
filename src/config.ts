/**
 * Settings, from the environment. A `.env` next to package.json is read if it
 * exists; the AI keys can also be entered from the panel, which stores them in
 * `data/secrets.json` -- never sent back out.
 */
import { existsSync } from "node:fs";
import path from "node:path";

/* never in a test: a test server gets exactly what the test hands it, and a
   developer's `.env` (a network HOST, a real DATABASE_URL) must not leak in */
if (existsSync(".env") && process.env.NODE_ENV !== "test") process.loadEnvFile(".env");

export const config = {
  port: Number(process.env.PORT ?? 8787),
  /* local only unless told otherwise: the panel's endpoints need ADMIN_TOKEN
     before this listens anywhere else */
  host: process.env.HOST ?? "127.0.0.1",
  dataDir: path.resolve(process.env.DATA_DIR ?? "./data"),
  /** how many earlier versions of the studio document are kept */
  history: Number(process.env.HISTORY ?? 50),
  /**
   * The app's folder, in development: its `app-inventory.json` (what that
   * build can play, `npm run inventory`) is taken in at every start, and its
   * bundled word pictures with it. In production the build pipeline sends the
   * same file to `PUT /api/inventory` instead.
   */
  appDir: process.env.APP_DIR ? path.resolve(process.env.APP_DIR) : path.resolve("../loplop"),
  /**
   * The panel's key. Unset: every endpoint is open, which is only safe on
   * 127.0.0.1. Set: the panel's endpoints want `Authorization: Bearer <it>`;
   * what a phone reads (`/api/app/*`, `/cdn/*`) stays public -- it is only
   * ever what was published.
   */
  adminToken: process.env.ADMIN_TOKEN ?? "",
  /**
   * Where phones download files from, if not this server: a media origin of
   * its own (`https://media.example.org`, decision 4) -- later an R2 bucket
   * behind a custom domain. Empty: the manifest names `/cdn/...` on the API
   * address. Only releases published after it is set use it.
   */
  cdnBase: (process.env.CDN_BASE ?? "").replace(/\/+$/, ""),
  /** below this much free disk, /api/health says so (bytes) */
  diskWarnBytes: Number(process.env.DISK_WARN_BYTES ?? 2 * 1024 ** 3),
  /**
   * The database (`storage/sql.ts`): a PostgreSQL connection string,
   * `postgres://user:password@host:5432/dbname?sslmode=require`. Empty: an
   * embedded Postgres in `DATA_DIR/pgdata` -- development and tests only.
   */
  databaseUrl: process.env.DATABASE_URL ?? "",
  /** how many connections the server keeps open to it */
  dbPool: Math.max(1, Number(process.env.DATABASE_POOL ?? 10)),
  /**
   * TLS to the database, over the URL's `sslmode=` (`sql.ts` → `tlsOf`):
   * "require" (encrypted, the certificate not checked -- what most hosted
   * Postgres connection strings mean), "verify" (checked, against
   * DATABASE_SSL_CA when given), or empty (as the URL says).
   */
  dbSsl: (process.env.DATABASE_SSL ?? "") as "" | "require" | "verify",
  /** the database provider's certificate (a file), for DATABASE_SSL=verify */
  dbSslCa: process.env.DATABASE_SSL_CA ?? "",
  /**
   * One server per database (`storage/owner.ts`): how long a starting server
   * waits for another one's lock (a deploy's old process stopping) before it
   * refuses to start.
   */
  dbLockWaitMs: Math.max(0, Number(process.env.DATABASE_LOCK_WAIT_MS ?? 20_000)),
  /** "1": bind the database to THIS data folder, though it names another (a person's decision) */
  dbRebind: process.env.DATABASE_REBIND === "1",
  /**
   * ACCOUNTS (Supabase Auth, 2026-10-22; `modules/accounts.ts`). Unset: no
   * accounts -- the panel is opened by ADMIN_TOKEN (or nothing, on
   * 127.0.0.1) and the app's parent account says it is not available.
   *   SUPABASE_URL               https://<proje>.supabase.co
   *   SUPABASE_ANON_KEY          the public key: handed to the panel and the app
   *   SUPABASE_SERVICE_ROLE_KEY  the server's own: lists, bans and deletes
   *                              accounts -- never leaves this process
   *   SUPABASE_JWT_SECRET        only for a project still signing with the old
   *                              shared secret (HS256); newer ones publish keys
   */
  supabase: {
    url: (process.env.SUPABASE_URL ?? "").replace(/\/+$/, ""),
    anonKey: process.env.SUPABASE_ANON_KEY ?? "",
    serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    jwtSecret: process.env.SUPABASE_JWT_SECRET ?? "",
  },
  /** the panel's first administrators, by e-mail (comma separated): added at every start, never removed */
  adminEmails: (process.env.ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
  /** the sign-in buttons the panel and the app show: email (a code by e-mail), google, apple */
  authProviders: (process.env.AUTH_PROVIDERS ?? "email,google,apple").split(",").map((p) => p.trim()).filter((p) => ["email", "google", "apple"].includes(p)),
};

/* production runs on a real database server: the embedded one is a single
   file-backed process, with no backups of its own and no second machine */
if (process.env.NODE_ENV === "production" && !config.databaseUrl)
  throw new Error("NODE_ENV=production: DATABASE_URL gerekli (PostgreSQL bağlantı adresi). Gömülü veritabanı yalnız geliştirme ve testler içindir.");

/* accounts half set up would let people sign in and then fail at the first
   thing they do (and an account could not be deleted, which a store requires) */
if (config.supabase.url && (!config.supabase.anonKey || !config.supabase.serviceKey))
  throw new Error("SUPABASE_URL verilmiş ama SUPABASE_ANON_KEY ya da SUPABASE_SERVICE_ROLE_KEY yok: hesaplar yarım kurulamaz.");
