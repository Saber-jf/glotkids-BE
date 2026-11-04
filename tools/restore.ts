/**
 * RESTORE A BACKUP into an EMPTY data folder and an EMPTY database (decision 4).
 *
 *   DATABASE_URL=… BACKUP_PASSPHRASE=… npm run restore -- --from yedek.tar.gz.enc --to /yeni/data
 *   npm run restore -- --from yedek-klasoru --to /yeni/data
 *
 * The rows go into DATABASE_URL -- or, without one, into an embedded
 * database in the new folder (`<to>/pgdata`, development and the drill).
 * A folder or a database that is not empty is refused: a restore never mixes
 * with live data.
 *
 * NOTHING IS WRITTEN UNTIL THE WHOLE SET IS CHECKED (2026-10-19):
 *   - `YEDEK.json` is there, of a format this code reads, and says the set is
 *     complete (a set made with missing files is not a backup);
 *   - its schema is one this code knows (a later server's set is refused);
 *   - every table the schema has is there as a file -- none skipped as "empty"
 *     -- with the number of rows the set names, each line a row, and (sets
 *     made from 2026-10-19 on) the SHA-256 it names;
 *   - every file the rows name is there and its bytes are its name.
 *
 * THEN, IN AN ORDER THAT CAN BE FINISHED: a mark goes into the folder
 * (`.restore-incomplete.json`, naming the set), the database is asked (empty,
 * or this set's rows from the run that left the mark), the FILES are copied (each
 * through a temporary name; one already there with the right bytes is kept),
 * and the ROWS last, in one transaction that also writes which set they came
 * from (`meta.restored-from`). Stopped anywhere -- a full disk, a lost
 * connection, a killed process -- the same command run again picks up where it
 * stopped: the mark lets it into its own half-filled folder, the files it has
 * are kept, and rows already committed from THIS set are not copied twice. A
 * server never starts on a folder with the mark (`server.ts`). Another set
 * into the same folder is refused until the folder is emptied.
 *
 * A set made before the move to Postgres (it holds `loplop.db`, SQLite) is
 * restored the same way: its rows are copied out of that file.
 *
 * Runs in a process of its own: the folder is read from the environment when
 * the server's modules load, so `restore()` sets DATA_DIR before loading them
 * and refuses if they were loaded for another folder.
 */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { setRows, shasOf } from "./backup.js";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const shaFile = (f: string) => sha(readFileSync(f));

/** the mark of a restore not finished (`src/storage/lock.ts` → RESTORE_MARK, read by the server) */
const MARK = ".restore-incomplete.json";
/** the set the database's rows came from, written with them */
const RESTORED_KEY = "restored-from";

/** unpack (and decrypt) a backup; returns the set's folder */
export function unpack(from: string): string {
  if (!from.endsWith(".enc")) return path.resolve(from);
  if (!process.env.BACKUP_PASSPHRASE) throw new Error("Şifreli yedek için BACKUP_PASSPHRASE gerekli.");
  const tmp = mkdtempSync(path.join(tmpdir(), "loplop-geri-"));
  const tar = execFileSync("openssl", ["enc", "-d", "-aes-256-cbc", "-pbkdf2", "-pass", "env:BACKUP_PASSPHRASE", "-in", path.resolve(from)],
                          { maxBuffer: 4 * 1024 ** 3 });
  execFileSync("tar", ["xzf", "-", "-C", tmp], { input: tar });
  const inner = readdirSync(tmp).find((d) => d.startsWith("loplop-"));
  if (!inner) throw new Error("Yedeğin içinde loplop-* klasörü yok.");
  return path.join(tmp, inner);
}

