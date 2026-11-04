/**
 * ONE SERVER PER DATABASE (2026-10-19). `lock.ts` keeps a second process off
 * a data FOLDER; a real Postgres is reached by its address, and a second
 * server with a folder of its own -- another machine, a deploy that forgot
 * the old one, a hand-started copy with another DATA_DIR -- would share the
 * rows while the files they name live in the first one's folder. And at its
 * start it would mark the first one's paid jobs, still out, as interrupted
 * ("uncertain"), which they are not.
 *
 * Two guards, both before the server writes anything:
 *
 *   THE LOCK   a running server holds a session advisory lock (OWNER_LOCK) on
 *              a connection of its own (not the pool's). A second server waits
 *              DATABASE_LOCK_WAIT_MS for it -- a deploy's old process may
 *              still be stopping -- and then refuses to start, whatever its
 *              folder. Taken BEFORE the migrations, so a second server never
 *              changes the schema under a running one.
 *   THE BOND   the database names the folder it belongs to (`meta.data-folder`
 *              = the id in `DATA_DIR/folder-id`). A server whose folder is
 *              another is refused even when no one else is running: its
 *              `blobs/` are not the files the rows name. A database that is
 *              not bound yet (new, copied, restored -- copies never carry the
 *              bond) is bound by the first server that starts on it.
 *              DATABASE_REBIND=1 moves the bond, by a person's decision (the
 *              folder was rebuilt from a backup and has the files).
 *
 * The lock lost (the connection dropped): it is taken again on a new
 * connection; if another server holds it by then, this one stops at once.
 *
 * A pooler in transaction mode (Supabase's port 6543) cannot hold a session
 * lock: DATABASE_URL is the direct/session address (the setup doc says so).
 * The embedded database lives inside the folder: the folder's lock is all it
 * needs, and none of this runs for it.
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { config } from "../config.js";
import { meta, OWNER_LOCK, tlsOf } from "./sql.js";

export class DatabaseInUse extends Error {}

/** the meta keys that belong to one server, never to a copy of its rows (`copy.ts` leaves them out) */
export const BOND_KEY = "data-folder";
export const OWNER_KEY = "server-owner";
export const LOCAL_KEYS = new Set([BOND_KEY, OWNER_KEY]);

interface Owner { run: string; pid: number; host: string; dataDir: string; folder: string; startedAt: string }

/** this folder's id, made the first time (it travels with the folder, not with a backup's rows) */
export function folderId(dir = config.dataDir): string {
  const file = path.join(dir, "folder-id");
  try { const id = readFileSync(file, "utf8").trim(); if (id) return id; } catch { /* not yet */ }
  try { writeFileSync(file, randomUUID() + "\n", { flag: "wx" }); } catch { /* made meanwhile: read it */ }
  return readFileSync(file, "utf8").trim();
}

type PgClient = import("pg").Client;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function metaRaw(c: PgClient, key: string): Promise<string | undefined> {
  const has = (await c.query("SELECT to_regclass('meta') IS NOT NULL AS has")).rows[0] as { has: boolean };
  if (!has.has) return undefined;
  return ((await c.query("SELECT value FROM meta WHERE key = $1", [key])).rows[0] as { value: string } | undefined)?.value;
}

const describe = (o: Owner | null) =>
  o ? `${o.host}, pid ${o.pid}, veri klasörü ${o.dataDir}, ${o.startedAt}` : "bilgisi yok";
const ownerOf = async (c: PgClient): Promise<Owner | null> => {
  try { const v = await metaRaw(c, OWNER_KEY); return v ? JSON.parse(v) as Owner : null; } catch { return null; }
};

export interface DatabaseHold {
  /** after the migrations: bind an unbound database to this folder, and say who runs it */
  claim(): Promise<void>;
  release(): Promise<void>;
}

/**
 * Take the database for this server, or throw `DatabaseInUse`. Null for the
 * embedded database. `onLost` is what happens when another server has the
 * lock after a lost connection (the server: stop).
 */
