/**
 * THE DATABASE: PostgreSQL (2026-10-18; before that SQLite through `node:sqlite`).
 *
 *   DATABASE_URL set    a real Postgres server -- production (Supabase, a
 *                       managed Postgres, one of your own), through `pg`
 *   DATABASE_URL empty  an EMBEDDED Postgres (PGlite: the same Postgres,
 *                       compiled to WebAssembly) in `DATA_DIR/pgdata` -- for
 *                       development and the tests, nothing to install. Never
 *                       in production: `config.ts` refuses to start without
 *                       DATABASE_URL when NODE_ENV=production.
 *
 * Every table the server keeps is here, created by numbered migrations that
 * run once each, in order, each in its own transaction (Postgres DDL is
 * transactional: a migration lands whole or not at all).
 *
 * Why a relational database and not the JSON files it replaced: the content
 * is RELATIONAL -- a word belongs to sets, a set is played by games and
 * categories, a release points at assets -- and the files kept a copy of
 * every word in every game and every category. One word row, referenced
 * everywhere, is the whole point.
 *
 * THE CALLS. `all`, `one` and `run` take SQL with `?` placeholders (turned
 * into `$1, $2 …` here, so the queries read as they always did) and return
 * promises. `tx(f)` runs `f` in one transaction: every query `f` makes --
 * however deep, through any helper -- goes to that transaction's connection
 * (AsyncLocalStorage), and nothing else can write in between: a transaction
 * takes one database-wide lock first, as SQLite's `BEGIN IMMEDIATE` did. The
 * server's writes are a panel's clicks, few and short; one writer at a time
 * keeps every check-then-write as safe as it was when the calls were
 * synchronous. A transaction never waits on the network (an AI call) or on
 * the blob lock: those happen outside it, and only their result is written in one.
 *
 * READS IN ONE REQUEST are remembered (`requestScope`): the same query with
 * the same values is asked once per request, and any write in the request
 * forgets everything read so far. A panel screen that lists every category
 * with its words and checks asked the same set a dozen times; on a database
 * across a network that is the difference between a fast page and a slow one.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import path from "node:path";
import { config } from "../config.js";

type Row = Record<string, unknown>;
interface Result { rows: Row[]; rowCount: number }
interface Conn { query(text: string, params: unknown[]): Promise<Result> }
interface Client extends Conn { release(): void }
export interface Driver extends Conn {
  kind: "postgres" | "embedded";
  connect(): Promise<Client>;
  close(): Promise<void>;
}

/* ── the two drivers ──────────────────────────────────────────────────────── */

async function postgres(url: string): Promise<Driver> {
  const pg = (await import("pg")).default;
  /* a BIGINT (a millisecond time, a byte count, COUNT(*)) and a NUMERIC (SUM)
     are numbers here, as they were in SQLite -- never strings */
  pg.types.setTypeParser(20, (v) => Number(v));
  pg.types.setTypeParser(1700, (v) => Number(v));
  const { connectionString, ssl } = tlsOf(url);
  const pool = new pg.Pool({ connectionString, ssl, max: config.dbPool, connectionTimeoutMillis: 15_000, idleTimeoutMillis: 30_000 });
  /* an idle connection the server dropped is not a crash: the pool opens another */
  pool.on("error", (e) => console.error(`veritabanı bağlantısı koptu: ${e.message}`));
  const wrap = (r: { rows: Row[]; rowCount: number | null }): Result => ({ rows: r.rows, rowCount: r.rowCount ?? 0 });
  return {
    kind: "postgres",
    query: async (text, params) => wrap(await pool.query(text, params)),
    connect: async () => {
      const c = await pool.connect();
      return { query: async (text, params) => wrap(await c.query(text, params)), release: () => c.release() };
    },
    close: () => pool.end(),
  };
}

/**
 * TLS to the database, read here and not left to the driver: `pg` takes
 * `sslmode=require` in a URL as "verify the certificate against the
 * system's authorities", and a hosted Postgres with an authority of its own
 * (Supabase) then refuses every connection. So, as libpq means it:
 *   disable              no TLS
 *   require / prefer     encrypted, the certificate not checked
 *   verify-ca/-full      encrypted and checked -- against DATABASE_SSL_CA
 *                        (the provider's certificate file) when given
 * DATABASE_SSL (`require` / `verify`) wins over the URL.
 */
