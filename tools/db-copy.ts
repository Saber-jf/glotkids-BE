/**
 * COPY THE ROWS of another database into this server's (empty) database.
 *
 *   DATABASE_URL=postgres://… npm run db:copy -- --from ./data/pgdata     the embedded one, to a real Postgres
 *   DATABASE_URL=postgres://… npm run db:copy -- --from ./data/loplop.db  an old SQLite file
 *   DATABASE_URL=postgres://… npm run db:copy -- --from postgres://…      one Postgres to another
 *
 * The target is what the server would use: DATABASE_URL, or the embedded
 * database of DATA_DIR. It must be empty. Stop the server first when the
 * source is an embedded database (one process at a time can open it).
 *
 * The rows only: copy `DATA_DIR/blobs/` (and `secrets.json`) to the new
 * server's data folder as well -- the rows name files by their hash and
 * expect them there.
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };

async function main() {
  const from = arg("--from");
  if (!from) throw new Error("kullanım: npm run db:copy -- --from <data/pgdata | data/loplop.db | postgres://…>");
  const { copyFrom, describe } = await import("../src/storage/copy.js");
  const sql = await import("../src/storage/sql.js");
  const src = /^postgres(ql)?:\/\//.test(from) ? { url: from }
    : existsSync(from) && statSync(from).isDirectory() ? { dir: path.resolve(from) }
    : existsSync(from) ? { sqlite: path.resolve(from) } : null;
  if (!src) throw new Error(`Kaynak bulunamadı: ${from}`);
  const target = sql.dbInfo();
  if ("dir" in src && target.kind === "embedded" && path.resolve(target.where) === src.dir)
    throw new Error("Kaynak ile hedef aynı veritabanı.");
  console.log(`kaynak: ${describe(src)}\nhedef:  ${target.kind === "embedded" ? "gömülü Postgres" : "PostgreSQL"} ${target.where}`);
  await sql.openDb();
  try {
    const n = await copyFrom(src);
    console.log(`kopyalandı: ${Object.entries(n).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(", ") || "boş kaynak"}`);
    console.log("Dosyalar satır değildir: DATA_DIR/blobs/ klasörünü (ve secrets.json'u) yeni sunucunun veri klasörüne de kopyalayın.");
  } finally { await sql.closeDb(); }
}

main().catch((e) => { console.error(`kopya BAŞARISIZ: ${(e as Error).message}`); process.exit(1); });
