/**
 * THE DATABASE'S OWN GUARANTEES, on a REAL PostgreSQL (2026-10-19): what the
 * embedded one cannot show (two servers, two connections, a source written
 * while it is copied) and what the review asked to be proved there.
 *
 *   TEST_DATABASE_URL=postgres://user@127.0.0.1:5432/loplop_test npm run test:pg
 *
 * Every database here is made for the run on that server and dropped at the
 * end (`testdb.ts`, checked before anything is written). Without
 * TEST_DATABASE_URL the address checks still run; the rest says it did not.
 *
 *   1  the safety check itself
 *   2  migration 3: duplicates of "live" settled, the rules held, JSON checked
 *   3  a copy reads its source in one snapshot
 *   4  a copy's target is checked empty again under the lock
 *   5  a backup with a missing file is not a backup
 *   6  a restore checks the whole set before it writes
 *   7  a restore stopped half way is finished by running it again
 *   8  a second server on the same database: refused, and the first one's
 *      running jobs are left alone; the bond to the data folder
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

/* a child of this file: bring one database up to date and stop */
if (process.argv.includes("--migrate")) {
  const sql = await import("../src/storage/sql.js");
  await sql.openDb();
  await sql.closeDb();
  process.exit(0);
}

const { testDatabase, unsafeTestUrl } = await import("./testdb.js");

let fail = 0;
const skipped: string[] = [];
const ok = (what: string, cond: boolean, note = "") => {
  if (!cond) { fail++; console.error(`  HATA  ${what}${note ? "  — " + note : ""}`); }
  else console.log(`  gecti  ${what}${note ? "  (" + note + ")" : ""}`);
};
const section = (t: string) => console.log(`\n${t}`);

section("1. test veritabanı güvenlik kontrolü (yazmadan önce)");
const real = ["postgres://app:pw@db.example.org:5432/loplop"];
ok("uzak adres reddedilir", !!unsafeTestUrl("postgres://u@db.example.org/loplop_test", real));
ok("adında test olmayan reddedilir", !!unsafeTestUrl("postgres://u@127.0.0.1/loplop", real));
ok("sunucunun kendi veritabanı reddedilir (localhost = 127.0.0.1)",
   !!unsafeTestUrl("postgres://u@localhost:5432/loplop_test", ["postgres://x:y@127.0.0.1:5432/loplop_test"]));
ok("postgres olmayan adres reddedilir", !!unsafeTestUrl("mysql://u@127.0.0.1/loplop_test", real));
ok("yerel test veritabanı kabul edilir", unsafeTestUrl("postgres://u@127.0.0.1:5432/loplop_test", real) === null);
{
  const saved = process.env.TEST_DATABASE_URL;
  process.env.TEST_DATABASE_URL = "postgres://u@db.example.org:5432/loplop_test";
  let refused = "";
  try { await testDatabase("x"); } catch (e) { refused = (e as Error).message; }
  ok("testDatabase uzak adrese bağlanmadan reddeder", /reddedildi/.test(refused) && /yazılmadı/.test(refused), refused);
  if (saved === undefined) delete process.env.TEST_DATABASE_URL; else process.env.TEST_DATABASE_URL = saved;
}

if (!process.env.TEST_DATABASE_URL) {
  console.log("\nDENENMEDİ: TEST_DATABASE_URL yok — 2-8 yalnız gerçek bir PostgreSQL'de koşar.");
  process.exit(fail ? 1 : 0);
}

const pg = (await import("pg")).default;
const made: { drop(): Promise<void> }[] = [];
const fresh = async (tag: string) => { const d = await testDatabase(tag); made.push(d); return d.url; };
const client = async (url: string) => { const c = new pg.Client({ connectionString: url }); await c.connect(); return c; };
const errOf = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e as { code?: string; message: string }; } };
const tmp = mkdtempSync(path.join(tmpdir(), "loplop-pg-"));
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
/** the line a refused process said why on */
const said = (out: string) => out.split("\n").find((l) => /^\w*(Error|InUse)\b.*?:|BAŞARISIZ/.test(l))?.trim() ?? out.trim().split("\n").pop() ?? "";