export function tlsOf(url: string): { connectionString: string; ssl: false | { rejectUnauthorized: boolean; ca?: string } | undefined } {
  let u: URL;
  try { u = new URL(url); } catch { return { connectionString: url, ssl: undefined }; }
  const mode = u.searchParams.get("sslmode") ?? "";
  for (const k of ["sslmode", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"]) u.searchParams.delete(k);
  const want = config.dbSsl || (mode === "disable" ? "off" : mode.startsWith("verify") ? "verify" : mode ? "require" : "");
  const ca = config.dbSslCa ? readFileSync(config.dbSslCa, "utf8") : undefined;
  const ssl = want === "off" ? false : want === "verify" ? { rejectUnauthorized: true, ...(ca ? { ca } : {}) }
    : want === "require" ? { rejectUnauthorized: false } : undefined;
  return { connectionString: u.toString(), ssl };
}

/** PGlite is ONE connection: a transaction holds it, every other query waits its turn */
async function embedded(dir: string): Promise<Driver> {
  const { PGlite, types } = await import("@electric-sql/pglite");
  const db = new PGlite(dir, { parsers: { [types.NUMERIC]: (v: string) => Number(v) } });
  await db.waitReady;
  let chain: Promise<unknown> = Promise.resolve();
  const turn = (): Promise<() => void> => {
    let free!: () => void;
    const mine = new Promise<void>((r) => { free = r; });
    const before = chain;
    chain = chain.then(() => mine);
    return before.then(() => free);
  };
  const q = async (text: string, params: unknown[]): Promise<Result> => {
    const r = await db.query<Row>(text, params);
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  };
  return {
    kind: "embedded",
    query: async (text, params) => { const free = await turn(); try { return await q(text, params); } finally { free(); } },
    connect: async () => { const free = await turn(); return { query: q, release: free }; },
    close: () => db.close(),
  };
}

/* ── opening ──────────────────────────────────────────────────────────────── */

/** a database other than the server's own: a copy's source (`copy.ts`) */
export async function openOther(spec: { url: string } | { dir: string }): Promise<Driver> {
  return "url" in spec ? postgres(spec.url) : embedded(spec.dir);
}

let opening: Promise<Driver> | null = null;
let driver: Driver | null = null;

/** open the database and bring its tables up to date (once; later calls share it) */
export function openDb(): Promise<Driver> {
  opening ??= (async () => {
    const d = config.databaseUrl ? await postgres(config.databaseUrl) : await embedded(path.join(config.dataDir, "pgdata"));
    await migrate(d);
    driver = d;
    return d;
  })();
  return opening;
}

/** which database this is, for /api/health and the logs (never the password) */
export function dbInfo(): { kind: "postgres" | "embedded"; where: string } {
  if (!config.databaseUrl) return { kind: "embedded", where: path.join(config.dataDir, "pgdata") };
  try {
    const u = new URL(config.databaseUrl);
    return { kind: "postgres", where: `${u.hostname}${u.port ? ":" + u.port : ""}${u.pathname}` };
  } catch { return { kind: "postgres", where: "(adres okunamadı)" }; }
}

export async function closeDb() {
  const d = driver ?? (opening ? await opening.catch(() => null) : null);
  driver = null; opening = null;
  await d?.close();
}

const ready = async (): Promise<Driver> => driver ?? openDb();

/* ── `?` → `$n` ───────────────────────────────────────────────────────────── */

const converted = new Map<string, string>();
/** the `?`s outside quotes, numbered; a `?` inside a string literal stays */
export function toDollars(sql: string): string {
  const hit = converted.get(sql);
  if (hit !== undefined) return hit;
  let out = "", n = 0, quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i]!;
    if (quote) {
      out += c;
      if (c === quote) {
        if (sql[i + 1] === quote) { out += quote; i++; }   /* '' or "" inside */
        else quote = null;
      }
    } else if (c === "'" || c === '"') { quote = c; out += c; }
    else if (c === "?") out += `$${++n}`;
    else out += c;
  }
  converted.set(sql, out);
  return out;
}

