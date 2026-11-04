/**
 * COPYING THE ROWS from another database into the server's own (2026-10-18).
 *
 *   an old SQLite file   `DATA_DIR/loplop.db`, what the server kept until it
 *                        moved to Postgres -- taken in by itself the first
 *                        time the server starts on an EMPTY embedded database
 *   an embedded database `DATA_DIR/pgdata` of another folder, or this one when
 *                        the server moves to a real Postgres (`npm run db:copy`)
 *   a Postgres server    `postgres://…` (moving from one to another)
 *   a backup             the `db/<table>.jsonl` files of a backup set
 *                        (`tools/backup.ts`, `tools/restore.ts`)
 *
 * Every table, parents first, the same ids; the counters of the tables that
 * number their own rows go past the copied ids. One transaction: all of it or
 * none of it. The target must be empty -- a copy never mixes with live data.
 * The FILES are not rows: `blobs/` is copied as a folder (see the README).
 *
 * CONSISTENT (2026-10-19). A database source is read in ONE read-only
 * repeatable-read transaction: every table as it was at the same instant,
 * though its server keeps writing (a release and the assets it names, a word
 * and its set). Read table by table outside one, a copy could hold a child
 * whose parent came too late, or a release without its files. The SQLite
 * file is read in one read transaction for the same reason.
 *
 * EMPTY, UNDER THE LOCK. The target is checked empty first (a quick refusal,
 * before the source is opened), and again INSIDE the copy's transaction --
 * after the writer lock and with every table locked against writes -- since
 * a server may have started on it meanwhile.
 *
 * The server's own meta keys (`owner.ts` → LOCAL_KEYS: which folder the
 * database is bound to, who runs it) are not copied: a copy is bound by the
 * first server that starts on it.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { all, one, run, tx, openOther, IDENTITY, TABLES } from "./sql.js";
import { LOCAL_KEYS } from "./owner.js";

type Row = Record<string, unknown>;
export type Source = { sqlite: string } | { url: string } | { dir: string } | { dump: string };

export const describe = (s: Source) =>
  "sqlite" in s ? `SQLite ${s.sqlite}` : "dir" in s ? `gömülü Postgres ${s.dir}` : "dump" in s ? `yedek ${s.dump}` : `Postgres ${safeUrl(s.url)}`;

/** a table of a backup set: one JSON row per line */
export const dumpFile = (dir: string, table: string) => path.join(dir, "db", `${table}.jsonl`);
export const toJsonl = (rows: Row[]) => rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
const safeUrl = (u: string) => { try { const x = new URL(u); x.password = x.password ? "***" : ""; return x.toString(); } catch { return "(adres)"; } };

/** is there anything in the server's database yet (any row in any content table) */
export async function isEmpty(): Promise<boolean> {
  for (const t of TABLES) {
    if (t === "meta") continue;
    if (await one(`SELECT 1 AS x FROM ${t} LIMIT 1`)) return false;
  }
  return true;
}

/** a table's rows from the source, or null if it has no such table */
async function reader(src: Source): Promise<{ rows(t: string): Promise<Row[] | null>; close(): Promise<void> }> {
  if ("dump" in src) return {
    rows: async (t) => {
      const f = dumpFile(src.dump, t);
      if (!existsSync(f)) return null;
      return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);
    },
    close: async () => {},
  };
  if ("sqlite" in src) {
    const d = new DatabaseSync(src.sqlite, { readOnly: true });
    /* one read transaction: every table from the same moment */
    d.exec("BEGIN");
    return {
      rows: async (t) => {
        if (!d.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(t)) return null;
        return d.prepare(`SELECT * FROM ${t}`).all() as Row[];
      },
      close: async () => { try { d.exec("COMMIT"); } finally { d.close(); } },
    };
  }
  const d = await openOther("url" in src ? { url: src.url } : { dir: src.dir });
  /* one snapshot of the source, on one connection, for the whole copy */
  let c: Awaited<ReturnType<typeof d.connect>>;
  try {
    c = await d.connect();
    await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", []);
  } catch (e) { await d.close().catch(() => {}); throw e; }
  return {
    rows: async (t) => {
      const has = await c.query("SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1", [t]);
      if (!has.rows.length) return null;
      return (await c.query(`SELECT * FROM ${t}`, [])).rows;
    },
    close: async () => {
      try { await c.query("COMMIT", []); } catch { /* read only: nothing to lose */ }
      c.release();
      await d.close();
    },
  };
}

const NOT_EMPTY = "Hedef veritabanı boş değil: kopya canlı veriyle karışmaz.";

/**
 * Copy every table of `src` into the server's (empty) database; returns rows
 * per table. `onRead` is told after each table is read from the source (a
 * test writes to the source there, to see the snapshot hold).
 */
export async function copyFrom(src: Source, opts: { onRead?: (table: string) => Promise<void> } = {}): Promise<Record<string, number>> {
  if (!(await isEmpty())) throw new Error(NOT_EMPTY);
  const r = await reader(src);
  const counts: Record<string, number> = {};
  try {
    await tx(async () => {
      /* again, under the writer lock, with no one able to write any table
         until this commits (a write outside a `tx` waits as well) */
      await run(`LOCK TABLE ${TABLES.join(", ")} IN EXCLUSIVE MODE`);
      if (!(await isEmpty())) throw new Error(NOT_EMPTY);
      for (const t of TABLES) {
        let rows = await r.rows(t);
        await opts.onRead?.(t);
        if (t === "meta" && rows) rows = rows.filter((x) => !LOCAL_KEYS.has(String(x.key)));
        if (!rows?.length) { counts[t] = 0; continue; }
        const mine = new Set((await all<{ column_name: string }>(
          "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?", t))
          .map((c) => c.column_name));
        const cols = Object.keys(rows[0]!).filter((c) => mine.has(c));
        /* `meta` carries the server's id (`instance-id`) with it: a copy is the
           same server moved (a panel's unsaved work is still offered back to it) */
        await insert(t, cols, rows);
        counts[t] = rows.length;
      }
      for (const t of IDENTITY)
        await run(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), COALESCE(MAX(id), 1), MAX(id) IS NOT NULL) FROM ${t}`);
    });
  } finally { await r.close(); }
  return counts;
}

/** many rows at once, but never more values than Postgres takes in one query, nor a huge one */
async function insert(t: string, cols: string[], rows: Row[]) {
  const list = cols.map((c) => `"${c}"`).join(", ");
  let batch: Row[] = [], size = 0;
  const flush = async () => {
    if (!batch.length) return;
    const marks = batch.map(() => `(${cols.map(() => "?").join(", ")})`).join(", ");
    await run(`INSERT INTO ${t}(${list}) VALUES ${marks}`, ...batch.flatMap((x) => cols.map((c) => value(x[c]))));
    batch = []; size = 0;
  };
  for (const x of rows) {
    batch.push(x);
    size += cols.reduce((n, c) => n + (typeof x[c] === "string" ? (x[c] as string).length : 8), 0);
    if (batch.length * cols.length > 30_000 || size > 8 * 1024 * 1024) await flush();
  }
  await flush();
}

/* SQLite hands back a BIGINT as a bigint only when asked; a Postgres BIGINT is a number here */
const value = (v: unknown) => (typeof v === "bigint" ? Number(v) : v);
