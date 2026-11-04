/**
 * A CONSISTENT BACKUP (decision 4, 2026-10-16; Postgres 2026-10-18): the
 * database and every file it names, as one set.
 *
 *   DATABASE_URL=… DATA_DIR=… BACKUP_PASSPHRASE=… npm run backup -- --out /yedek/klasoru
 *
 * 1. the collector is held (`.gc-hold`), so no file the snapshot names is
 *    deleted while it is being copied;
 * 2. the database is read in ONE read-only snapshot transaction (Postgres'
 *    repeatable read: every table as it was at the same instant, while the
 *    server keeps working) and written as `db/<table>.jsonl` -- rows, not a
 *    server's files, so it restores into any Postgres of any version;
 * 3. every blob the SNAPSHOT names (assets, and every release ever published,
 *    for rollbacks) is copied and its hash checked;
 * 4. the hold is released;
 * 5. with BACKUP_PASSPHRASE the set is packed and encrypted (AES-256, PBKDF2)
 *    and the plain copy removed. The API keys (`secrets.json`) go in only an
 *    encrypted set.
 *
 * A SET IS WHOLE OR IT IS NOT A BACKUP (2026-10-19). `YEDEK.json` names every
 * table file with its row count and SHA-256 (`files`), so a restore can tell a
 * whole set from a damaged one before it writes anything. A file the
 * snapshot names and the disk does not have -- or any other failure -- ends
 * the run with an error (exit 1): the folder is renamed `…-EKSIK`, its
 * `YEDEK.json` says `complete: false` and why, it is never encrypted, and
 * `npm run restore` refuses it. Earlier, such a set was reported as made.
 *
 * The embedded database (no DATABASE_URL, development) is one process's:
 * stop the server before backing it up.
 *
 * A hosted Postgres may keep backups of its own (Supabase: daily, on its paid
 * plans); they hold the rows but not the files, and this set holds both.
 * Off-site storage is the operator's step (rclone, a second disk, …): a
 * backup on the server's own disk is not a backup.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");

/** the files a set's rows name: every asset, and every release's (for rollbacks) */
export function shasOf(rows: { assets: { sha256: string; ext: string }[]; releases: { manifest: string }[] }): { sha: string; ext: string }[] {
  const out = new Map<string, string>();
  for (const r of rows.assets) out.set(r.sha256, r.ext);
  for (const r of rows.releases)
    for (const a of Object.values((JSON.parse(r.manifest) as { assets?: Record<string, { sha256: string; ext: string }> }).assets ?? {}))
      out.set(a.sha256, a.ext);
  return [...out].map(([s, ext]) => ({ sha: s, ext }));
}

