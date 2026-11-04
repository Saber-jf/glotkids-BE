/**
 * Tavşanın Mutfağı — server.
 *
 * Two audiences, one process:
 *   the PANEL   edits a draft: words and their recordings, word sets, games,
 *               categories, files, the studio; publishes releases
 *   the APP     reads only what was published: `/api/app/manifest` and the
 *               files it names under `/cdn/<sha>.<ext>`
 *
 * Start-up order matters: the database (Postgres; migrations), the rows of
 * the old SQLite file the first time (development's move, `storage/copy.ts`),
 * the app's own pictures, the app's inventory (what it can play -- the
 * built-in rows come from it), then the one-time move from the old JSON
 * files. Architecture and the reasons for it: `../loplop/docs/ICERIK-MIMARISI.md`.
 * The routes: `app.ts`.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { dbInfo, meta, openDb } from "./storage/sql.js";
import { copyFrom, isEmpty } from "./storage/copy.js";
import { ensureDirs } from "./storage/files.js";
import { installBuiltins } from "./storage/builtin.js";
import { importFromAppDir } from "./modules/inventory.js";
import { migrateJson } from "./migrate-json.js";
import { buildApp } from "./app.js";
import { holdDataFolder, RESTORE_MARK } from "./storage/lock.js";
import { holdDatabase } from "./storage/owner.js";
import { markInterruptedJobs } from "./modules/jobs.js";

await ensureDirs();
/* one process per data folder: a second one stops here (storage/lock.ts) */
holdDataFolder(config.dataDir);
if (existsSync(path.join(config.dataDir, RESTORE_MARK)))
  throw new Error(`${config.dataDir} klasörüne bir geri yükleme yarım kaldı (${RESTORE_MARK}). `
    + "Aynı komutu (npm run restore -- --from <aynı yedek> --to <bu klasör>) yeniden çalıştırın; tamamlanınca sunucu açılır.");
/* one server per database, whatever its folder -- taken before the
   migrations and before anything is written (storage/owner.ts) */
const owner = await holdDatabase();
await openDb();
await owner?.claim();
const where = dbInfo();
console.log(`veritabanı: ${where.kind === "embedded" ? "gömülü Postgres" : "PostgreSQL"} — ${where.where}`);

/* the move from SQLite (2026-10-18): the embedded database, empty, takes in
   the folder's old file once. A real Postgres never does this by itself --
   its rows come with `npm run db:copy`, chosen by a person (an old file in
   the folder could be older than what the embedded database has since). */
const old = path.join(config.dataDir, "loplop.db");
if (where.kind === "embedded" && existsSync(old) && !(await meta.get("imported-sqlite")) && await isEmpty()) {
  const n = await copyFrom({ sqlite: old });
  await meta.set("imported-sqlite", JSON.stringify({ at: new Date().toISOString(), from: old, rows: n }));
  console.log(`eski SQLite veritabanı taşındı (${old}): ${Object.entries(n).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(", ")}`);
}

await installBuiltins();
const app = await buildApp();
const log = (m: string) => app.log.info(m);
await importFromAppDir(log);
await migrateJson(log);
/* jobs that were out when the last process stopped: their cost is unknown.
   Only now: this server holds the folder and the database, so a job still
   "running" is no other live server's (storage/owner.ts) */
const lost = await markInterruptedJobs();
if (lost) log(`${lost} ücretli iş yarıda kaldı: durumu "belirsiz" yapıldı (otomatik tekrar gönderilmez)`);

await app.listen({ port: config.port, host: config.host });