/** run one of the server's commands in a process of its own */
function cmd(args: string[], env: Record<string, string>): Promise<{ code: number; out: string }> {
  const base = { ...process.env };
  for (const k of ["DATABASE_URL", "DATA_DIR", "BACKUP_PASSPHRASE", "LOPLOP_TEST_RESTORE_FAIL", "DATABASE_REBIND"]) delete base[k];
  return new Promise((res) => {
    /* DATABASE_URL always given: "" rather than whatever .env would fill in */
    const p = spawn(process.execPath, ["--import", "tsx", ...args], { env: { ...base, NODE_ENV: "test", DATABASE_URL: "", ...env } });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    p.on("exit", (code) => res({ code: code ?? 1, out }));
  });
}
const migrate = (url: string) => cmd(["test/pg.ts", "--migrate"], { DATABASE_URL: url });

/** a server on its own port: up (health answers) or gone (exited) */
async function server(data: string, url: string, env: Record<string, string> = {}) {
  const port = 8950 + Math.floor(Math.random() * 40);
  const base = { ...process.env };
  for (const k of ["DATABASE_URL", "DATA_DIR", "DATABASE_REBIND"]) delete base[k];
  const p = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    env: { ...base, NODE_ENV: "test", DATA_DIR: data, DATABASE_URL: url, PORT: String(port), LOG_LEVEL: "error",
           APP_DIR: path.join(tmp, "uygulama-yok"), ...env } });
  let out = "", exited: number | null = null;
  p.stdout.on("data", (d) => { out += d; });
  p.stderr.on("data", (d) => { out += d; });
  const gone = new Promise<number>((r) => p.on("exit", (c) => { exited = c ?? 1; r(exited); }));
  let up = false;
  for (let i = 0; i < 160 && !up && exited === null; i++) {
    try { up = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { /* not yet */ }
    if (!up) await new Promise((r) => setTimeout(r, 250));
  }
  return { up, out: () => out, exited: () => exited, gone,
           stop: async () => { if (exited === null) { p.kill("SIGTERM"); await gone; } } };
}

const T = await fresh("hedef");
/* the in-process database (`copyFrom`'s target) -- set BEFORE any of the
   server's modules load: config.ts reads it (and .env) once */
process.env.DATABASE_URL = T;
process.env.DATA_DIR = path.join(tmp, "hedef");
mkdirSync(process.env.DATA_DIR, { recursive: true });
process.env.NODE_ENV = "test";
const { MIGRATIONS, statements } = await import("../src/storage/sql.js");

