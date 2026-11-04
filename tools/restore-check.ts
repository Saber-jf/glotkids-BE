/**
 * THE MONTHLY RESTORE DRILL (decision 4): restore a backup into an empty
 * folder, start a server on it (its own port, its own key), and check what a
 * restore must give back -- the panel's content, every published release a
 * phone may ask for, and their files byte for byte.
 *
 *   BACKUP_PASSPHRASE=… npm run restore-check -- --from yedek.tar.gz.enc
 *
 * The copy runs on an EMBEDDED database in a temporary folder -- never on
 * DATABASE_URL: nothing here touches the live data. Opening the panel
 * against it is the last, manual step: the command prints how.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const arg = (k: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const from = arg("--from");
if (!from) { console.error("kullanım: npm run restore-check -- --from <yedek>"); process.exit(1); }

let fail = 0;
const ok = (what: string, cond: boolean, note = "") => {
  if (!cond) { fail++; console.error(`  HATA  ${what}${note ? "  — " + note : ""}`); }
  else console.log(`  tamam ${what}${note ? "  (" + note + ")" : ""}`);
};

const dir = mkdtempSync(path.join(tmpdir(), "loplop-tatbikat-"));
/* the drill's own database: embedded, in its own folder (not the live one) */
process.env.DATABASE_URL = "";
process.env.NODE_ENV = "development";
const data = path.join(dir, "data");
const PORT = 8900 + Math.floor(Math.random() * 90);
const KEY = "tatbikat-" + Math.random().toString(36).slice(2);
const B = `http://127.0.0.1:${PORT}`;
const t0 = Date.now();
let srv: ReturnType<typeof spawn> | null = null;
try {
  const { restore } = await import("./restore.js");
  const r = await restore(from, data);
  ok("geri yükleme (bütünlük + dosya özetleri)", true, `${r.rows} satır, ${r.blobs} dosya`);
  srv = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    env: { ...process.env, DATA_DIR: data, DATABASE_URL: "", NODE_ENV: "development", PORT: String(PORT), ADMIN_TOKEN: KEY,
           LOG_LEVEL: "error", APP_DIR: path.join(dir, "uygulama-yok") },
    stdio: ["ignore", "inherit", "inherit"] });
  const get = async (p: string) => {
    const res = await fetch(B + p, { headers: { Authorization: `Bearer ${KEY}` } });
    return { status: res.status, body: res.headers.get("content-type")?.includes("json") ? await res.json() : await res.arrayBuffer() };
  };
  let up = false;
  for (let i = 0; i < 80 && !up; i++) { try { up = (await fetch(`${B}/api/health`)).ok; } catch { /* not yet */ } if (!up) await new Promise((x) => setTimeout(x, 250)); }
  ok("sunucu geri yüklenen veriyle açıldı", up);
  const sets = await get("/api/sets"), cats = await get("/api/categories"), words = await get("/api/words");
  ok("panelin içeriği: kelimeler, setler, kategoriler", sets.status === 200 && words.status === 200 && cats.status === 200,
     `${(words.body as unknown[]).length} kelime, ${(sets.body as unknown[]).length} set, ${(cats.body as unknown[]).length} kategori`);
  const db = await get("/api/db");
  ok("stüdyo belgesi", db.status === 200 || db.status === 404, db.status === 200 ? `rev ${(db.body as { rev: number }).rev}` : "yok");
  const assets = (await get("/api/assets")).body as { id: string }[];
  let seen = 0;
  for (const a of assets.slice(0, 5)) seen += (await get(`/api/assets/${a.id}`)).status === 200 ? 1 : 0;
  ok("örnek dosyalar açılıyor", seen === Math.min(5, assets.length), `${seen}/${Math.min(5, assets.length)}`);
  for (const ch of ["test", "production"]) {
    const m = await fetch(`${B}/api/app/manifest?build=99&schema=1&channel=${ch}`);
    if (m.status === 204) { console.log(`  —     ${ch} kanalında yayın yok`); continue; }
    const man = await m.json() as { release: number; assets: Record<string, { sha256: string; url: string }> };
    let good = 0;
    const list = Object.values(man.assets);
    for (const a of list) {
      const b = Buffer.from(await (await fetch(a.url.startsWith("http") ? a.url : B + a.url)).arrayBuffer());
      if (createHash("sha256").update(b).digest("hex") === a.sha256) good++;
    }
    ok(`${ch} kanalı: yayın ${man.release}, bütün dosyaları bayt bayt`, good === list.length, `${good}/${list.length}`);
  }
  console.log(`\nsüre: ${((Date.now() - t0) / 1000).toFixed(1)} sn (hedef: 4 saat içinde geri dönüş)`);
  console.log(`Paneli bu kopyaya karşı açmak için: loplop-admin klasöründe API_TARGET=${B} npm run dev  (anahtar: ${KEY})`);
  if (process.argv.includes("--keep")) { console.log("sunucu açık bırakıldı (--keep); durdurmak için Ctrl+C"); await new Promise(() => {}); }
} catch (e) {
  fail++; console.error(`  HATA  ${(e as Error).message}`);
} finally {
  srv?.kill();
  if (!process.argv.includes("--keep")) rmSync(dir, { recursive: true, force: true });
}
console.log(fail ? `\ngeri yükleme tatbikatı: ${fail} HATA` : "\ngeri yükleme tatbikatı: geçti");
process.exit(fail ? 1 : 0);