/* a value as Postgres takes it: undefined is NULL; a boolean is 1/0, as the
   flag columns were in SQLite */
const param = (v: unknown) => (v === undefined ? null : typeof v === "boolean" ? (v ? 1 : 0) : v);

/* ── the transaction and the request in scope ─────────────────────────────── */

interface Scope { client?: Conn; reads?: Map<string, Promise<Row[]>> }
const scope = new AsyncLocalStorage<Scope>();

/** run a request's work with a read memory of its own (`app.ts` puts every request in one) */
export const requestScope = <T>(f: () => T): T => scope.run({ reads: new Map() }, f);

/** the lock every writing transaction takes first ("loplop" in ASCII) */
const WRITER_LOCK = 0x6c6f706c6f70;

/**
 * Run `f` in one transaction: all of it, or none of it. One at a time (the
 * writer lock). A transaction inside a transaction is the same one.
 */
export async function tx<T>(f: () => Promise<T>): Promise<T> {
  const s = scope.getStore();
  if (s?.client) return f();
  const d = await ready();
  const c = await d.connect();
  /* what this request remembered may be about to change */
  s?.reads?.clear();
  try {
    await c.query("BEGIN", []);
    await c.query("SELECT pg_advisory_xact_lock($1)", [WRITER_LOCK]);
    const r = await scope.run({ client: c }, f);
    await c.query("COMMIT", []);
    return r;
  } catch (e) {
    await c.query("ROLLBACK", []).catch(() => {});
    throw e;
  } finally {
    s?.reads?.clear();
    c.release();
  }
}

/**
 * Read with one consistent view of the whole database (a backup): every
 * query `f` makes sees the database as it was when it began, whatever is
 * written meanwhile. Takes no writer lock -- the server keeps working.
 */
export async function snapshot<T>(f: () => Promise<T>): Promise<T> {
  const d = await ready();
  const c = await d.connect();
  try {
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", []);
    const r = await scope.run({ client: c }, f);
    await c.query("COMMIT", []);
    return r;
  } catch (e) {
    await c.query("ROLLBACK", []).catch(() => {});
    throw e;
  } finally { c.release(); }
}

/** the schema version: which migrations ran */
export const schemaVersion = async () => (await one<{ n: number }>("SELECT n FROM schema_version"))?.n ?? 0;

async function exec(sql: string, args: unknown[]): Promise<Result> {
  const conn = scope.getStore()?.client ?? await ready();
  return conn.query(toDollars(sql), args.map(param));
}

async function read(sql: string, args: unknown[]): Promise<Row[]> {
  const s = scope.getStore();
  if (s?.client || !s?.reads) return (await exec(sql, args)).rows;
  const reads = s.reads;
  const key = sql + "\u0000" + JSON.stringify(args.map(param));
  let p = reads.get(key);
  if (!p) {
    p = exec(sql, args).then((r) => r.rows);
    reads.set(key, p);
    p.catch(() => reads.delete(key));
  }
  /* a copy: a caller that changes a row changes only its own */
  return (await p).map((r) => ({ ...r }));
}

export const all = async <T = Row>(sql: string, ...args: unknown[]): Promise<T[]> =>
  (await read(sql, args)) as T[];
export const one = async <T = Row>(sql: string, ...args: unknown[]): Promise<T | undefined> =>
  (await read(sql, args))[0] as T | undefined;
/** a write: how many rows it touched, and what it RETURNING-ed */
export async function run(sql: string, ...args: unknown[]): Promise<{ changes: number; rows: Row[] }> {
  scope.getStore()?.reads?.clear();
  const r = await exec(sql, args);
  return { changes: r.rowCount, rows: r.rows };
}