try {
  /* ── 2 ───────────────────────────────────────────────────────────────── */
  section("2. göç 3: tek canlı şarkı/durak, tek canlı maskot/rol, JSON alanları");
  {
    const url = await fresh("goc");
    const c = await client(url);
    await c.query("CREATE TABLE schema_version (n INTEGER NOT NULL)");
    await c.query("INSERT INTO schema_version(n) VALUES (2)");
    for (const m of MIGRATIONS.slice(0, 2)) for (const s of statements(m)) await c.query(s);
    const song = (id: string, stop: string, at: number) =>
      c.query("INSERT INTO songs(id, title, stop, status, created_at, updated_at) VALUES ($1, $1, $2, 'live', $3, $3)", [id, stop, at]);
    await song("eski", "kitchen-music", 100); await song("yeni", "kitchen-music", 200); await song("b", "kitchen-music", 100);
    await song("tek", "animals-music", 300);
    const mascot = (id: string, role: string, at: number) =>
      c.query("INSERT INTO mascots(id, role, name, status, created_at, updated_at) VALUES ($1, $2, $1, 'live', $3, $3)", [id, role, at]);
    await mascot("m1", "learner", 100); await mascot("m2", "learner", 50); await mascot("f1", "friend", 10);
    const r = await migrate(url);
    ok("göç 3 iki canlısı olan veritabanında koşar", r.code === 0, r.out.slice(-300));
    /* a raw client: BIGINT comes back as text -- read as a number here */
    const st = async (t: string) => Object.fromEntries((await c.query(`SELECT id, status, updated_at::float8 AS updated_at FROM ${t}`)).rows.map((x) => [x.id, x]));
    const s = await st("songs"), m = await st("mascots");
    ok("durakta yayının seçtiği kalır (ilk oluşturulan, eşitse kimlik sırası)", s.b.status === "live" && s.eski.status === "draft" && s.yeni.status === "draft",
       JSON.stringify(Object.values(s).map((x) => `${x.id}:${x.status}`)));
    ok("taslağa inenin damgası ilerler (paneldeki eski kopya STALE alır)", s.eski.updated_at > 100 && s.yeni.updated_at > 200 && s.b.updated_at === 100);
    ok("öbür duraktaki tek canlı şarkıya dokunulmaz", s.tek.status === "live" && s.tek.updated_at === 300);
    ok("rolde ilk oluşturulan maskot kalır, öbür rol dokunulmaz", m.m2.status === "live" && m.m1.status === "draft" && m.f1.status === "live");
    ok("şema 3", (await c.query("SELECT n FROM schema_version")).rows[0].n === MIGRATIONS.length && MIGRATIONS.length === 3);
    const e1 = await errOf(c.query("UPDATE songs SET status = 'live' WHERE id = 'eski'"));
    ok("veritabanı aynı durakta ikinci canlı şarkıyı reddeder", e1?.code === "23505", e1?.message);
    const e2 = await errOf(c.query("UPDATE mascots SET status = 'live' WHERE id = 'm1'"));
    ok("veritabanı aynı rolde ikinci canlı maskotu reddeder", e2?.code === "23505", e2?.message);
    /* the routes' order: the old one (promote, then demote) is what the index refuses */
    await c.query("BEGIN");
    const e3 = await errOf(c.query("UPDATE songs SET status = 'live' WHERE id = 'yeni'"));
    await c.query("ROLLBACK");
    await c.query("BEGIN");
    await c.query("UPDATE songs SET status = 'draft' WHERE stop = 'kitchen-music' AND status = 'live' AND id <> 'yeni'");
    await c.query("UPDATE songs SET status = 'live' WHERE id = 'yeni'");
    await c.query("COMMIT");
    ok("eski sıra (önce canlı yap) reddedilir, yeni sıra (önce ötekini indir) geçer",
       e3?.code === "23505" && (await st("songs")).yeni.status === "live" && (await st("songs")).b.status === "draft");
    const bad = async (sqlText: string) => (await errOf(c.query(sqlText)))?.code ?? "kabul edildi";
    ok("şarkıda bozuk JSON reddedilir", (await bad("UPDATE songs SET brief = '{bozuk' WHERE id = 'tek'")) === "22P02");
    ok("şarkıda yanlış biçimli JSON reddedilir (takes dizi olmalı)", (await bad("UPDATE songs SET takes = '{}' WHERE id = 'tek'")) === "23514");
    ok("maskotta bozuk JSON reddedilir", (await bad("UPDATE mascots SET map = 'x' WHERE id = 'f1'")) === "22P02");
    ok("maskotta ayak boş ya da nesne", (await bad("UPDATE mascots SET foot = '[1]' WHERE id = 'f1'")) === "23514"
       && (await bad("UPDATE mascots SET foot = NULL WHERE id = 'f1'")) === "kabul edildi"
       && (await bad(`UPDATE mascots SET foot = '{"x":1,"y":2,"top":3}' WHERE id = 'f1'`)) === "kabul edildi");
    ok("NUL karakterli metin JSON'da geçerli kalır (jsonb değil json denetimi)",
       (await bad(`UPDATE songs SET brief = '{"a":"\\u0000"}' WHERE id = 'tek'`)) === "kabul edildi");
    await c.end();
  }

  /* ── 3, 4 ────────────────────────────────────────────────────────────── */
  const sql = await import("../src/storage/sql.js");
  const { copyFrom } = await import("../src/storage/copy.js");
  await sql.openDb();
  const WRITER = 0x6c6f706c6f70;

  section("3. kopya kaynağı tek tutarlı anlık görüntüden okur");
  {
    const S = await fresh("kaynak");
    ok("kaynak göçü", (await migrate(S)).code === 0);
    const c = await client(S);
    await c.query("INSERT INTO assets(id, sha256, kind, mime, ext, size, created_at) VALUES ('a1', 'aa', 'image', 'image/png', 'png', 1, 1)");
    await c.query("INSERT INTO words(id, en, tr, icon, created_at, updated_at) VALUES ('w1', 'one', 'bir', 'a1', 1, 1)");
    await c.query(`INSERT INTO meta(key, value) VALUES ('instance-id', 'kaynak'), ('data-folder', 'kaynagin-klasoru'), ('server-owner', '{}')`);
    const got = await copyFrom({ url: S }, { onRead: async (t) => {
      /* the source's server writes while the copy runs: a picture and a word
         that uses it, AFTER the assets were read and BEFORE the words are */
      if (t === "assets") {
        await c.query("INSERT INTO assets(id, sha256, kind, mime, ext, size, created_at) VALUES ('a2', 'bb', 'image', 'image/png', 'png', 1, 2)");
        await c.query("INSERT INTO words(id, en, tr, icon, created_at, updated_at) VALUES ('w2', 'two', 'iki', 'a2', 2, 2)");
      }
    } }).then((x) => x, (e) => ({ error: (e as Error).message }));
    ok("kopya, kaynak yazılırken tutarlı biter (sonradan gelen kelime ve resmi yok)",
       !("error" in got) && got.assets === 1 && got.words === 1, JSON.stringify(got));
    const t = await client(T);
    const words = (await t.query("SELECT id FROM words ORDER BY id")).rows.map((x) => x.id).join();
    const keys = (await t.query("SELECT key FROM meta ORDER BY key")).rows.map((x) => x.key).join();
    ok("hedefte yalnız anlık görüntüdekiler", words === "w1", words);
    ok("sunucuya ait meta anahtarları (klasör bağı, sahip) kopyalanmaz, sunucu kimliği kopyalanır", keys === "instance-id", keys);
    await t.query(`TRUNCATE ${sql.TABLES.join(", ")} CASCADE`);
    await t.end();
    await c.end();
  }

  section("4. kopya hedefin boşluğunu yazma kilidi altında yeniden denetler");
  {
    const S = await fresh("kaynak2");
    await migrate(S);
    const s = await client(S);
    await s.query("INSERT INTO sets(id, name, created_at, updated_at) VALUES ('k', 'kaynak', 1, 1)");
    await s.end();
    for (const how of ["yazıcı kilidiyle", "kilitsiz (tx dışı) yazım"] as const) {
      const other = await client(T);
      await other.query("BEGIN");
      if (how === "yazıcı kilidiyle") await other.query("SELECT pg_advisory_xact_lock($1)", [WRITER]);
      await other.query("INSERT INTO sets(id, name, created_at, updated_at) VALUES ('baska', 'başka sunucu', 1, 1)");
      /* the quick check sees an empty target (not committed yet); the copy then waits for the lock */
      const copy = copyFrom({ url: S }).then(() => "kopyaladı", (e) => (e as Error).message);
      await new Promise((r) => setTimeout(r, 600));
      await other.query("COMMIT");
      const r = await copy;
      const t = await client(T);
      const n = (await t.query("SELECT id FROM sets")).rows.map((x) => x.id).join();
      ok(`arada dolan hedef reddedilir — ${how}`, /boş değil/.test(r) && n === "baska", `${r}; sets: ${n}`);
      await t.query(`TRUNCATE ${sql.TABLES.join(", ")} CASCADE`);
      await t.end();
      await other.end();
    }
  }
  await sql.closeDb();

  /* ── 5 ───────────────────────────────────────────────────────────────── */
  section("5. eksik dosyalı yedek başarılı sayılmaz");
  const B = await fresh("yedek");
  const D = path.join(tmp, "veri");
  mkdirSync(path.join(D, "blobs"), { recursive: true });
  const out = path.join(tmp, "yedekler");
  let good = "";
  {
    await migrate(B);
    const c = await client(B);
    const there = Buffer.from("burada olan dosya"), gone = Buffer.from("diskte olmayan dosya");
    writeFileSync(path.join(D, "blobs", `${sha(there)}.png`), there);
    await c.query("INSERT INTO assets(id, sha256, kind, mime, ext, size, created_at) VALUES ('var', $1, 'image', 'image/png', 'png', $2, 1), ('yok', $3, 'image', 'image/png', 'png', $4, 1)",
                  [sha(there), there.length, sha(gone), gone.length]);
    await c.query("INSERT INTO words(id, en, tr, icon, created_at, updated_at) VALUES ('w', 'w', 'v', 'var', 1, 1)");
    await c.query(`INSERT INTO songs(id, title, stop, created_at, updated_at) VALUES ('s', 'şarkı', 'kitchen-music', 1, 1)`);
    const r1 = await cmd(["tools/backup.ts", "--out", out], { DATABASE_URL: B, DATA_DIR: D });
    const bad = readdirSync(out).find((f) => f.endsWith("-EKSIK"));
    const info = bad ? JSON.parse(readFileSync(path.join(out, bad, "YEDEK.json"), "utf8")) : null;
    ok("eksik dosya: komut hata ile biter", r1.code !== 0 && /EKSİK/.test(r1.out), r1.out.trim().split("\n").pop());
    ok("klasör -EKSIK adını ve complete:false taşır", !!bad && info?.complete === false && /diskte yok/.test(info?.error ?? ""));
    ok("başarılı yedek klasörü yok", !readdirSync(out).some((f) => f.startsWith("loplop-") && !f.endsWith("-EKSIK")));
    writeFileSync(path.join(D, "blobs", `${sha(gone)}.png`), gone);
    const r2 = await cmd(["tools/backup.ts", "--out", out], { DATABASE_URL: B, DATA_DIR: D });
    good = path.join(out, readdirSync(out).find((f) => f.startsWith("loplop-") && !f.endsWith("-EKSIK")) ?? "yok");
    const gi = existsSync(path.join(good, "YEDEK.json")) ? JSON.parse(readFileSync(path.join(good, "YEDEK.json"), "utf8")) : {};
    ok("dosyalar tamken yedek geçer", r2.code === 0 && gi.complete === true && gi.blobs === 2, r2.out.trim().split("\n").pop());
    ok("her tablo dosyasının satır sayısı ve özeti yazılır", Object.keys(gi.files ?? {}).length === sql.TABLES.length
       && gi.files.words.rows === 1 && gi.files.words.sha256 === sha(readFileSync(path.join(good, "db", "words.jsonl"))));
    const r3 = await cmd(["tools/restore.ts", "--from", path.join(out, bad!), "--to", path.join(tmp, "eksikten")], { DATABASE_URL: await fresh("eksikten") });
    ok("EKSIK yedek geri yüklenmez", r3.code !== 0 && /eksik/i.test(r3.out) && !existsSync(path.join(tmp, "eksikten")), r3.out.trim().split("\n").pop());
    await c.end();
  }

  /* ── 6 ───────────────────────────────────────────────────────────────── */
  section("6. geri yükleme yazmadan önce bütün seti denetler");
  {
    const tampered = (name: string, f: (dir: string) => void) => {
      const dir = path.join(tmp, "bozuk", name, path.basename(good));
      cpSync(good, dir, { recursive: true });
      f(dir);
      return dir;
    };
    const info = (dir: string) => JSON.parse(readFileSync(path.join(dir, "YEDEK.json"), "utf8"));
    const setInfo = (dir: string, x: unknown) => writeFileSync(path.join(dir, "YEDEK.json"), JSON.stringify(x));
    const cases: [string, string, RegExp][] = [
      ["tablo dosyası eksik (sessizce atlanmaz)", tampered("eksik-tablo", (d) => unlinkSync(path.join(d, "db", "songs.jsonl"))), /"songs" tablosunun dosyası yok/],
      ["tablo dosyasının özeti tutmuyor", tampered("ozet", (d) => writeFileSync(path.join(d, "db", "words.jsonl"),
         readFileSync(path.join(d, "db", "words.jsonl"), "utf8").replace('"v"', '"x"'))), /bozuk/],
      ["satır sayısı tutmuyor", tampered("sayi", (d) => { const i = info(d); i.rows.words = 5; setInfo(d, i); }), /5 satır diyor/],
      ["satır sayısı yazılmamış", tampered("sayisiz", (d) => { const i = info(d); delete i.rows.sets; setInfo(d, i); }), /satır sayısını içermiyor/],
      ["daha yeni şema", tampered("sema", (d) => { const i = info(d); i.schema = 99; setInfo(d, i); }), /daha yeni/],
      ["şema yok", tampered("semasiz", (d) => { const i = info(d); delete i.schema; setInfo(d, i); }), /şema sürümü/],
      ["YEDEK.json yok", tampered("bilgisiz", (d) => unlinkSync(path.join(d, "YEDEK.json"))), /YEDEK\.json yok/],
      ["tanınmayan tablo", tampered("yabanci", (d) => writeFileSync(path.join(d, "db", "baska.jsonl"), "{}\n")), /tanımadığı/],
      ["dosya eksik", tampered("blob", (d) => { for (const f of readdirSync(path.join(d, "blobs"))) { unlinkSync(path.join(d, "blobs", f)); break; } }), /eksik dosya/],
      ["satır bozuk", tampered("satir", (d) => { const f = path.join(d, "db", "sets.jsonl"); writeFileSync(f, "bozuk\n");
         const i = info(d); i.rows.sets = 1; delete i.files; setInfo(d, i); }), /okunamıyor/],
    ];
    for (const [what, dir, want] of cases) {
      const to = path.join(tmp, "geri-" + Math.random().toString(36).slice(2));
      const url = await fresh("ret");
      const r = await cmd(["tools/restore.ts", "--from", dir, "--to", to], { DATABASE_URL: url });
      const c = await client(url);
      const tables = Number((await c.query("SELECT count(*) AS n FROM information_schema.tables WHERE table_schema = 'public'")).rows[0].n);
      await c.end();
      ok(`reddedilir: ${what}; klasöre ve veritabanına hiçbir şey yazılmaz`, r.code !== 0 && want.test(r.out) && !existsSync(to) && tables === 0,
         `${r.out.trim().split("\n").pop()} · tablo ${tables}`);
    }
    const old = tampered("eski-bicim", (d) => { const i = info(d); delete i.files; delete i.complete; delete i.tables; setInfo(d, i); });
    const to = path.join(tmp, "eski-bicimden");
    const r = await cmd(["tools/restore.ts", "--from", old, "--to", to], { DATABASE_URL: await fresh("eskibicim") });
    ok("bugünden önceki yedek (özetsiz) satır sayısıyla denetlenip geri yüklenir", r.code === 0 && /özeti yok/.test(r.out), r.out.trim().split("\n").pop());
  }

  /* ── 7 ───────────────────────────────────────────────────────────────── */
  section("7. yarım kalan geri yükleme aynı komutla tamamlanır");
  {
    const counts = async (url: string) => {
      const c = await client(url);
      const n: Record<string, number> = {};
      for (const t of ["assets", "words", "songs", "meta"])
        n[t] = Number((await c.query(`SELECT count(*) AS n FROM ${t}`).catch(() => ({ rows: [{ n: -1 }] }))).rows[0].n);
      await c.end();
      return n;
    };
    /* stopped while copying the files: no row written yet */
    const R = await fresh("yarim1"), F = path.join(tmp, "yarim1");
    const a = await cmd(["tools/restore.ts", "--from", good, "--to", F], { DATABASE_URL: R, LOPLOP_TEST_RESTORE_FAIL: "files" });
    ok("dosyalar yarımda durdu: hata, işaret klasörde", a.code !== 0 && existsSync(path.join(F, ".restore-incomplete.json")) && /kaldığı yerden/.test(a.out));
    const s = await server(F, R);
    await s.stop();
    ok("yarım klasörle sunucu açılmaz (boş veritabanını kendi satırlarıyla doldurmaz)", !s.up && s.exited() !== 0 && /yarım kaldı/.test(s.out()),
       said(s.out()));
    const other = path.join(tmp, "bozuk", "eski-bicim", path.basename(good));
    const x = await cmd(["tools/restore.ts", "--from", other, "--to", F], { DATABASE_URL: R });
    ok("yarım klasöre başka bir (geçerli) yedek konmaz", x.code !== 0 && /başka bir yedeğin yarım/.test(x.out), x.out.trim().split("\n").pop());
    const b = await cmd(["tools/restore.ts", "--from", good, "--to", F], { DATABASE_URL: R });
    const n1 = await counts(R);
    ok("ikinci çalıştırma tamamlar", b.code === 0 && /tamamlandı/.test(b.out) && !existsSync(path.join(F, ".restore-incomplete.json")), b.out.trim().split("\n").pop());
    ok("satırlar ve dosyalar tam", n1.assets === 2 && n1.words === 1 && n1.songs === 1 && readdirSync(path.join(F, "blobs")).length === 2, JSON.stringify(n1));

    /* stopped after the rows committed: run again, no row twice */
    const R2 = await fresh("yarim2"), F2 = path.join(tmp, "yarim2");
    const c1 = await cmd(["tools/restore.ts", "--from", good, "--to", F2], { DATABASE_URL: R2, LOPLOP_TEST_RESTORE_FAIL: "db" });
    const mid = await counts(R2);
    ok("satırlar yazıldıktan sonra durdu: işaret duruyor", c1.code !== 0 && mid.words === 1 && existsSync(path.join(F2, ".restore-incomplete.json")));
    const c2 = await cmd(["tools/restore.ts", "--from", good, "--to", F2], { DATABASE_URL: R2 });
    const n2 = await counts(R2);
    ok("yeniden çalıştırma satırları ikinci kez yazmaz, bitirir", c2.code === 0 && n2.words === 1 && n2.assets === 2 && !existsSync(path.join(F2, ".restore-incomplete.json")),
       `${c2.out.trim().split("\n").pop()} ${JSON.stringify(n2)}`);
    const full = await cmd(["tools/restore.ts", "--from", good, "--to", path.join(tmp, "yeni-klasor")], { DATABASE_URL: R2 });
    ok("aynı setin satırları olan dolu veritabanına yeni klasörden geri yükleme reddedilir; klasör açılmaz",
       full.code !== 0 && /boş değil/.test(full.out) && !existsSync(path.join(tmp, "yeni-klasor")), full.out.trim().split("\n").pop());
    const emptyDir = path.join(tmp, "var-olan-bos");
    mkdirSync(emptyDir);
    const full2 = await cmd(["tools/restore.ts", "--from", good, "--to", emptyDir], { DATABASE_URL: R2 });
    ok("önceden var olan boş klasör, ret sonrası yine boş (ikinci deneme 'klasör dolu' demez)",
       full2.code !== 0 && /boş değil/.test(full2.out) && readdirSync(emptyDir).length === 0, readdirSync(emptyDir).join());
    const s2 = await server(F2, R2);
    ok("tamamlanan klasörle sunucu açılır", s2.up, s2.out().slice(-300));
    await s2.stop();
  }

  /* ── 8 ───────────────────────────────────────────────────────────────── */
  section("8. aynı veritabanına ikinci sunucu");
  {
    const U = await fresh("iki");
    const A = path.join(tmp, "sunucuA"), Bd = path.join(tmp, "sunucuB");
    mkdirSync(A); mkdirSync(Bd);
    const a = await server(A, U);
    ok("ilk sunucu açılır ve veritabanını klasörüne bağlar", a.up, a.out().slice(-200));
    const c = await client(U);
    await c.query(`INSERT INTO jobs(id, kind, status, request, created_at, updated_at) VALUES ('suren-is', 'voice', 'running', '{}', 1, 1)`);
    const b = await server(Bd, U, { DATABASE_LOCK_WAIT_MS: "1500" });
    await b.stop();
    const job = async () => (await c.query("SELECT status FROM jobs WHERE id = 'suren-is'")).rows[0]?.status;
    ok("başka klasörlü ikinci sunucu açılmaz", !b.up && b.exited() !== 0 && /başka bir sunucu kullanıyor/.test(b.out()), said(b.out()));
    ok("ilk sunucunun süren işi 'belirsiz' sayılmaz", (await job()) === "running");
    /* the same folder copied to another machine: the same folder id, so the bond lets it by -- the lock does not */
    cpSync(A, A + "-kopya", { recursive: true, filter: (f) => path.basename(f) !== "server.lock" });
    const b2 = await server(A + "-kopya", U, { DATABASE_LOCK_WAIT_MS: "800" });
    await b2.stop();
    ok("aynı klasörün kopyasıyla da (başka makine) açılmaz", !b2.up && /başka bir sunucu kullanıyor/.test(b2.out()));
    /* the lock's connection dropped: taken again, the server keeps running */
    await c.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'loplop-server-owner' AND datname = current_database()");
    let back = false;
    for (let i = 0; i < 40 && !back; i++) {
      await new Promise((r) => setTimeout(r, 250));
      back = Number((await c.query("SELECT count(*) AS n FROM pg_locks l JOIN pg_stat_activity s USING (pid) WHERE l.locktype = 'advisory' AND s.application_name = 'loplop-server-owner' AND s.datname = current_database()")).rows[0].n) === 1;
    }
    ok("kilidin bağlantısı koparsa yeniden alınır, sunucu çalışmaya devam eder", back && a.exited() === null && /yeniden alındı/.test(a.out()));
    const b3 = await server(Bd, U, { DATABASE_LOCK_WAIT_MS: "800" });
    await b3.stop();
    ok("kilit yeniden alındıktan sonra da ikinci sunucu açılmaz", !b3.up);
    await a.stop();
    ok("ilk sunucu durunca iş hâlâ 'running' (kimse başlamadı)", (await job()) === "running");
    const b4 = await server(Bd, U, { DATABASE_LOCK_WAIT_MS: "800" });
    await b4.stop();
    ok("ilk sunucu dursa da başka klasörle açılmaz (dosyalar o klasörde)", !b4.up && /başka bir veri klasörüne bağlı/.test(b4.out()), said(b4.out()));
    ok("reddedilen sunucu işi işaretlemez", (await job()) === "running");
    const a2 = await server(A, U);
    ok("kendi klasörüyle yeniden açılır; önceki sürecin işi şimdi 'belirsiz'", a2.up && (await job()) === "uncertain");
    await a2.stop();
    await c.query("UPDATE jobs SET status = 'running' WHERE id = 'suren-is'");
    const b5 = await server(Bd, U, { DATABASE_REBIND: "1" });
    const bond = (await c.query("SELECT value FROM meta WHERE key = 'data-folder'")).rows[0]?.value;
    ok("DATABASE_REBIND=1: kişinin kararıyla yeni klasöre bağlanır", b5.up && /yeniden bağlandı/.test(b5.out())
       && bond === readFileSync(path.join(Bd, "folder-id"), "utf8").trim());
    await b5.stop();
    await c.end();
  }
} catch (e) {
  fail++; console.error("  PATLADI", e);
} finally {
  for (const d of made) await d.drop().catch((e) => console.error(`test veritabanı silinemedi: ${(e as Error).message}`));
  rmSync(tmp, { recursive: true, force: true });
}
if (skipped.length) console.log(`\nDENENMEDİ: ${skipped.join("; ")}`);
console.log(fail ? `\npostgres: ${fail} HATA` : "\npostgres: hepsi gecti");
process.exit(fail ? 1 : 0);