/** the files an old (SQLite) set's rows name */
function sqliteShas(file: string) {
  const d = new DatabaseSync(file, { readOnly: true });
  const ok = (d.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
  if (ok !== "ok") { d.close(); throw new Error(`Veritabanı bütünlük denetimi: ${ok}`); }
  const rows = { assets: d.prepare("SELECT sha256, ext FROM assets").all() as { sha256: string; ext: string }[],
                 releases: d.prepare("SELECT manifest FROM releases").all() as { manifest: string }[] };
  d.close();
  return shasOf(rows);
}

interface SetInfo {
  format?: string; complete?: boolean; error?: string; schema?: number | null; missing?: string[];
  rows?: Record<string, number>; files?: Record<string, { rows: number; sha256: string }>;
}
export interface Plan {
  kind: "rows" | "sqlite";
  /** which set: the hash of its YEDEK.json (or of its loplop.db) -- what a resumed restore must match */
  id: string;
  schema: number | null;
  need: { sha: string; ext: string }[];
  rows: Record<string, number>;
  notes: string[];
}

/**
 * Check a whole set before anything is written; throws on the first thing
 * wrong. `known` is this code's schema: its version, its tables, when each came.
 */
export function verifySet(set: string, known: { latest: number; tables: readonly string[]; since: Partial<Record<string, number>> }): Plan {
  const notes: string[] = [];
  const infoFile = path.join(set, "YEDEK.json");
  const info: SetInfo | null = existsSync(infoFile) ? JSON.parse(readFileSync(infoFile, "utf8")) as SetInfo : null;
  if (info?.complete === false) throw new Error(`Yedek eksik, kullanılamaz: ${info.error ?? "yedekleme yarıda kaldı"}`);
  if (info?.missing?.length) throw new Error(`Yedek eksik: veritabanının andığı ${info.missing.length} dosya yedeğe girmemiş (${info.missing.slice(0, 3).join(", ")}).`);

  const old = path.join(set, "loplop.db");
  const rowsDir = path.join(set, "db");
  let kind: Plan["kind"], id: string, need: Plan["need"];
  const rows: Record<string, number> = {};
  if (existsSync(rowsDir)) {
    kind = "rows";
    if (!info) throw new Error("Yedekte YEDEK.json yok: setin bütün olduğu doğrulanamaz.");
    if (info.format !== "postgres-rows-1") throw new Error(`Tanınmayan yedek biçimi: ${info.format ?? "(yok)"}`);
    const schema = info.schema;
    if (typeof schema !== "number" || !Number.isInteger(schema) || schema < 1) throw new Error("Yedeğin şema sürümü okunamadı.");
    if (schema > known.latest) throw new Error(`Yedek daha yeni bir sunucunun (şema ${schema}; bu kod ${known.latest}'e kadar biliyor): önce sunucuyu güncelleyin.`);
    if (!info.rows) throw new Error("YEDEK.json tabloların satır sayılarını içermiyor.");
    const present = readdirSync(rowsDir).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6));
    const strange = present.filter((t) => !known.tables.includes(t));
    if (strange.length) throw new Error(`Yedekte bu kodun tanımadığı tablolar var: ${strange.join(", ")}`);
    if (!info.files) notes.push("eski yedek: tablo dosyalarının özeti yok, satır sayıları denetlendi");
    for (const t of known.tables) {
      const f = path.join(rowsDir, `${t}.jsonl`);
      const since = known.since[t] ?? 1;
      if (!existsSync(f)) {
        if (since > schema) continue;           /* the table came after this set's schema */
        throw new Error(`Yedekte "${t}" tablosunun dosyası yok (şema ${schema} onu içerir).`);
      }
      const want = info.rows[t];
      if (typeof want !== "number") throw new Error(`YEDEK.json "${t}" tablosunun satır sayısını içermiyor.`);
      const bytes = readFileSync(f);
      const named = info.files?.[t];
      if (info.files && !named) throw new Error(`YEDEK.json "${t}" tablosunun özetini içermiyor.`);
      if (named && sha(bytes) !== named.sha256) throw new Error(`"${t}" tablosunun dosyası bozuk (özeti tutmuyor).`);
      const lines = bytes.toString("utf8").split("\n").filter(Boolean);
      if (lines.length !== want) throw new Error(`"${t}" tablosu: YEDEK.json ${want} satır diyor, dosyada ${lines.length}.`);
      lines.forEach((l, i) => {
        let v: unknown;
        try { v = JSON.parse(l); } catch { throw new Error(`"${t}" tablosunun ${i + 1}. satırı okunamıyor.`); }
        if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`"${t}" tablosunun ${i + 1}. satırı bir satır değil.`);
      });
      rows[t] = want;
    }
    id = sha(readFileSync(infoFile));
    need = shasOf(setRows(set));
  } else if (existsSync(old)) {
    kind = "sqlite";
    need = sqliteShas(old);
    id = shaFile(old);
    notes.push("SQLite dönemi yedeği: bütünlük denetimi (integrity_check) geçti");
  } else throw new Error("Yedekte veritabanı yok.");

  for (const { sha: s, ext } of need) {
    const f = path.join(set, "blobs", `${s}.${ext}`);
    if (!existsSync(f)) throw new Error(`Yedekte eksik dosya: ${s}.${ext}`);
    if (shaFile(f) !== s) throw new Error(`Bozuk dosya: ${s}.${ext}`);
  }
  return { kind, id, schema: info?.schema ?? null, need, rows, notes };
}

/** a test stops a restore on purpose, to see it finished by a second run (NODE_ENV=test only) */
const failAt = (where: "files" | "db") => {
  if (process.env.NODE_ENV === "test" && process.env.LOPLOP_TEST_RESTORE_FAIL === where)
    throw new Error(`(test) geri yükleme bilerek durduruldu: ${where}`);
};