/** read a set's `assets` and `releases` tables back (restore, the drill) */
export function setRows(dir: string) {
  const read = (t: string) => {
    const f = path.join(dir, "db", `${t}.jsonl`);
    return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  return { assets: read("assets") as { sha256: string; ext: string }[], releases: read("releases") as { manifest: string }[] };
}

export async function backup(out: string, pass = process.env.BACKUP_PASSPHRASE ?? ""): Promise<string> {
  /* the server's own settings: DATA_DIR, DATABASE_URL */
  const { config } = await import("../src/config.js");
  const sql = await import("../src/storage/sql.js");
  const { dumpFile, toJsonl } = await import("../src/storage/copy.js");
  const DATA = config.dataDir;
  const HOLD_MS = 60 * 60 * 1000;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(path.resolve(out), `loplop-${stamp}`);
  const hold = path.join(DATA, ".gc-hold");
  mkdirSync(path.join(dir, "blobs"), { recursive: true });
  mkdirSync(path.join(dir, "db"), { recursive: true });
  writeFileSync(hold, String(Date.now() + HOLD_MS));
  const counts: Record<string, number> = {};
  const files: Record<string, { rows: number; sha256: string }> = {};
  let named: { schema: number; shas: { sha: string; ext: string }[] } | null = null;
  try {
    await sql.openDb();
    named = await sql.snapshot(async () => {
      for (const t of sql.TABLES) {
        const rows = await sql.all(`SELECT * FROM ${t}`);
        const text = toJsonl(rows);
        writeFileSync(dumpFile(dir, t), text);
        counts[t] = rows.length;
        files[t] = { rows: rows.length, sha256: createHash("sha256").update(text).digest("hex") };
      }
      return { schema: await sql.schemaVersion(),
               shas: shasOf({ assets: await sql.all("SELECT sha256, ext FROM assets"), releases: await sql.all("SELECT manifest FROM releases") }) };
    });
    await sql.closeDb();
    let bytes = 0;
    const missing: string[] = [];
    for (const { sha: s, ext } of named.shas) {
      const from = path.join(DATA, "blobs", `${s}.${ext}`);
      if (!existsSync(from)) { missing.push(`${s}.${ext}`); continue; }
      const to = path.join(dir, "blobs", `${s}.${ext}`);
      copyFileSync(from, to);
      if (sha(to) !== s) throw new Error(`Kopyalanan dosya bozuk: ${s}.${ext}`);
      bytes += statSync(to).size;
    }
    if (missing.length)
      throw new Error(`veritabanının andığı ${missing.length} dosya diskte yok: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? " …" : ""}`);
    const secrets = path.join(DATA, "secrets.json");
    if (pass && existsSync(secrets)) copyFileSync(secrets, path.join(dir, "secrets.json"));
    writeFileSync(path.join(dir, "YEDEK.json"), JSON.stringify({
      createdAt: new Date().toISOString(), format: "postgres-rows-1", complete: true, schema: named.schema, database: sql.dbInfo(), dataDir: DATA,
      tables: [...sql.TABLES], rows: counts, files, blobs: named.shas.length, bytes, missing: [],
      secrets: pass && existsSync(secrets) ? "var" : "yok (şifresiz yedekte anahtarlar bulunmaz)",
    }, null, 2));
    console.log(`yedek: ${Object.values(counts).reduce((a, b) => a + b, 0)} satır, ${named.shas.length} dosya, ${(bytes / 1024 / 1024).toFixed(1)} MB → ${dir}`);
  } catch (e) {
    /* not a backup: say so on the folder itself, so no one takes it for one */
    await sql.closeDb().catch(() => {});
    const why = (e as Error).message;
    const bad = `${dir}-EKSIK`;
    try {
      writeFileSync(path.join(dir, "YEDEK.json"), JSON.stringify({
        createdAt: new Date().toISOString(), format: "postgres-rows-1", complete: false, error: why,
        schema: named?.schema ?? null, rows: counts, files }, null, 2));
      renameSync(dir, bad);
    } catch { /* the folder itself is the problem: the error below says enough */ }
    throw new Error(`${why} — yedek EKSİK, kullanılamaz (${existsSync(bad) ? bad : dir})`);
  } finally {
    try { unlinkSync(hold); } catch { /* gone */ }
  }
  if (!pass) {
    console.warn("UYARI: BACKUP_PASSPHRASE yok — yedek ŞİFRESİZ ve API anahtarlarını içermiyor. Sunucudan ayrı bir yere şifreli taşıyın.");
    return dir;
  }
  const file = `${dir}.tar.gz.enc`;
  const tar = execFileSync("tar", ["czf", "-", "-C", path.dirname(dir), path.basename(dir)], { maxBuffer: 4 * 1024 ** 3 });
  execFileSync("openssl", ["enc", "-aes-256-cbc", "-pbkdf2", "-salt", "-pass", "env:BACKUP_PASSPHRASE", "-out", file],
               { input: tar, env: { ...process.env, BACKUP_PASSPHRASE: pass } });
  rmSync(dir, { recursive: true, force: true });
  console.log(`şifrelendi: ${file}`);
  return file;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1])))
  backup(arg("--out") ?? "./yedek").catch((e) => { console.error(`yedek BAŞARISIZ: ${(e as Error).message}`); process.exit(1); });