export const meta = {
  get: async (key: string): Promise<string | undefined> =>
    (await one<{ value: string }>("SELECT value FROM meta WHERE key = ?", key))?.value,
  set: async (key: string, value: string): Promise<void> => {
    await run("INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  },
};

/** this database's own id: a panel's local copy names the server it came from */
let instance: string | null = null;
export async function instanceId(): Promise<string> {
  if (instance) return instance;
  let id = await meta.get("instance-id");
  if (!id) { id = crypto.randomUUID(); await meta.set("instance-id", id); }
  return (instance = id);
}

/* ── migrations: append only, never edit one that has shipped ─────────────── */

/*
 * Times are milliseconds since 1970 (BIGINT); flags are 0/1 (INTEGER); JSON
 * is kept as TEXT and read by the code, as before -- the move from SQLite
 * changed where the rows live, not their shape. The SQLite history of this
 * schema (its migrations 1-9, until 2026-10-17) is folded into migration 1;
 * `sqlite-import.ts` copies an old `loplop.db` in.
 */
export const MIGRATIONS: string[] = [
  /* 1 (2026-10-18): the whole model, as SQLite had it at its migration 9 */
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  -- every file: icons, backgrounds, recordings, music, films, mascots. The
  -- bytes are stored once per content hash (blobs/<sha256>.<ext>); an asset
  -- id is a name for those bytes, so two uploads of the same file share them.
  CREATE TABLE assets (
    id         TEXT PRIMARY KEY,
    sha256     TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('image', 'audio', 'video', 'animation')),
    mime       TEXT NOT NULL,
    ext        TEXT NOT NULL,
    size       BIGINT NOT NULL,
    name       TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL,
    md5        TEXT
  );
  CREATE INDEX assets_sha ON assets(sha256);

  -- THE VOCABULARY: one row per word, wherever it is used. The id is the
  -- word's stable name (the app's clip ids are built from it: teacher/en_<id>).
  CREATE TABLE words (
    id         TEXT PRIMARY KEY,
    en         TEXT NOT NULL,
    tr         TEXT NOT NULL,
    about      TEXT NOT NULL DEFAULT '',
    kind       TEXT NOT NULL DEFAULT 'thing',
    color      TEXT NOT NULL DEFAULT '#6D3FC8',
    icon       TEXT REFERENCES assets(id) ON DELETE SET NULL,
    builtin    INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );
  -- a word's recordings, by slot: en, tr, about, about1..3, otter, call
  CREATE TABLE word_audio (
    word_id     TEXT NOT NULL REFERENCES words(id) ON DELETE CASCADE,
    slot        TEXT NOT NULL,
    asset       TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    text        TEXT NOT NULL DEFAULT '',
    updated_at  BIGINT NOT NULL,
    duration_ms INTEGER,
    PRIMARY KEY (word_id, slot)
  );
  CREATE INDEX word_audio_asset ON word_audio(asset);

  -- a word set: the 5-7 words a series is built on (rule 11), in order
  CREATE TABLE sets (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    builtin    INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );
  CREATE TABLE set_words (
    set_id  TEXT NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
    word_id TEXT NOT NULL REFERENCES words(id) ON DELETE RESTRICT,
    pos     INTEGER NOT NULL,
    PRIMARY KEY (set_id, word_id)
  );
  CREATE INDEX set_words_word ON set_words(word_id);

  -- what one app build can play: its game engines (templates), live scenes,
  -- its own categories and words, its roadmap, its mascots' contract
  -- (app-inventory.json), kept per build so an old phone is never sent what
  -- it cannot run.
  CREATE TABLE capabilities (
    build       INTEGER PRIMARY KEY,
    version     TEXT NOT NULL,
    schema      INTEGER NOT NULL,
    data        TEXT NOT NULL,
    received_at BIGINT NOT NULL
  );

  -- a game the child sees: an engine (template) + words + presentation.
  -- builtin = one of the app's own (its content is in the bundle).
  CREATE TABLE games (
    id         TEXT PRIMARY KEY,
    template   TEXT NOT NULL,
    builtin    INTEGER NOT NULL DEFAULT 0,
    name       TEXT NOT NULL,
    subtitle   TEXT NOT NULL DEFAULT '',
    family     TEXT NOT NULL DEFAULT '',
    icon       TEXT REFERENCES assets(id) ON DELETE SET NULL,
    set_id     TEXT REFERENCES sets(id) ON DELETE SET NULL,
    config     TEXT NOT NULL DEFAULT '{}',
    status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('live', 'draft', 'hidden')),
    ord        INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );

  -- a series: its words (a set) and the steps the child walks through
  CREATE TABLE categories (
    id         TEXT PRIMARY KEY,
    builtin    INTEGER NOT NULL DEFAULT 0,
    title      TEXT NOT NULL,
    subtitle   TEXT NOT NULL DEFAULT '',
    icon       TEXT REFERENCES assets(id) ON DELETE SET NULL,
    set_id     TEXT REFERENCES sets(id) ON DELETE SET NULL,
    steps      TEXT NOT NULL DEFAULT '[]',
    status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('live', 'draft', 'hidden')),
    ord        INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );

  -- A RELEASE: what the app receives, frozen. Publishing never edits one;
  -- it makes the next. A channel points at the release its phones get.
  CREATE TABLE releases (
    id         BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    note       TEXT NOT NULL DEFAULT '',
    manifest   TEXT NOT NULL,
    assets     INTEGER NOT NULL,
    bytes      BIGINT NOT NULL,
    created_at BIGINT NOT NULL
  );
  CREATE TABLE channels (
    name       TEXT PRIMARY KEY,
    release_id BIGINT REFERENCES releases(id),
    updated_at BIGINT NOT NULL
  );

  -- the panel's studio document (voices, fixed lines and their takes, image
  -- generations, settings): saved whole with a revision
  CREATE TABLE documents (
    name     TEXT PRIMARY KEY,
    rev      INTEGER NOT NULL,
    saved_at TEXT NOT NULL,
    data     TEXT NOT NULL
  );
  CREATE TABLE document_history (
    id       BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    name     TEXT NOT NULL,
    rev      INTEGER NOT NULL,
    saved_at TEXT NOT NULL,
    data     TEXT NOT NULL
  );
  CREATE INDEX document_history_name ON document_history(name, id);

  -- every paid generation (a voice line, a batch of pictures, lyrics): its
  -- request, each result as soon as it is stored, and how it ended. A panel
  -- that lost the answer asks again with the same id and gets the stored
  -- result -- the provider is never called twice for one job (S08).
  CREATE TABLE jobs (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    status     TEXT NOT NULL CHECK (status IN ('running', 'done', 'partial', 'failed', 'uncertain')),
    request    TEXT NOT NULL,
    assets     TEXT NOT NULL DEFAULT '[]',
    errors     TEXT NOT NULL DEFAULT '[]',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );
  CREATE INDEX jobs_created ON jobs(created_at);

  -- DOWNLOAD PACKS: lands and everything they need, offered to a phone when
  -- the child gets there, downloaded only with a grown-up's yes
  CREATE TABLE packs (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    subtitle   TEXT NOT NULL DEFAULT '',
    note       TEXT NOT NULL DEFAULT '',
    offer_at   TEXT,
    status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('live', 'draft', 'hidden')),
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );

  -- lands added to the roadmap after the app's own world
  CREATE TABLE road_slides (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    image      TEXT REFERENCES assets(id) ON DELETE SET NULL,
    w          DOUBLE PRECISION NOT NULL DEFAULT 0,
    entry      TEXT NOT NULL DEFAULT 'walk' CHECK (entry IN ('walk', 'boat')),
    land       INTEGER,
    trail      TEXT NOT NULL DEFAULT '[]',
    stops      TEXT NOT NULL DEFAULT '[]',
    status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('live', 'draft', 'hidden')),
    ord        INTEGER NOT NULL DEFAULT 0,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    pack       TEXT REFERENCES packs(id) ON DELETE SET NULL
  );

  -- A MASCOT fills a ROLE: the learner (the one the child helps; the app's
  -- own is the bunny Lili) or the friend (the peer; the otter Kuki). Its base
  -- file plays every behaviour the role has; its sets (JSON: id, label, kind,
  -- asset) are more files of the same mascot whose markers 'map' (behaviour
  -- -> [{set, marker}], the first the take, the rest its variants) plays
  -- instead. 'foot' is where its feet are in the 512 box, measured by the
  -- panel; 'report' the panel's last measurement. One live mascot per role.
  CREATE TABLE mascots (
    id         TEXT PRIMARY KEY,
    role       TEXT NOT NULL CHECK (role IN ('learner', 'friend')),
    name       TEXT NOT NULL,
    note       TEXT NOT NULL DEFAULT '',
    base       TEXT REFERENCES assets(id) ON DELETE SET NULL,
    look       TEXT REFERENCES assets(id) ON DELETE SET NULL,
    sets       TEXT NOT NULL DEFAULT '[]',
    map        TEXT NOT NULL DEFAULT '{}',
    walk_set   TEXT,
    stroll_set TEXT,
    foot       TEXT,
    report     TEXT NOT NULL DEFAULT '{}',
    status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('live', 'draft', 'hidden')),
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    voice      TEXT NOT NULL DEFAULT 'keep' CHECK (voice IN ('keep', 'own'))
  );

  -- songs ("Müzik"): the song of a music stop, its lyrics, style, takes and
  -- where each came from (license); one live per stop
  CREATE TABLE songs (
    id         TEXT PRIMARY KEY,
    title      TEXT NOT NULL,
    stop       TEXT NOT NULL,
    brief      TEXT NOT NULL DEFAULT '{}',
    lyrics     TEXT NOT NULL DEFAULT '',
    style      TEXT NOT NULL DEFAULT '{}',
    drafts     TEXT NOT NULL DEFAULT '[]',
    takes      TEXT NOT NULL DEFAULT '[]',
    chosen     TEXT REFERENCES assets(id) ON DELETE SET NULL,
    license    TEXT NOT NULL DEFAULT '{}',
    status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('live', 'draft', 'hidden')),
    note       TEXT NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );
  CREATE INDEX songs_stop ON songs(stop);
  `,
  /* a song made by a request the panel may send again (its answer lost on the
     way): the request's operation id, so the second one returns the first
     song instead of making another (review, 2026-10-19) */
  `
  ALTER TABLE songs ADD COLUMN op TEXT;
  CREATE UNIQUE INDEX songs_op ON songs(op) WHERE op IS NOT NULL;
  `,
  /* 3 (2026-10-19): "one live song per stop" and "one live mascot per role"
     were kept by the routes alone; now the database keeps them too. A
     database where two were live already keeps the one a release picks --
     the first in (created_at, id) order, as `loadSongs`/`loadMascots` read
     them -- and the others go back to draft, their stamp moved on (a panel
     holding the old one is told it changed). The JSON columns stay TEXT (no
     conversion of the tables); a CHECK makes sure each is JSON of its shape.
     A cast that fails raises its own error -- the write is refused either way. */
  `
  UPDATE songs s SET status = 'draft', updated_at = GREATEST(s.updated_at + 1, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT)
   WHERE s.status = 'live' AND EXISTS (
     SELECT 1 FROM songs o WHERE o.status = 'live' AND o.stop = s.stop
        AND (o.created_at < s.created_at OR (o.created_at = s.created_at AND o.id COLLATE "C" < s.id COLLATE "C")));
  CREATE UNIQUE INDEX songs_one_live ON songs(stop) WHERE status = 'live';
  UPDATE mascots m SET status = 'draft', updated_at = GREATEST(m.updated_at + 1, (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT)
   WHERE m.status = 'live' AND EXISTS (
     SELECT 1 FROM mascots o WHERE o.status = 'live' AND o.role = m.role
        AND (o.created_at < m.created_at OR (o.created_at = m.created_at AND o.id COLLATE "C" < m.id COLLATE "C")));
  CREATE UNIQUE INDEX mascots_one_live ON mascots(role) WHERE status = 'live';
  ALTER TABLE songs ADD CONSTRAINT songs_json CHECK (
    json_typeof(brief::json) = 'object' AND json_typeof(style::json) = 'object' AND json_typeof(license::json) = 'object'
    AND json_typeof(drafts::json) = 'array' AND json_typeof(takes::json) = 'array');
  ALTER TABLE mascots ADD CONSTRAINT mascots_json CHECK (
    json_typeof(sets::json) = 'array' AND json_typeof(map::json) = 'object' AND json_typeof(report::json) = 'object'
    AND (foot IS NULL OR json_typeof(foot::json) = 'object'));
  `,
  /* 4 (2026-10-22): ACCOUNTS (Supabase Auth). The accounts themselves --
     e-mail, sign-in, ban -- are Supabase's; these are what this server keeps
     about them. One role in the panel (user decision): an e-mail on the
     admins list may open it. A parent's account is optional in the app and
     keeps the child's progress (decision 11 widened: still no name, no birth
     date -- the progress document as the phone writes it). */
  `
  -- the panel's people, by e-mail; user_id is bound at the first sign-in
  CREATE TABLE admins (
    email         TEXT PRIMARY KEY CHECK (email = lower(email)),
    user_id       TEXT UNIQUE,
    name          TEXT NOT NULL DEFAULT '',
    added_by      TEXT NOT NULL DEFAULT '',
    created_at    BIGINT NOT NULL,
    last_login_at BIGINT
  );
  -- a parent's account as this server has seen it
  CREATE TABLE accounts (
    user_id      TEXT PRIMARY KEY,
    email        TEXT NOT NULL DEFAULT '',
    provider     TEXT NOT NULL DEFAULT '',
    created_at   BIGINT NOT NULL,
    last_seen_at BIGINT NOT NULL
  );
  -- the child's progress (the phone's progress document), one per account;
  -- rev moves on every write, a write based on an older one is refused
  CREATE TABLE progress_backups (
    user_id    TEXT PRIMARY KEY REFERENCES accounts(user_id) ON DELETE CASCADE,
    data       TEXT NOT NULL CHECK (json_typeof(data::json) = 'object'),
    schema     INTEGER NOT NULL,
    rev        INTEGER NOT NULL,
    bytes      INTEGER NOT NULL,
    device     TEXT NOT NULL DEFAULT '',
    updated_at BIGINT NOT NULL
  );
  -- who did what to whom: every change to an account or to the admins list
  CREATE TABLE audit (
    id     BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    at     BIGINT NOT NULL,
    actor  TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT NOT NULL DEFAULT '',
    detail TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX audit_at ON audit(at);
  `,
  /* 5 (2026-10-23): FONTS (the panel's "Yazı tipi"). The app draws its text in
     four roles (title, strong, body, bodyStrong -- `loplop/src/content/
     typography.ts`); a font here fills one role with a TTF/OTF file. The file
     is read when it arrives (`report`: its names, weight, the letters it
     lacks, its shortest safe line) and at most one font per role is in play,
     a rule the database keeps too. */
  `
  ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_kind_check;
  ALTER TABLE assets ADD CONSTRAINT assets_kind_check CHECK (kind IN ('image', 'audio', 'video', 'animation', 'font'));
  CREATE TABLE fonts (
    id         TEXT PRIMARY KEY,
    role       TEXT NOT NULL CHECK (role IN ('title', 'strong', 'body', 'bodyStrong')),
    name       TEXT NOT NULL DEFAULT '',
    note       TEXT NOT NULL DEFAULT '',
    license    TEXT NOT NULL DEFAULT '',
    asset      TEXT REFERENCES assets(id) ON DELETE SET NULL,
    report     TEXT NOT NULL DEFAULT '{}' CHECK (json_typeof(report::json) = 'object'),
    status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('live', 'draft', 'hidden')),
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );
  CREATE UNIQUE INDEX fonts_one_live ON fonts(role) WHERE status = 'live';
  `,
  /* 6 (2026-10-29): COLOUR PALETTES (the panel's "Renk paleti"). The app
     draws its chrome -- backgrounds, cards, buttons -- in a palette of named
     roles (`loplop/src/core/palette.ts`); a row here is one palette, its
     colours a JSON object by role. At most one is in play, a rule the
     database keeps too. No file: a palette is twelve colours. */
  `
  CREATE TABLE palettes (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL DEFAULT '',
    note       TEXT NOT NULL DEFAULT '',
    colors     TEXT NOT NULL DEFAULT '{}' CHECK (json_typeof(colors::json) = 'object'),
    status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('live', 'draft')),
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
  );
  CREATE UNIQUE INDEX palettes_one_live ON palettes(status) WHERE status = 'live';
  `,
  /* 7 (2026-11-17): SONG FILMS (the panel's "Şarkı videoları"): the films of
     the app's "Şarkılar" tab -- a finished MP4 with its song in it, a poster
     for its card, and the category whose map row opens it (NULL: always
     open). Many may be live: the tab is a list. */
  `
  CREATE TABLE song_videos (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    video       TEXT REFERENCES assets(id) ON DELETE SET NULL,
    poster      TEXT REFERENCES assets(id) ON DELETE SET NULL,
    category    TEXT,
    position    INTEGER NOT NULL DEFAULT 0,
    status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('live', 'draft', 'hidden')),
    note        TEXT NOT NULL DEFAULT '',
    rights      TEXT NOT NULL DEFAULT '{}' CHECK (json_typeof(rights::json) = 'object'),
    duration_ms INTEGER,
    fit         TEXT NOT NULL DEFAULT 'cover' CHECK (fit IN ('cover', 'contain')),
    created_at  BIGINT NOT NULL,
    updated_at  BIGINT NOT NULL,
    op          TEXT
  );
  CREATE UNIQUE INDEX song_videos_op ON song_videos(op) WHERE op IS NOT NULL;
  CREATE INDEX song_videos_position ON song_videos(position);
  `,
];

/** the schema this code brings a database to; a backup of a later one is not restored here */
export const SCHEMA_LATEST = MIGRATIONS.length;

/** the tables, parents before children: the order a copy is written in */
export const TABLES = ["meta", "assets", "words", "word_audio", "sets", "set_words", "capabilities", "games", "categories",
  "releases", "channels", "documents", "document_history", "jobs", "packs", "road_slides", "mascots", "songs",
  "admins", "accounts", "progress_backups", "audit", "fonts", "palettes", "song_videos"] as const;
/** the tables whose id the database counts: after a copy, the counter goes past the copied ids */
export const IDENTITY = ["releases", "document_history", "audit"] as const;
/**
 * The migration that made each table, for the ones not made by migration 1:
 * a backup of an earlier schema has no file for them, and that is not a gap.
 * A new table gets a line here (and in TABLES).
 */
export const TABLE_SINCE: Partial<Record<(typeof TABLES)[number], number>> = {
  admins: 4, accounts: 4, progress_backups: 4, audit: 4, fonts: 5, palettes: 6, song_videos: 7,
};

/** the lock a running server holds for as long as it runs (`owner.ts`); the migrations' is WRITER_LOCK + 1 */
export const OWNER_LOCK = WRITER_LOCK + 2;

async function migrate(d: Driver) {
  /* two servers starting at once on one database: one migrates, the other waits */
  const c = await d.connect();
  try {
    await c.query("SELECT pg_advisory_lock($1)", [WRITER_LOCK + 1]);
    await c.query("CREATE TABLE IF NOT EXISTS schema_version (n INTEGER NOT NULL)", []);
    const row = (await c.query("SELECT n FROM schema_version", [])).rows[0] as { n: number } | undefined;
    if (!row) await c.query("INSERT INTO schema_version(n) VALUES (0)", []);
    for (let n = row?.n ?? 0; n < MIGRATIONS.length; n++) {
      await c.query("BEGIN", []);
      try {
        for (const stmt of statements(MIGRATIONS[n]!)) await c.query(stmt, []);
        await c.query("UPDATE schema_version SET n = $1", [n + 1]);
        await c.query("COMMIT", []);
      } catch (e) {
        await c.query("ROLLBACK", []).catch(() => {});
        throw new Error(`veritabanı göçü ${n + 1} başarısız: ${(e as Error).message}`);
      }
    }
  } finally {
    await c.query("SELECT pg_advisory_unlock($1)", [WRITER_LOCK + 1]).catch(() => {});
    c.release();
  }
}

/** a migration's statements, one by one; `--` comment lines dropped (no `;` inside a statement's text) */
export function statements(sql: string): string[] {
  return sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n")
    .split(";").map((s) => s.trim()).filter(Boolean);
}