export async function holdDatabase(opts: { waitMs?: number; log?: (m: string) => void; onLost?: (why: string) => void } = {}): Promise<DatabaseHold | null> {
  if (!config.databaseUrl) return null;
  const log = opts.log ?? ((m: string) => console.log(m));
  const onLost = opts.onLost ?? ((why: string) => { console.error(why); process.exit(1); });
  const pg = (await import("pg")).default;
  const me: Owner = { run: randomUUID(), pid: process.pid, host: hostname(), dataDir: config.dataDir, folder: folderId(), startedAt: new Date().toISOString() };
  let releasing = false;

  const connect = async (): Promise<PgClient> => {
    const c = new pg.Client({ ...tlsOf(config.databaseUrl), keepAlive: true, application_name: "loplop-server-owner" });
    await c.connect();
    return c;
  };
  const take = async (c: PgClient) => ((await c.query("SELECT pg_try_advisory_lock($1) AS ok", [OWNER_LOCK])).rows[0] as { ok: boolean }).ok;

  let c = await connect();
  const until = Date.now() + (opts.waitMs ?? config.dbLockWaitMs);
  try {
    while (!(await take(c))) {
      if (Date.now() >= until)
        throw new DatabaseInUse(`Bu veritabanını başka bir sunucu kullanıyor (${describe(await ownerOf(c))}). `
          + "Aynı veritabanına iki sunucu bağlanamaz: önce onu durdurun.");
      await sleep(500);
    }
    const bound = await metaRaw(c, BOND_KEY);
    if (bound && bound !== me.folder && !config.dbRebind)
      throw new DatabaseInUse(`Bu veritabanı başka bir veri klasörüne bağlı (son çalışan: ${describe(await ownerOf(c))}); `
        + `bu sunucunun klasörü ${config.dataDir}. Satırların andığı dosyalar o klasörde. Doğru DATA_DIR ile başlatın; `
        + "klasör yedekten yeniden kurulduysa ve dosyalar tamsa DATABASE_REBIND=1 ile bir kez başlatın.");
  } catch (e) {
    await c.end().catch(() => {});
    throw e;
  }

  /* the lock lives as long as this connection: lost, taken again -- or stop */
  const watch = (cl: PgClient) => {
    let gone = false;
    const lost = async (why: string) => {
      /* "error" and "end" both come for one drop: one recovery, not two
         (a second would find the first's new lock and stop the server) */
      if (gone || releasing || cl !== c) return;
      gone = true;
      log(`veritabanı kilidinin bağlantısı koptu (${why}); yeniden alınıyor`);
      for (let i = 0; !releasing; i++) {
        await sleep(Math.min(5000, 500 * (i + 1)));
        let n: PgClient | null = null;
        try {
          n = await connect();
          if (await take(n)) { c = n; watch(n); log("veritabanı kilidi yeniden alındı"); return; }
          const who = describe(await ownerOf(n));
          await n.end().catch(() => {});
          onLost(`Veritabanı kilidi koptu ve şimdi başka bir sunucuda (${who}): bu sunucu duruyor.`);
          return;
        } catch { await n?.end().catch(() => {}); /* the database is away: try again */ }
      }
    };
    cl.on("error", (e) => void lost(e.message));
    cl.on("end", () => void lost("bağlantı kapandı"));
  };
  watch(c);

  return {
    claim: async () => {
      const bound = await meta.get(BOND_KEY);
      if (!bound || bound !== me.folder) {
        await meta.set(BOND_KEY, me.folder);
        log(bound ? `veritabanı bu veri klasörüne yeniden bağlandı (DATABASE_REBIND): ${config.dataDir}`
                  : `veritabanı bu veri klasörüne bağlandı: ${config.dataDir}`);
      }
      await meta.set(OWNER_KEY, JSON.stringify(me));
    },
    release: async () => {
      releasing = true;
      await c.query("SELECT pg_advisory_unlock($1)", [OWNER_LOCK]).catch(() => {});
      await c.end().catch(() => {});
    },
  };
}