export async function restore(from: string, to: string): Promise<{ blobs: number; rows: number; resumed: boolean; notes: string[] }> {
  to = path.resolve(to);
  /* before any of the server's modules load: they read the folder once */
  process.env.DATA_DIR = to;
  const set = unpack(from);
  try {
    const sql = await import("../src/storage/sql.js");
    const { config } = await import("../src/config.js");
    if (config.dataDir !== to) throw new Error(`Sunucu modülleri başka bir klasörle yüklenmiş (${config.dataDir}); geri yükleme kendi sürecinde çalışır.`);
    const plan = verifySet(set, { latest: sql.SCHEMA_LATEST, tables: sql.TABLES, since: sql.TABLE_SINCE });

    /* the folder: empty -- or the half-filled one of THIS set */
    const mark = path.join(to, MARK);
    const had = existsSync(mark) ? JSON.parse(readFileSync(mark, "utf8")) as { set: string; from: string } : null;
    if (had && had.set !== plan.id)
      throw new Error(`Bu klasörde başka bir yedeğin yarım geri yüklemesi var (${had.from}). Onu tamamlayın ya da klasörü boşaltın.`);
    if (!had && existsSync(to) && readdirSync(to).length) throw new Error(`Hedef klasör boş değil: ${to}`);
    const made = !existsSync(to);
    mkdirSync(path.join(to, "blobs"), { recursive: true });
    if (!had) writeFileSync(mark, JSON.stringify({ set: plan.id, from: path.resolve(from), startedAt: new Date().toISOString() }, null, 2));

    const { copyFrom, isEmpty } = await import("../src/storage/copy.js");
    let rows = 0, resumed = Boolean(had);
    try {
      await sql.openDb();
      /* the database: empty -- or holding THIS set's rows from the run that
         left the mark here. Asked before a single file is copied. */
      const done = had && (await sql.meta.get(RESTORED_KEY)) === plan.id;
      if (!done && !(await isEmpty())) {
        /* the folder as it was: nothing of this run left in it */
        if (!had) {
          unlinkSync(mark);
          if (made) rmSync(to, { recursive: true, force: true });
          else if (!readdirSync(path.join(to, "blobs")).length) rmSync(path.join(to, "blobs"), { recursive: true });
        }
        throw new Error("Hedef veritabanı boş değil: geri yükleme canlı veriyle karışmaz.");
      }

      /* 1. the files: content-addressed, so copying one twice is harmless */
      let n = 0;
      for (const { sha: s, ext } of plan.need) {
        const dest = path.join(to, "blobs", `${s}.${ext}`);
        if (existsSync(dest) && shaFile(dest) === s) continue;
        const tmp = `${dest}.${process.pid}.tmp`;
        copyFileSync(path.join(set, "blobs", `${s}.${ext}`), tmp);
        renameSync(tmp, dest);
        if (++n === 1) failAt("files");
      }

      /* 2. the rows, in one transaction with the name of the set they came from */
      if (done) rows = Object.values(plan.rows).reduce((a, b) => a + b, 0);
      else await sql.tx(async () => {
        const got = await copyFrom(plan.kind === "rows" ? { dump: set } : { sqlite: path.join(set, "loplop.db") });
        for (const [t, want] of Object.entries(plan.rows))
          if (t !== "meta" && got[t] !== want) throw new Error(`"${t}" tablosuna ${got[t]} satır yazıldı, yedekte ${want}.`);
        await sql.meta.set(RESTORED_KEY, plan.id);
        rows = Object.values(got).reduce((a, b) => a + b, 0);
      });
      resumed ||= done;
    } finally { await sql.closeDb(); }
    failAt("db");

    /* 3. the keys, and the folder is whole */
    if (existsSync(path.join(set, "secrets.json"))) copyFileSync(path.join(set, "secrets.json"), path.join(to, "secrets.json"));
    unlinkSync(mark);
    return { blobs: plan.need.length, rows, resumed, notes: plan.notes };
  } finally {
    if (from.endsWith(".enc")) rmSync(path.dirname(set), { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const from = arg("--from"), to = arg("--to");
  (async () => {
    if (!from || !to) throw new Error("kullanım: npm run restore -- --from <yedek> --to <boş klasör>");
    const r = await restore(from, path.resolve(to));
    for (const n of r.notes) console.log(`not: ${n}`);
    console.log(`geri yüklendi${r.resumed ? " (yarım kalan geri yükleme tamamlandı)" : ""}: ${r.rows} satır + ${r.blobs} dosya → ${path.resolve(to)}`
      + (process.env.DATABASE_URL ? " (veritabanı: DATABASE_URL)" : ` (veritabanı: ${path.resolve(to)}/pgdata)`));
  })().catch((e) => {
    console.error(`geri yükleme BAŞARISIZ: ${(e as Error).message}`);
    if (to && existsSync(path.join(path.resolve(to), MARK)))
      console.error("Klasör yarım: aynı komutu yeniden çalıştırınca kaldığı yerden devam eder. O zamana kadar sunucu bu klasörle açılmaz.");
    process.exit(1);
  });
}
