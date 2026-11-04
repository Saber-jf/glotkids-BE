/**
 * The review's findings (S01–S12, A02/A03/A08/A09), each as the behaviour
 * that must hold -- driven through the real routes (`inject`, no network) and
 * the real storage functions, on a data folder of its own. Providers are a
 * fake `fetch`: nothing paid is ever called. The phone's side is the APP'S
 * OWN manifest reader (`../loplop/src/core/remote.ts`), handed the manifest
 * this server really publishes.
 *
 *   npm run test:units
 */
import { mkdtempSync, readFileSync, utimesSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";

const data = mkdtempSync(path.join(tmpdir(), "loplop-units-"));
process.env.DATA_DIR = data;
process.env.ADMIN_TOKEN = "TEST_ADMIN_TOKEN_123";
process.env.LOG_LEVEL = "info";
const appDir = path.resolve(process.env.APP_DIR ?? "../loplop");
process.env.APP_DIR = appDir;
/* never the real database (a DATABASE_URL in the shell or in .env): an
   embedded one in the test's own folder, or a database of this run's own on
   the Postgres TEST_DATABASE_URL names (the driver the server uses in
   production) -- checked BEFORE anything opens it (testdb.ts) */
const { testDatabase } = await import("./testdb.js");
const tdb = await testDatabase("units");
process.env.DATABASE_URL = tdb.url;
process.env.NODE_ENV = "test";

const { openDb, closeDb } = await import("../src/storage/sql.js");
const files = await import("../src/storage/files.js");
const { importFromAppDir, importInventory } = await import("../src/modules/inventory.js");
const { buildApp, redactUrl } = await import("../src/app.js");
const ai = await import("../src/modules/ai.js");
const { diff, buildDraft } = await import("../src/modules/releases.js");

let fail = 0;
const ok = (what: string, cond: boolean, note = "") => {
  if (!cond) { fail++; console.error(`  HATA  ${what}${note ? "  — " + note : ""}`); }
  else console.log(`  gecti  ${what}${note ? "  (" + note + ")" : ""}`);
};
const section = (t: string) => console.log(`\n${t}`);

/* the server's listening socket keeps a real process alive; a test has none,
   and a pending AbortSignal.timeout does not hold the loop open */
const keepAlive = setInterval(() => {}, 1000);
await files.ensureDirs();
await openDb();
if (!(await (await import("../src/storage/copy.js")).isEmpty())) {
  console.error("Test veritabanı boş değil: testler yalnız boş bir veritabanında koşar (içine test verisi yazarlar).");
  process.exit(1);
}
console.log(`veritabanı: ${tdb.url ? `PostgreSQL (bu koşunun: ${tdb.name})` : "gömülü"}`);
const logs: string[] = [];
const app = await buildApp({ logStream: new Writable({ write(c, _e, cb) { logs.push(String(c)); cb(); } }) });
await importFromAppDir(() => {});
const AUTH = { authorization: "Bearer TEST_ADMIN_TOKEN_123" };

type Res = { status: number; body: any; headers: Record<string, unknown> };
async function j(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const r = await app.inject({ method: method as never, url, headers: { ...AUTH, ...headers },
                               ...(body !== undefined ? { payload: body as never } : {}) });
  let parsed: unknown = null;
  try { parsed = r.body ? JSON.parse(r.body) : null; } catch { parsed = r.body; }
  return { status: r.statusCode, body: parsed, headers: r.headers as Record<string, unknown> };
}
async function upload(buf: Buffer, name: string, mime: string, id?: string) {
  const boundary = "----loplop" + Math.random().toString(16).slice(2);
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mime}\r\n\r\n`),
    buf, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const r = await app.inject({ method: "POST", url: `/api/assets${id ? `?id=${id}` : ""}`, payload,
                               headers: { ...AUTH, "content-type": `multipart/form-data; boundary=${boundary}` } });
  return { ...JSON.parse(r.body), status: r.statusCode } as { id: string; sha256: string; url: string; status: number; code?: string; mime?: string };
}
const png = (n: number) => Buffer.concat([readFileSync(path.join(appDir, "src/assets/icons/banana.png")), Buffer.from([n])]);
const mp3 = (n: number) => Buffer.from(`ID3fake-mp3-${n}-${"x".repeat(40)}`);

/* ── S01: renaming a set keeps its words ─────────────────────────────────── */
section("S01 · set PATCH yalnız gönderilen alanı değiştirir");
{
  const s = (await j("POST", "/api/sets", { name: "Deneme Seti", note: "not burada", words: ["apple", "banana"] })).body;
  const r1 = await j("PATCH", `/api/sets/${s.id}`, { name: "Yeni Ad" });
  ok("yalnız ad: kelimeler ve not korunur", r1.body.words.join() === "apple,banana" && r1.body.note === "not burada" && r1.body.name === "Yeni Ad");
  const r2 = await j("PATCH", `/api/sets/${s.id}`, { note: "yeni not" });
  ok("yalnız not: kelimeler korunur", r2.body.words.join() === "apple,banana" && r2.body.note === "yeni not");
  const r3 = await j("PATCH", `/api/sets/${s.id}`, { words: ["banana", "apple"] });
  ok("yalnız sıra: not korunur", r3.body.words.join() === "banana,apple" && r3.body.note === "yeni not");
  const r4 = await j("PATCH", `/api/sets/${s.id}`, {});
  ok("boş patch hiçbir şeyi değiştirmez", r4.body.words.join() === "banana,apple" && r4.body.note === "yeni not" && r4.body.name === "Yeni Ad");
  const r5 = await j("PATCH", `/api/sets/${s.id}`, { words: [] });
  ok("bilerek gönderilen [] seti boşaltır", r5.status === 200 && r5.body.words.length === 0);
  const r6 = await j("PATCH", "/api/sets/kitchen", { name: "Mutfak" });
  ok("uygulamanın setinin adı değişir, kelimeleri gönderilmedikçe reddedilmez", r6.status === 200 && r6.body.words.length === 7);
  const r7 = await j("PATCH", "/api/sets/kitchen", { words: [] });
  ok("uygulamanın setinin kelimeleri değişmez", r7.status === 400);
  await j("PATCH", "/api/sets/kitchen", { name: "Mutfak" });
}

/* ── A02: a write based on an old version is refused ─────────────────────── */
section("A02 · eski sürüme dayanan yazım 409");
{
  const s = (await j("POST", "/api/sets", { name: "Surum Seti", words: ["apple", "banana"] })).body;
  const a = await j("PATCH", `/api/sets/${s.id}`, { name: "A" }, { "if-match": `"${s.updatedAt}"` });
  const b = await j("PATCH", `/api/sets/${s.id}`, { name: "B" }, { "if-match": `"${s.updatedAt}"` });
  ok("ilk yazım geçer", a.status === 200);
  ok("aynı eski sürüme dayanan ikinci yazım 409 STALE, güncel hâliyle", b.status === 409 && b.body.code === "STALE" && b.body.current.name === "A");
  const c = await j("PATCH", `/api/sets/${s.id}`, { name: "C" }, { "if-match": `"${a.body.updatedAt}"` });
  ok("güncel sürümle yazım geçer", c.status === 200 && c.body.name === "C");
}

/* ── S02 / S03: categories with the app's own drag/pop reach the phone ───── */
section("S02/S03 · hazır drag/pop ve gizli oyunlu kategori telefona eksiksiz gider");
const icon1 = await upload(png(1), "kite.png", "image/png");
const icon2 = await upload(png(2), "boat.png", "image/png");
let catId = "";
{
  for (const [id, en, tr, ic] of [["kite", "kite", "uçurtma", icon1.id], ["boat", "boat", "tekne", icon2.id]] as const)
    await j("POST", "/api/words", { id, en, tr, about: `${tr} güzeldir.`, icon: ic });
  const set = (await j("POST", "/api/sets", { name: "Gokyuzu", words: ["kite", "boat", "apple"] })).body;
  const hidden = (await j("POST", "/api/games", { template: "pop", name: "Gizli Bul", set: set.id })).body;
  await j("PATCH", `/api/games/${hidden.id}`, { status: "hidden" });
  const live = (await j("POST", "/api/games", { template: "drag", name: "Menudeki Ver", set: set.id })).body;
  await j("PATCH", `/api/games/${live.id}`, { status: "live" });
  const cat = (await j("POST", "/api/categories", { title: "Gokyuzu Serisi", set: set.id })).body;
  catId = cat.id;
  const steps = [
    { id: "g1", kind: "game", game: "drag", teach: true },
    { id: "g2", kind: "game", game: "pop", teach: false },
    { id: "g3", kind: "game", game: hidden.id, teach: false },
    { id: "g4", kind: "game", game: live.id, teach: false },
    { id: "done", kind: "finish" },
  ];
  const p = await j("PATCH", `/api/categories/${cat.id}`, { steps, status: "live" });
  ok("karışık kategori canlı yapılabildi (hata yok)", p.status === 200, JSON.stringify(p.body.issues ?? p.body).slice(0, 160));
  const pub = await j("POST", "/api/releases", { note: "s02", channels: ["test"] });
  ok("yayınlandı", pub.status === 201);
  const man = await j("GET", "/api/app/manifest?build=1&schema=1&channel=test");
  const mc = man.body.categories.find((c: { id: string }) => c.id === cat.id);
  ok("kategori telefonun manifestinde", !!mc);
  ok("her oyun adımı kendi motorunu taşır", mc?.steps.filter((s: { kind: string }) => s.kind === "game")
    .every((s: { template?: string }) => s.template === "drag" || s.template === "pop"));
  const gids = man.body.games.map((g: { id: string }) => g.id);
  ok("menüde yalnız bağımsız canlı oyun (gizli bağımlı ve hazır kart yok)", gids.join() === live.id, gids.join());
  writeFileSync(path.join(data, "manifest.json"), JSON.stringify(man.body));

  /* the phone's own reader, given exactly this */
  const remote = await import("../../loplop/src/core/remote.ts");
  const r = remote.readManifest(man.body, (id: string) => `file:///phone/${id}`);
  const rc = r.categories.find((c: { id: string }) => c.id === cat.id);
  ok("mobil readManifest kategoriyi açar, dört oyun adımıyla", !!rc && rc.steps.filter((s: { kind: string }) => s.kind === "game").length === 4,
     rc ? rc.steps.map((s: { kind: string; template?: string }) => s.template ?? s.kind).join() : "yok");
  ok("mobil menüde tek yeni oyun", r.games.length === 1 && r.games[0].id === live.id);
  const cats = await j("GET", "/api/app/categories");
  ok("eski biçim uç hazır motorlu kategoride çökmez", cats.status === 200);
}

/* ── S04: a new picture under the same name, or a new order, is a change ── */
section("S04 · aynı kimlikte yeni görsel, eski görsele dönüş ve yalnız sıra değişimi farktır");
{
  await upload(png(9), "kite2.png", "image/png", icon1.id);
  const d1 = (await j("GET", "/api/releases/draft")).body;
  ok("aynı kimlik, yeni bayt: kelime değişti", d1.diff.test.changed.includes("kelime: kite"), d1.diff.test.changed.join());
  await j("POST", "/api/releases", { note: "yeni kite", channels: ["test"] });
  await upload(png(1), "kite.png", "image/png", icon1.id);
  const d2 = (await j("GET", "/api/releases/draft")).body;
  ok("eski bayta dönüş de değişiklik", d2.diff.test.changed.includes("kelime: kite"));
  await j("POST", "/api/releases", { note: "eski kite", channels: ["test"] });
  const set2 = (await j("POST", "/api/sets", { name: "Ikinci", words: ["kite", "boat"] })).body;
  const g2 = (await j("POST", "/api/games", { template: "drag", name: "Ikinci Oyun", set: set2.id })).body;
  await j("PATCH", `/api/games/${g2.id}`, { status: "live" });
  await j("POST", "/api/releases", { note: "iki oyun", channels: ["test"] });
  const all = (await j("GET", "/api/games")).body.map((g: { id: string }) => g.id);
  const live = all.filter((id: string) => id === g2.id || id.startsWith("menudeki"));
  await j("PUT", "/api/games/order", { ids: [...live.reverse(), ...all.filter((x: string) => !live.includes(x))] });
  const d3 = (await j("GET", "/api/releases/draft")).body;
  ok("yalnız sıra değişimi: fark var", d3.diff.test.changed.includes("sıra: oyunlar"), d3.diff.test.changed.join());
  const drafted = (await buildDraft()).manifest;
  const same = diff(drafted, { ...drafted, createdAt: 1 });
  ok("createdAt sahte fark üretmez", !same.added.length && !same.changed.length && !same.removed.length);
  await j("POST", "/api/releases", { note: "sıra", channels: ["test"] });
}

/* ── A03: what is published is what was shown ────────────────────────────── */
section("A03 · gösterilen taslak ile yayınlanan aynı");
{
  const d = (await j("GET", "/api/releases/draft")).body;
  await j("PATCH", "/api/words/kite", { tr: "uçurtma!" });
  const p = await j("POST", "/api/releases", { note: "x", channels: ["test"], expect: d.fingerprint });
  ok("taslak arada değiştiyse 409 DRAFT_CHANGED", p.status === 409 && p.body.code === "DRAFT_CHANGED");
  const d2 = (await j("GET", "/api/releases/draft")).body;
  const p2 = await j("POST", "/api/releases", { note: "x", channels: ["test"], expect: d2.fingerprint });
  ok("aynı parmak iziyle yayın geçer", p2.status === 201);
}

/* ── A08: a recording made from an older text does not travel ────────────── */
section("A08 · eski metinden kayıt yayına girmez");
{
  const a = await upload(mp3(1), "kite-tr.mp3", "audio/mpeg");
  await j("PUT", "/api/words/kite/audio/tr", { asset: a.id, text: "Türkçesi, uçurtma!." });
  let d = (await j("GET", "/api/releases/draft")).body;
  ok("doğru metinle kayıt yayında", d.manifest.clips["teacher/tr_kite"] === a.id);
  await j("PATCH", "/api/words/kite", { tr: "uçurtma" });
  d = (await j("GET", "/api/releases/draft")).body;
  ok("metin değişince kayıt yayından çıkar", !d.manifest.clips["teacher/tr_kite"]);
  ok("ve taslakta görünür", d.issues.some((i: { kind: string; item: string }) => i.kind === "clip" && i.item === "teacher/tr_kite"));
  await j("PUT", "/api/words/kite/audio/tr", { asset: a.id, text: "Türkçesi,   uçurtma." });
  d = (await j("GET", "/api/releases/draft")).body;
  ok("yeni metin için açıkça onaylanınca (boşluk farkı sayılmaz) geri girer", d.manifest.clips["teacher/tr_kite"] === a.id);
  const b = await upload(mp3(2), "kite-call.mp3", "audio/mpeg");
  await j("PUT", "/api/words/kite/audio/call", { asset: b.id, text: "" });
  d = (await j("GET", "/api/releases/draft")).body;
  ok("sözsüz efekt (call) metin istemez", d.manifest.clips["animal/kite"] === b.id);
}

/* ── S07 / A09: the studio document ──────────────────────────────────────── */
section("S07/A09 · stüdyo belgesi şeması ve klip sahipliği");
let rev = 0;
{
  const empty = await j("GET", "/api/db");
  rev = empty.status === 200 ? empty.body.rev : 0;
  const good = { version: 1, voices: [], lines: [{ clip: "teacher/hello_x", speaker: "teacher", text: "Merhaba", group: "G" }],
                 takes: [], directions: {}, seed: 1, gens: [] };
  const r1 = await j("PUT", "/api/db", { rev, db: good });
  ok("geçerli belge kaydedilir", r1.status === 200);
  rev = r1.body.rev;
  const r2 = await j("PUT", "/api/db", { rev, db: { version: 1, lines: {} } });
  ok("bozuk belge 400", r2.status === 400 && r2.body.code === "BAD_DOCUMENT");
  const draft = await j("GET", "/api/releases/draft");
  ok("eski belge yerinde, taslak kurulabiliyor", draft.status === 200 && (await j("GET", "/api/db")).body.rev === rev);
  const r3 = await j("PUT", "/api/db", { rev: rev - 1, db: good });
  ok("eski rev hâlâ 409", r3.status === 409);
  const dup = await j("PUT", "/api/db", { rev, db: { ...good, lines: [...good.lines, ...good.lines] } });
  ok("aynı klip iki kez 400", dup.status === 400);
  const clash = await j("PUT", "/api/db", { rev, db: { ...good, lines: [{ clip: "teacher/en_apple", speaker: "teacher", text: "x", group: "G" }] } });
  ok("kelimenin klip kimliği sabit satıra verilemez", clash.status === 400 && /kelimenin/.test(clash.body.error));
  const bogus = await j("PUT", "/api/db", { rev, db: { ...good, lines: [{ ...good.lines[0], approved: icon1.id }] } });
  ok("onaylı kayıt bir resim olamaz", bogus.status === 400);
  const future = await j("PUT", "/api/db", { rev, db: { ...good, someFutureField: { a: 1 } } });
  ok("bilinmeyen alan saklanır (ileri uyumluluk)", future.status === 200 && (await j("GET", "/api/db")).body.db.someFutureField?.a === 1);
  rev = future.body.rev;
  const w = await j("POST", "/api/words", { id: "hello_x", en: "hello", tr: "merhaba" });
  ok("sonradan aynı kimlikli kelime: klibi sabit satırdaysa 409", w.status === 201 || w.status === 409);
  const line2 = { clip: "teacher/en_ship", speaker: "teacher", text: "x", group: "G" };
  await j("PUT", "/api/db", { rev, db: { ...good, lines: [line2] } }).then((r) => { rev = r.body.rev ?? rev; });
  const ship = await j("POST", "/api/words", { id: "ship", en: "ship", tr: "gemi" });
  ok("sabit satırın kimliğini alacak kelime 409 CLIP_TAKEN", ship.status === 409 && ship.body.code === "CLIP_TAKEN");
}

/* ── S06: a file in use is not deleted ───────────────────────────────────── */
section("S06 · kullanılan dosya silinmez");
{
  const r1 = await j("DELETE", `/api/assets/${icon2.id}`);
  ok("kelime resmi: 409 ASSET_IN_USE, kullanım listesiyle", r1.status === 409 && r1.body.code === "ASSET_IN_USE" && r1.body.usage.length > 0);
  const cardAsset = await upload(png(3), "card.png", "image/png");
  await j("PATCH", `/api/categories/${catId}`, { icon: cardAsset.id });
  const r2 = await j("DELETE", `/api/assets/${cardAsset.id}`);
  ok("kategori kartı (görsel stüdyosunun bilmediği kullanım) korunur", r2.status === 409);
  const vid = await upload(Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(40)]), "v.mp4", "video/mp4");
  const steps = (await j("GET", `/api/categories/${catId}`)).body.steps;
  await j("PATCH", `/api/categories/${catId}`, { steps: [{ id: "v1", kind: "video", video: vid.id, note: "" }, ...steps] });
  ok("kategori videosu korunur", (await j("DELETE", `/api/assets/${vid.id}`)).status === 409);
  const take = await upload(mp3(7), "take.mp3", "audio/mpeg");
  const cur = await j("GET", "/api/db");
  const doc = { ...cur.body.db, takes: [{ id: "t1", clip: "teacher/hello_x", asset: take.id, text: "Merhaba", source: "upload", createdAt: 1 }] };
  rev = (await j("PUT", "/api/db", { rev: cur.body.rev, db: doc })).body.rev;
  const r3 = await j("DELETE", `/api/assets/${take.id}`);
  ok("yalnız arşivde (deneme): açık izin olmadan 409 ASSET_ARCHIVED", r3.status === 409 && r3.body.code === "ASSET_ARCHIVED");
  const r4 = await j("DELETE", `/api/assets/${take.id}?archive=drop`);
  ok("arşiv kaydı silinirken açık izinle silinir", r4.status === 200);
  const approved = await upload(mp3(8), "ok.mp3", "audio/mpeg");
  const cur2 = await j("GET", "/api/db");
  const doc2 = { ...cur2.body.db, lines: cur2.body.db.lines.map((l: object) => ({ ...l, approved: approved.id })) };
  await j("PUT", "/api/db", { rev: cur2.body.rev, db: doc2 });
  ok("onaylı ses ?archive=drop ile bile silinmez", (await j("DELETE", `/api/assets/${approved.id}?archive=drop`)).status === 409);
  const usage = await j("GET", "/api/assets/usage");
  ok("tek kullanım sorgusu bütün dosyalar için", usage.status === 200 && Array.isArray(usage.body[icon2.id]));
}

/* ── S05: the collector and uploads ──────────────────────────────────────── */
section("S05 · GC ile eşzamanlı yükleme, aynı bayt, yayın, iki GC");
{
  const old = Date.now() / 1000 - 3600 * 24;
  /* unnamed old bytes that a new upload is about to name again */
  const bytes = png(42);
  const pre = await files.putBlob(bytes, "png");
  utimesSync(files.blobPath(pre.sha, "png"), old, old);
  const [g1, saved, g2] = await Promise.all([files.gc(), files.saveAsset("race-1", "png", bytes, "race.png"), files.gc()]);
  ok("aynı baytı adlandıran yükleme ile GC: blob yerinde", existsSync(files.blobPath(saved.sha256, "png")) && !!(await files.getAsset("race-1")),
     `gc: ${g1.removed}+${g2.removed}`);
  /* many uploads racing many collectors */
  const ups = Array.from({ length: 12 }, (_, i) => files.saveAsset(`race-many-${i}`, "png", png(100 + i), "r.png"));
  const gcs = Array.from({ length: 4 }, () => files.gc());
  await Promise.all([...ups, ...gcs]);
  const missing = (await Promise.all(Array.from({ length: 12 }, (_, i) => files.getAsset(`race-many-${i}`)))).map((a) => a!)
    .filter((a) => !existsSync(files.blobPath(a.sha256, a.ext)));
  ok("12 yükleme × 4 GC: kayıtlı hiçbir dosya silinmedi", missing.length === 0);
  /* bytes only an old release names */
  const before = readdirSync(path.join(data, "blobs")).filter((f) => !f.startsWith(".")).length;
  await files.gc(Date.now() + 3600_000 * 48);
  const released = (await j("GET", "/api/app/manifest?build=1&schema=1&channel=test")).body;
  const releasedMissing = Object.values(released.assets as Record<string, { sha256: string; ext: string }>)
    .filter((a) => !existsSync(files.blobPath(a.sha256, a.ext)));
  ok("yayının dosyaları GC'den sonra yerinde", releasedMissing.length === 0, `${before} blob`);
  /* dead and live uploads */
  const dead = path.join(data, "blobs", ".incoming-dead");
  const fresh = path.join(data, "blobs", ".incoming-fresh");
  writeFileSync(dead, "x"); writeFileSync(fresh, "x");
  utimesSync(dead, old, old);
  await files.gc();
  ok("yarım kalmış eski yükleme temizlenir, süren yükleme kalır", !existsSync(dead) && existsSync(fresh));
}

/* ── S08 / S09: paid jobs with a fake provider ───────────────────────────── */
section("S08/S09 · ücretli işler (sahte sağlayıcı)");
{
  await j("PUT", "/api/settings/keys", { name: "gemini", value: "fake-gemini" });
  await j("PUT", "/api/settings/keys", { name: "elevenlabs", value: "fake-eleven" });
  const realFetch = globalThis.fetch;
  let calls = 0;
  const gem = (fails: number, mime = "image/png") => (async () => {
    calls++;
    if (calls === fails) return new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 });
    const bytes = mime === "image/jpeg" ? Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, calls)]) : png(calls);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: bytes.toString("base64"), mimeType: mime } }] } }] }),
                        { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const body = { provider: "gemini", model: "m", kind: "icon", prompt: "kite", n: 4, quality: "low", refs: [], name: "kite", jobId: "job-partial-0001" };
  globalThis.fetch = gem(3);
  const r1 = await j("POST", "/api/ai/images", body);
  ok("n=4, 3. çağrı hata: 2 sonuç saklı, iş 'partial'", r1.status === 200 && r1.body.status === "partial" && r1.body.assets.length === 2, `çağrı ${calls}`);
  const before = calls;
  const r2 = await j("POST", "/api/ai/images", body);
  ok("aynı iş kimliği: sağlayıcı yeniden çağrılmaz, saklanan döner", calls === before && r2.body.assets.length === 2);
  const r3 = await j("GET", "/api/ai/jobs/job-partial-0001");
  ok("iş durumu yeniden okunabilir", r3.status === 200 && r3.body.status === "partial");
  calls = 0;
  globalThis.fetch = gem(99, "image/jpeg");
  const r4 = await j("POST", "/api/ai/images", { ...body, n: 1, jobId: "job-jpeg-00001" });
  ok("JPEG dönerse uzantı/tür jpg", r4.body.assets?.[0]?.mime === "image/jpeg" && /\.jpg$/.test(r4.body.assets[0].name));
  globalThis.fetch = (async (_u: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => {
    init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("timeout"), { name: "TimeoutError" })));
  })) as typeof fetch;
  const lim = ai.LIMIT_MS.image;
  ai.LIMIT_MS.image = 60;
  const r5 = await j("POST", "/api/ai/images", { ...body, jobId: "job-timeout-001" });
  ai.LIMIT_MS.image = lim;
  ok("cevap vermeyen sağlayıcı süre sınırında biter (504 PROVIDER_TIMEOUT)", r5.status === 504 && r5.body.code === "PROVIDER_TIMEOUT");
  globalThis.fetch = (async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "hayır" }] } }] }), { status: 200 })) as typeof fetch;
  const r6 = await j("POST", "/api/ai/images", { ...body, n: 1, jobId: "job-empty-0001" });
  ok("boş görsel: hata, iş failed", r6.status === 502 && r6.body.job?.status === "failed");
  globalThis.fetch = (async () => new Response(JSON.stringify({ detail: { message: "invalid key" } }), { status: 401 })) as typeof fetch;
  const r7 = await j("GET", "/api/ai/eleven/voices");
  ok("sağlayıcının 401'i panel oturumu değildir: 502 PROVIDER_AUTH_FAILED", r7.status === 502 && r7.body.code === "PROVIDER_AUTH_FAILED");
  let ttsCalls = 0;
  globalThis.fetch = (async () => { ttsCalls++; return new Response(mp3(5), { status: 200, headers: { "content-type": "audio/mpeg" } }); }) as typeof fetch;
  const tts = { voiceId: "v", text: "hi", model_id: "m", voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true, speed: 1 },
                name: "hi", jobId: "job-tts-000001" };
  const t1 = await j("POST", "/api/ai/eleven/tts", tts);
  const t2 = await j("POST", "/api/ai/eleven/tts", tts);
  ok("TTS aynı iş kimliğiyle ikinci kez ücretli çağrı yapmaz", t1.status === 200 && t2.body.id === t1.body.id && ttsCalls === 1);
  globalThis.fetch = realFetch;
}

/* ── S10: no full credential in a URL or a log ───────────────────────────── */
section("S10 · tam yetkili anahtar URL'de ve günlükte yok");
{
  const raw = await app.inject({ method: "GET", url: `/api/assets/${icon1.id}?k=TEST_ADMIN_TOKEN_123` });
  ok("?k=<admin> artık kabul edilmez", raw.statusCode === 401 && JSON.parse(raw.body).code === "ADMIN_UNAUTHORIZED");
  const mt = (await j("GET", "/api/auth/media")).body;
  const m1 = await app.inject({ method: "GET", url: `/api/assets/${icon1.id}?m=${mt.token}` });
  ok("medya belirteci dosyayı okutur", m1.statusCode === 200);
  const m2 = await app.inject({ method: "GET", url: `/api/words?m=${mt.token}` });
  ok("medya belirteci başka uçta geçmez", m2.statusCode === 401);
  const m3 = await app.inject({ method: "DELETE", url: `/api/assets/${icon1.id}?m=${mt.token}` });
  ok("medya belirteci silemez", m3.statusCode === 401);
  const joined = logs.join("\n");
  ok("günlükte admin anahtarı yok", !joined.includes("TEST_ADMIN_TOKEN_123"));
  ok("günlükte medya belirteci yok", !joined.includes(mt.token.split(".")[1]));
  const m4 = await app.inject({ method: "GET", url: `/api/assets/${icon1.id}?m=${mt.token}&m=${mt.token}` });
  ok("aynı belirteç iki kez: 500 değil, giriş istenir", m4.statusCode === 401);
  ok("redaksiyon işlevi", redactUrl("/a?x=1&k=SECRET&m=T") === "/a?x=1&k=[gizli]&m=[gizli]");
  const sv = await app.inject({ method: "GET", url: `/api/assets/${icon1.id}`, headers: AUTH });
  ok("dosyalar sandbox CSP ve nosniff ile sunulur", String(sv.headers["content-security-policy"]).includes("sandbox")
     && sv.headers["x-content-type-options"] === "nosniff");
  const tag = String(sv.headers.etag);
  const sv2 = await app.inject({ method: "GET", url: `/api/assets/${icon1.id}`, headers: { ...AUTH, "if-none-match": tag } });
  ok("dosya önbelleği her seferinde doğrulanır (no-cache + ETag → 304)", String(sv.headers["cache-control"]).includes("no-cache") && sv2.statusCode === 304);
  ok("adres baytı da adlandırır (?v=sha)", /\?v=[a-f0-9]{12}$/.test(icon1.url));
}

/* ── S11 / S12: the inventory ────────────────────────────────────────────── */
section("S11/S12 · envanter: aynı sürüm değişmez, panelin içeriği ele geçirilmez");
{
  const inv = JSON.parse(readFileSync(path.join(appDir, "app-inventory.json"), "utf8"));
  const changed = { ...inv, templates: inv.templates.map((t: { id: string; open: boolean }) => (t.id === "train" ? { ...t, open: true } : t)) };
  const r1 = await j("PUT", "/api/inventory", changed);
  ok("aynı sürüme farklı envanter: 409 BUILD_IMMUTABLE", r1.status === 409 && r1.body.code === "BUILD_IMMUTABLE");
  const r2 = await j("PUT", "/api/inventory", inv);
  ok("aynısı tekrar: kabul (idempotent)", r2.status === 200);
  const m1 = await app.inject({ method: "GET", url: "/api/app/manifest?build=1&schema=1&channel=test" });
  ok("ETag envanter parmak izini içerir", /^"r\d+-b1-[a-f0-9]{12}"$/.test(String(m1.headers.etag)), String(m1.headers.etag));
  /* the app's next build brings words, a set, a game and a category whose ids the panel already used */
  const next = { ...inv, app: { ...inv.app, build: 2 },
    words: [...inv.words, { id: "kite", en: "kite", tr: "UÇURTMA-APP", about: "", aboutParts: [], kind: "thing", color: "#000000", icon: null }],
    sets: [...inv.sets, { id: "gokyuzu", name: "App seti", words: ["kite"] }],
    templates: [...inv.templates, { ...inv.templates.find((t: { id: string }) => t.id === "drag"), id: "menudeki-ver", name: "App oyunu" }],
    categories: [...inv.categories, { ...inv.categories[0], id: catId, title: "App kategorisi" }] };
  const r3 = await j("PUT", "/api/inventory", next);
  const kite = (await j("GET", "/api/words/kite")).body;
  const conf = (await j("GET", "/api/inventory/conflicts")).body;
  ok("çakışan panel kelimesi korunur (builtin olmaz, metni aynı)", r3.status === 200 && kite.builtin === false && kite.tr !== "UÇURTMA-APP");
  ok("set, oyun ve kategori de korunur", (await j("GET", "/api/sets/gokyuzu")).body.builtin === false
     && (await j("GET", "/api/games/menudeki-ver")).body.builtin === false
     && (await j("GET", `/api/categories/${catId}`)).body.builtin === false);
  ok("çakışmalar raporlanır", conf.items.length === 4, conf.items.map((c: { kind: string; id: string }) => `${c.kind}:${c.id}`).join());
  const r4 = await j("PUT", "/api/inventory", next);
  ok("tekrar içe alma aynı sonuç (idempotent)", r4.status === 200 && (await j("GET", "/api/inventory/conflicts")).body.items.length === 4);
  void importInventory;
}

/* ── decisions of 2026-10-16 ─────────────────────────────────────────────── */
section("K1 · yeni yayınlarda MD5 zorunlu");
{
  const d = (await j("GET", "/api/releases/draft")).body;
  ok("manifest bütünlük türünü söyler (integrity: md5)", d.manifest.integrity === "md5");
  ok("her dosyanın MD5'i var", Object.values(d.manifest.assets as Record<string, { md5?: string }>).every((a) => /^[a-f0-9]{32}$/.test(a.md5 ?? "")));
}
section("K2 · 'Bul bakalım' yalnız tanıtılmış kelimelerle");
{
  const set = (await j("POST", "/api/sets", { name: "Tanitim", words: ["kite", "boat", "apple"] })).body;
  const pop = (await j("POST", "/api/games", { template: "pop", name: "Tek Basina Bul", set: set.id })).body;
  ok("tanıtmayan motordan yapılan oyun tek başına yayınlanamaz", pop.issues.some((i: { level: string; text: string }) => i.level === "error" && /tek başına/.test(i.text)));
  const cat = (await j("POST", "/api/categories", { title: "Tanitimsiz", set: set.id })).body;
  const only = await j("PATCH", `/api/categories/${cat.id}`, { steps: [{ id: "g", kind: "game", game: "pop", teach: false }, { id: "z", kind: "finish" }] });
  ok("kategoride önce tanıtan adım yoksa hata", only.body.issues.some((i: { level: string; text: string }) => i.level === "error" && /tanıtılmalı/.test(i.text)));
  const notTaught = await j("PATCH", `/api/categories/${cat.id}`, { steps: [{ id: "a", kind: "game", game: "drag", teach: false },
    { id: "g", kind: "game", game: "pop", teach: false }, { id: "z", kind: "finish" }] });
  ok("öncesinde tanıtmayan drag (teach:false) da yetmez", notTaught.body.issues.some((i: { level: string; step?: string }) => i.level === "error" && i.step === "g"));
  const taught = await j("PATCH", `/api/categories/${cat.id}`, { steps: [{ id: "a", kind: "game", game: "drag", teach: true },
    { id: "g", kind: "game", game: "pop", teach: false }, { id: "z", kind: "finish" }] });
  ok("önce kartla tanıtan drag varsa geçer", !taught.body.issues.some((i: { level: string; step?: string }) => i.level === "error" && i.step === "g"));
}
section("K3 · ücretli iş: belirsiz durum, liste");
{
  const job = await j("GET", "/api/ai/jobs/job-timeout-001");
  ok("süre aşımındaki iş 'belirsiz' (ücret bilinmiyor)", job.body.status === "uncertain", job.body.status);
  const again = await j("POST", "/api/ai/images", { provider: "gemini", model: "m", kind: "icon", prompt: "x", n: 1, quality: "low", refs: [], name: "x", jobId: "job-timeout-001" });
  ok("belirsiz iş aynı kimlikle otomatik tekrar gönderilmez (409 JOB_UNCERTAIN)", again.status === 409 && again.body.code === "JOB_UNCERTAIN");
  const list = await j("GET", "/api/ai/jobs");
  ok("iş geçmişi listelenir", list.status === 200 && list.body.some((x: { id: string }) => x.id === "job-partial-0001"));
  const { openJob, markInterruptedJobs } = await import("../src/modules/jobs.js");
  await openJob("job-yarida-0001", "tts", {});
  ok("sunucu durduğunda süren iş açılışta 'belirsiz' olur", (await markInterruptedJobs()) >= 1 && (await j("GET", "/api/ai/jobs/job-yarida-0001")).body.status === "uncertain");
}
section("K4/K7 · tek süreç, yedek sırasında GC, sağlık ucu");
{
  const { holdDataFolder, FolderInUse } = await import("../src/storage/lock.js");
  const lockDir = mkdtempSync(path.join(tmpdir(), "loplop-kilit-"));
  writeFileSync(path.join(lockDir, "server.lock"), JSON.stringify({ pid: process.ppid, host: (await import("node:os")).hostname(), startedAt: "x" }));
  let refused = false;
  try { holdDataFolder(lockDir); } catch (e) { refused = e instanceof FolderInUse; }
  ok("başka bir canlı süreç tutuyorsa ikinci süreç açılmaz", refused);
  writeFileSync(path.join(lockDir, "server.lock"), JSON.stringify({ pid: 999999, host: (await import("node:os")).hostname(), startedAt: "x" }));
  const release = holdDataFolder(lockDir);
  ok("çökmüş sürecin kilidi devralınır", JSON.parse(readFileSync(path.join(lockDir, "server.lock"), "utf8")).pid === process.pid);
  release();
  const orphan = await files.putBlob(png(77), "png");
  const old = Date.now() / 1000 - 86400;
  utimesSync(files.blobPath(orphan.sha, "png"), old, old);
  writeFileSync(files.GC_HOLD(), String(Date.now() + 60_000));
  const held = await files.gc();
  ok("yedek alınırken GC hiçbir şey silmez", held.held === true && existsSync(files.blobPath(orphan.sha, "png")));
  writeFileSync(files.GC_HOLD(), String(Date.now() - 1));
  await files.gc();
  ok("tutma süresi geçince eski artık silinir", !existsSync(files.blobPath(orphan.sha, "png")));
  const pub = await app.inject({ method: "GET", url: "/api/health" });
  const body = JSON.parse(pub.body);
  ok("anahtarsız sağlık ucu yalnız durum söyler", body.ok !== undefined && body.dataDir === undefined && body.keys === undefined);
  const full = await j("GET", "/api/health");
  ok("anahtarla ayrıntı ve disk", !!full.body.dataDir && typeof full.body.disk?.free === "number");
}
section("K8 · SVG reddi ve gerçek dosya türü");
{
  const svg = await upload(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "x.svg", "image/svg+xml");
  ok("SVG yüklenemez (415)", svg.status === 415 && svg.code === "FILE_TYPE");
  const disguised = await upload(Buffer.from('<?xml version="1.0"?><svg/>'), "x.png", "image/png");
  ok("PNG adı ve türüyle gönderilen SVG de reddedilir", disguised.status === 415);
  const liar = await upload(png(5), "ses.mp3", "audio/mpeg");
  ok("içi resim olan 'ses' reddedilir", liar.status === 415);
  const renamed = await upload(png(6), "resim.jpg", "image/jpeg");
  ok("yanlış uzantılı gerçek PNG, PNG olarak saklanır", renamed.status === 200 && renamed.mime === "image/png");
  const junk = await upload(Buffer.from("merhaba dunya bu bir resim degil"), "x.png", "image/png");
  ok("tanınmayan içerik reddedilir", junk.status === 415);
}

section("Ses atölyesi · diller, telaffuz, tasarım");
{
  const realFetch = globalThis.fetch;
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const reply = (url: string) => {
    if (url.includes("/v1/models")) return new Response(JSON.stringify([
      { model_id: "eleven_v4", name: "v4", can_do_text_to_speech: true, languages: [{ language_id: "it", name: "Italian" }] },
      { model_id: "eleven_english_sts_v2", name: "sts", can_do_text_to_speech: false }]), { status: 200 });
    if (url.includes("/text-to-voice/design")) return new Response(JSON.stringify({ previews: [1, 2, 3].map((n) => ({
      audio_base_64: mp3(20 + n).toString("base64"), generated_voice_id: `gen${n}`, media_type: "audio/mpeg" })) }), { status: 200 });
    if (url.endsWith("/v1/text-to-voice")) return new Response(JSON.stringify({ voice_id: "saved-voice", name: "Lili" }), { status: 200 });
    if (url.includes("/pronunciation-dictionaries/add-from-rules")) return new Response(JSON.stringify({ id: "dict1", version_id: "ver1" }), { status: 200 });
    return new Response(mp3(30), { status: 200, headers: { "content-type": "audio/mpeg" } });
  };
  globalThis.fetch = (async (u: string, init?: RequestInit) => {
    sent.push({ url: String(u), body: init?.body ? JSON.parse(String(init.body)) : {} });
    return reply(String(u));
  }) as typeof fetch;

  const m = await j("GET", "/api/ai/eleven/models");
  ok("model listesi yalnız konuşabilenler, dilleriyle", m.status === 200 && m.body.length === 1 && m.body[0].languages[0] === "it");

  const loc = [{ pronunciation_dictionary_id: "dict1", version_id: "ver1" }];
  const t = await j("POST", "/api/ai/eleven/tts", { voiceId: "v", text: "Dov'è la cup?", model_id: "eleven_flash_v2", language_code: "it",
    voice_settings: { stability: 0.5, similarity_boost: 0.8, style: 0.3, use_speaker_boost: true, speed: 1 },
    pronunciation_dictionary_locators: loc, name: "it_ask", jobId: "job-pron-0001" });
  const tb = sent.at(-1)!.body;
  ok("telaffuz sözlüğü ve dil ElevenLabs'e gider", t.status === 200 && JSON.stringify(tb.pronunciation_dictionary_locators) === JSON.stringify(loc) && tb.language_code === "it");

  const p = await j("POST", "/api/ai/eleven/pronunciation", { name: "loplop", rules: [{ word: "cup", ipa: "/kʌp/" }, { word: "milk", ipa: "mɪlk" }] });
  const rules = sent.at(-1)!.body.rules as { type: string; phoneme: string; alphabet: string; string_to_replace: string }[];
  ok("sözlük: IPA fonem kuralları, eğik çizgiler atılır", p.status === 200 && p.body.id === "dict1"
     && rules[0]!.type === "phoneme" && rules[0]!.phoneme === "kʌp" && rules[0]!.alphabet === "ipa" && rules.length === 2);

  const before = sent.length;
  const d1 = await j("POST", "/api/ai/eleven/design", { description: "Sıcak, neşeli bir çizgi film tavşanı sesi; yumuşak ve meraklı.", jobId: "job-design-001" });
  ok("tasarım: üç örnek saklanır, her birinin ses kimliği okunur", d1.status === 200 && d1.body.previews.length === 3
     && d1.body.previews.map((x: { generatedVoiceId: string }) => x.generatedVoiceId).join() === "gen1,gen2,gen3");
  const d2 = await j("POST", "/api/ai/eleven/design", { description: "Sıcak, neşeli bir çizgi film tavşanı sesi; yumuşak ve meraklı.", jobId: "job-design-001" });
  ok("aynı tasarım işi ikinci kez ücretli çağrı yapmaz", sent.length === before + 1 && d2.body.previews.length === 3);
  const short = await j("POST", "/api/ai/eleven/design", { description: "kısa" });
  ok("20 karakterden kısa tarif reddedilir", short.status === 400);
  const sv = await j("POST", "/api/ai/eleven/design-save", { name: "Lili", description: "Sıcak, neşeli bir çizgi film tavşanı sesi.", generatedVoiceId: "gen2" });
  ok("seçilen örnek hesaba kaydedilir", sv.status === 200 && sv.body.voice_id === "saved-voice" && sent.at(-1)!.body.generated_voice_id === "gen2");
  globalThis.fetch = (async () => new Response(JSON.stringify({ detail: { status: "blocked", message: "Sorry, this prompt potentially doesn't follow our safety guidelines and therefore has been blocked." } }), { status: 403 })) as typeof fetch;
  const blocked = await j("POST", "/api/ai/eleven/design", { description: "A childlike cartoon voice, very playful and sweet indeed.", jobId: "job-design-blocked" });
  ok("içerik engeli anahtar hatası sayılmaz: 422 PROVIDER_BLOCKED, iş başarısız (ücretsiz)",
     blocked.status === 422 && blocked.body.code === "PROVIDER_BLOCKED" && blocked.body.job?.status === "failed" && !/anahtarı reddetti/.test(blocked.body.error));
  globalThis.fetch = (async () => new Response(JSON.stringify({ detail: { message: "invalid api key" } }), { status: 401 })) as typeof fetch;
  const auth = await j("POST", "/api/ai/eleven/design", { description: "A warm friendly voice for a cartoon rabbit character.", jobId: "job-design-auth01" });
  ok("gerçek anahtar hatası hâlâ PROVIDER_AUTH_FAILED", auth.status === 502 && auth.body.code === "PROVIDER_AUTH_FAILED");
  globalThis.fetch = realFetch;

  /* the studio document: languages, translations, takes per language, workshop */
  const cur = await j("GET", "/api/db");
  const base = cur.body.db;
  const itTake = await upload(mp3(41), "it.mp3", "audio/mpeg");
  const ws = await upload(mp3(42), "ws.mp3", "audio/mpeg");
  const doc = { ...base, languages: [{ code: "it", name: "İtalyanca", meaningTemplate: "In italiano, %." }],
    i18n: { it: { words: { apple: { meaning: "mela", about: "La mela è rossa." } }, lines: { "teacher/hello_x": "Ciao" } } },
    localeApproved: { it: { "teacher/tr_apple": { asset: itTake.id, text: "In italiano, mela." } } },
    pron: { cup: { ipa: "kʌp" } },
    workshop: [{ id: "w1", name: "deneme_1", text: "Merhaba", tag: "[excited]", lang: "tr", voiceId: "v", model: "eleven_v3", asset: ws.id, createdAt: 1 }] };
  const ok1 = await j("PUT", "/api/db", { rev: cur.body.rev, db: doc });
  ok("diller, çeviriler, dil başına onaylı kayıt ve atölye kaydı saklanır", ok1.status === 200);
  const r = ok1.body.rev;
  const trLang = await j("PUT", "/api/db", { rev: r, db: { ...doc, languages: [{ code: "tr", name: "Türkçe", meaningTemplate: "%" }] } });
  ok("Türkçe ayrıca dil olarak eklenmez", trLang.status === 400);
  const noPct = await j("PUT", "/api/db", { rev: r, db: { ...doc, languages: [{ code: "de", name: "Almanca", meaningTemplate: "Auf Deutsch" }] } });
  ok("anlam şablonunda % zorunlu", noPct.status === 400);
  const pic = await j("PUT", "/api/db", { rev: r, db: { ...doc, localeApproved: { it: { "teacher/tr_apple": { asset: icon1.id, text: "x" } } } } });
  ok("başka dilde onaylı kayıt bir resim olamaz", pic.status === 400);
  const inUse = await j("DELETE", `/api/assets/${itTake.id}`);
  ok("başka dildeki onaylı kayıt silinmez (kullanımda)", inUse.status === 409 && inUse.body.code === "ASSET_IN_USE");
  const arch = await j("DELETE", `/api/assets/${ws.id}`);
  ok("atölye kaydı arşivdir: açık izinsiz silinmez", arch.status === 409 && arch.body.code === "ASSET_ARCHIVED");
}

/* ── Müzik: the song of a music stop, lyrics by AI, Suno's slot ─────────── */
section("Müzik · şarkı, sözler (Claude / ChatGPT / Gemini), Suno, lisans, yayın");
{
  const realFetch = globalThis.fetch;
  for (const n of ["anthropic", "openai", "gemini"]) await j("PUT", "/api/settings/keys", { name: n, value: `fake-${n}` });
  const v = await j("GET", "/api/songs");
  const kitchen = v.body.stops.find((x: { id: string }) => x.id === "kitchen-music");
  ok("uygulamanın altı müzik durağı, kelimeleriyle", v.body.stops.filter((x: { kind: string }) => x.kind === "app").length === 6
     && kitchen?.words.includes("banana"), JSON.stringify(kitchen)?.slice(0, 120));
  const made = await j("POST", "/api/songs", { title: "Mutfak şarkısı", stop: "kitchen-music" });
  ok("şarkı oluşur; konusu durağın kelimeleriyle başlar, taslak", made.status === 201 && made.body.brief.words.includes("apple")
     && made.body.status === "draft" && made.body.issues.some((i: { level: string }) => i.level === "error"));
  const sid = made.body.id;
  const answer = { title: "Kitchen Song", lyrics: "[Verse 1]\nBanana, banana, yellow and sweet\n[Chorus]\nApple, apple, can you say apple? Apple!", style: "children's pop, 110 bpm, female vocal, ukulele" };
  let seen: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null = null;
  let calls = 0;
  const fake = (shape: (t: string) => unknown) => (async (u: string, init?: RequestInit) => {
    calls++;
    seen = { url: String(u), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: JSON.parse(String(init?.body ?? "{}")) };
    return new Response(JSON.stringify(shape(JSON.stringify(answer))), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const brief = { ...made.body.brief, theme: "piknik", extra: "" };
  globalThis.fetch = fake((t) => ({ content: [{ type: "text", text: "İşte: " + t }] }));
  const l1 = await j("POST", `/api/songs/${sid}/lyrics`, { jobId: "lyrics-claude-01", provider: "anthropic", model: "claude-opus-5-5", brief });
  const s1 = seen as unknown as { url: string; headers: Record<string, string>; body: { model: string; system: string; messages: { content: string }[] } };
  ok("Claude: doğru uç, anahtar ve sürüm başlığı, model; sistem yönergesi 4–8 yaş, kelimeler Türkçeleriyle",
     l1.status === 200 && s1.url === "https://api.anthropic.com/v1/messages" && s1.headers["x-api-key"] === "fake-anthropic"
     && s1.headers["anthropic-version"] === "2023-06-01" && s1.body.model === "claude-opus-5-5" && /4 to 8/.test(s1.body.system)
     && /banana = muz/.test(s1.body.messages[0]!.content) && /piknik/.test(s1.body.messages[0]!.content), JSON.stringify(l1.body).slice(0, 160));
  ok("taslak söz şarkıya kaydedilir (ücretli sonuç kaybolmaz)", l1.body.draft?.lyrics.startsWith("[Verse 1]") && l1.body.job?.status === "done"
     && (await j("GET", "/api/songs")).body.songs.find((x: { id: string }) => x.id === sid).drafts.length === 1);
  const before = calls;
  const again = await j("POST", `/api/songs/${sid}/lyrics`, { jobId: "lyrics-claude-01", provider: "anthropic", model: "claude-opus-5-5", brief });
  ok("aynı iş kimliği: sağlayıcı yeniden çağrılmaz, aynı taslak döner", calls === before && again.body.draft?.jobId === "lyrics-claude-01");
  globalThis.fetch = fake((t) => ({ choices: [{ message: { content: t } }] }));
  const l2 = await j("POST", `/api/songs/${sid}/lyrics`, { jobId: "lyrics-openai-01", provider: "openai", model: "gpt-x", brief });
  const s2 = seen as unknown as { url: string; body: { response_format: { type: string }; messages: { role: string }[] } };
  ok("ChatGPT: sohbet ucu, JSON biçimi, sistem + kullanıcı", l2.status === 200 && s2.url.endsWith("/v1/chat/completions")
     && s2.body.response_format.type === "json_object" && s2.body.messages[0]!.role === "system");
  globalThis.fetch = fake((t) => ({ candidates: [{ content: { parts: [{ text: t }] } }] }));
  const l3 = await j("POST", `/api/songs/${sid}/lyrics`, { jobId: "lyrics-gemini-01", provider: "gemini", model: "gemini-x", brief });
  const s3 = seen as unknown as { url: string; body: { generationConfig: { responseMimeType: string } } };
  ok("Gemini: generateContent, JSON çıktısı", l3.status === 200 && /models\/gemini-x:generateContent/.test(s3.url)
     && s3.body.generationConfig.responseMimeType === "application/json");
  globalThis.fetch = (async () => new Response(JSON.stringify({ content: [{ type: "text", text: "Üzgünüm, yazamam." }] }), { status: 200 })) as typeof fetch;
  const bad = await j("POST", `/api/songs/${sid}/lyrics`, { jobId: "lyrics-bad-0001", provider: "anthropic", model: "m", brief });
  ok("JSON'suz cevap: hata, iş 'failed' (belirsiz değil: cevap geldi)", bad.status === 502 && bad.body.job?.status === "failed");
  globalThis.fetch = (async () => { throw Object.assign(new Error("ağ koptu"), { name: "TypeError" }); }) as typeof fetch;
  const lost = await j("POST", `/api/songs/${sid}/lyrics`, { jobId: "lyrics-lost-0001", provider: "anthropic", model: "m", brief });
  ok("bağlantı koptu: iş 'belirsiz', kendiliğinden yeniden gönderilmez", lost.status === 502 && lost.body.job?.status === "uncertain");
  globalThis.fetch = fake(() => ({ data: [{ id: "claude-opus-5-5" }, { id: "claude-sonnet-5-5" }] }));
  const models = await j("GET", "/api/ai/text-models/anthropic");
  ok("Claude modelleri listelenir", models.body.models?.join() === "claude-opus-5-5,claude-sonnet-5-5");
  globalThis.fetch = realFetch;
  const noKey = await j("POST", `/api/songs/${sid}/suno`, {});
  ok("Suno anahtarı yokken: anahtar eksik", noKey.status === 412 && noKey.body.code === "PROVIDER_KEY_MISSING");
  await j("PUT", "/api/settings/keys", { name: "suno", value: "fake-suno" });
  const suno = await j("POST", `/api/songs/${sid}/suno`, {});
  ok("Suno anahtarıyla: resmi API yok denir (NOT_AVAILABLE), ücret yok", suno.status === 501 && suno.body.code === "NOT_AVAILABLE");

  /* the audio, its license, the stop */
  const take = await files.saveAsset("song-take-1", "mp3", mp3(71), "mutfak.mp3", "audio/mpeg");
  const cur = async () => (await j("GET", "/api/songs")).body.songs.find((x: { id: string }) => x.id === sid);
  const at = Date.now();
  const p1 = await j("PATCH", `/api/songs/${sid}`, { lyrics: answer.lyrics, takes: [{ asset: take.id, source: "suno-web", durationMs: 72_000, note: "", at }],
    chosen: take.id, license: { plan: "free", owner: "ekip@ornek", madeAt: "2026-10-17", confirmed: false, note: "" }, status: "live" });
  ok("ücretsiz Suno planı: uygulamaya konamaz (ticari değil)", p1.status === 400 && JSON.stringify(p1.body).includes("ücretsiz"));
  const p2 = await j("PATCH", `/api/songs/${sid}`, { takes: [{ asset: take.id, source: "suno-web", durationMs: 20_000, note: "", at }], chosen: take.id,
    license: { plan: "pro", owner: "ekip@ornek", madeAt: "2026-10-17", confirmed: false, note: "" }, status: "live" });
  ok("20 sn'lik şarkı: çok kısa, konamaz", p2.status === 400 && JSON.stringify(p2.body).includes("kısa"));
  const p3 = await j("PATCH", `/api/songs/${sid}`, { takes: [{ asset: take.id, source: "upload", durationMs: 72_000, note: "", at }], chosen: take.id,
    license: { plan: "other", owner: "", madeAt: "", confirmed: false, note: "" }, status: "live" });
  ok("yüklenen dosya: hakkı onaylanmadan konamaz", p3.status === 400 && JSON.stringify(p3.body).includes("hakkı"));
  const p4 = await j("PATCH", `/api/songs/${sid}`, { lyrics: answer.lyrics, takes: [{ asset: take.id, source: "suno-web", durationMs: 72_000, note: "", at }], chosen: take.id,
    license: { plan: "pro", owner: "ekip@ornek", madeAt: "2026-10-17", confirmed: false, note: "" }, status: "live" });
  ok("Pro planla, 72 sn: uygulamada; sözlerde geçmeyen kelimeler uyarı", p4.status === 200 && p4.body.status === "live"
     && p4.body.issues.some((i: { text: string }) => /geçmeyen kelimeler/.test(i.text)), JSON.stringify(p4.body.issues ?? p4.body).slice(0, 200));
  const d1 = await buildDraft();
  ok("taslak yayında: mutfağın müzik durağına şarkı", d1.manifest.songs?.list.some((x) => x.stop === "kitchen-music" && x.asset === take.id) === true
     && !!d1.manifest.assets[take.id]);
  const second = await j("POST", "/api/songs", { title: "Mutfak şarkısı 2", stop: "kitchen-music" });
  await j("PATCH", `/api/songs/${second.body.id}`, { takes: [{ asset: take.id, source: "suno-web", durationMs: 70_000, note: "", at }], chosen: take.id,
    license: { plan: "premier", owner: "ekip", madeAt: "2026-10-17", confirmed: false, note: "" }, status: "live" });
  ok("bir durakta tek şarkı: yenisi uygulamaya girince eskisi taslağa döner", (await cur()).status === "draft");
  const del = await j("DELETE", `/api/assets/${take.id}`);
  ok("şarkının dosyası kullanımda: silinmez", del.status === 409);
  await j("DELETE", `/api/songs/${second.body.id}`);
  await j("DELETE", `/api/songs/${sid}`);
  ok("şarkılar silinir; yayında şarkı kalmaz", !(await buildDraft()).manifest.songs);
}

section("Boşluklu cümle · kaydın boşluğu yayına girer (2026-10-23)");
{
  const take = await upload(mp3(21), "frame.mp3", "audio/mpeg");
  const bare = await upload(mp3(22), "frame2.mp3", "audio/mpeg");
  const cur = await j("GET", "/api/db");
  const lines = [...cur.body.db.lines.filter((l: { clip: string }) => !/^teacher\/f_t/.test(l.clip)),
    { clip: "teacher/f_test_mid", speaker: "teacher", text: "Şimdi sırada ___ var.", group: "G", approved: take.id },
    { clip: "teacher/f_test_end", speaker: "teacher", text: "Bak! Bu bir ___", group: "G", approved: bare.id }];
  const takes = [...(cur.body.db.takes ?? []),
    { id: "tf1", clip: "teacher/f_test_mid", asset: take.id, text: "Şimdi sırada ___ var.", source: "eleven", createdAt: 2, cut: [1.1, 1.8] },
    { id: "tf2", clip: "teacher/f_test_end", asset: bare.id, text: "Bak! Bu bir ___", source: "eleven", createdAt: 2 }];
  const bad = await j("PUT", "/api/db", { rev: cur.body.rev, db: { ...cur.body.db, lines,
    takes: takes.map((t) => (t.id === "tf1" ? { ...t, cut: [1.8, 1.1] } : t)) } });
  ok("ters boşluk (sonu başından önce) kaydedilmez", bad.status === 400);
  const put = await j("PUT", "/api/db", { rev: cur.body.rev, db: { ...cur.body.db, lines, takes } });
  ok("boşluğu ölçülmüş kayıt kaydedilir", put.status === 200);
  const d = await j("GET", "/api/releases/draft");
  ok("taslakta kaydın boşluğu: [1.1, 1.8]", JSON.stringify(d.body.manifest.cuts?.["teacher/f_test_mid"]) === "[1.1,1.8]",
     JSON.stringify(d.body.manifest.cuts));
  ok("boşluk cümlenin sonundaysa kesim gerekmez, uyarı yok",
     !d.body.issues.some((i: { item?: string }) => i.item === "teacher/f_test_end"));
  const cur2 = await j("GET", "/api/db");
  await j("PUT", "/api/db", { rev: cur2.body.rev, db: { ...cur2.body.db,
    takes: cur2.body.db.takes.map((t: { id: string }) => (t.id === "tf1" ? { ...t, cut: undefined } : t)) } });
  const d2 = await j("GET", "/api/releases/draft");
  ok("ortası boş cümlenin kaydında boşluk yoksa: uyarı, ve kesim yayına girmez",
     d2.body.issues.some((i: { item?: string; text: string }) => i.item === "teacher/f_test_mid" && /boşluk ölçülmemiş/.test(i.text))
     && !d2.body.manifest.cuts?.["teacher/f_test_mid"]);
  const cur3 = await j("GET", "/api/db");
  await j("PUT", "/api/db", { rev: cur3.body.rev, db: { ...cur3.body.db,
    lines: cur3.body.db.lines.filter((l: { clip: string }) => !/^teacher\/f_test/.test(l.clip)),
    takes: cur3.body.db.takes.filter((t: { id: string }) => t.id !== "tf1" && t.id !== "tf2") } });
}

section("Hesaplar kapalıyken (SUPABASE_URL yok)");
{
  const a = await j("GET", "/api/app/auth", undefined, {});
  ok("uygulama hesapların kapalı olduğunu öğrenir", a.status === 200 && a.body.enabled === false && a.body.url === null);
  const me = await app.inject({ method: "GET", url: "/api/me" });
  ok("/api/me: 401 ACCOUNTS_OFF", me.statusCode === 401 && JSON.parse(me.body).code === "ACCOUNTS_OFF");
  ok("kullanıcı listesi: 503 ACCOUNTS_OFF", (await j("GET", "/api/users")).body?.code === "ACCOUNTS_OFF");
  ok("yöneticiler listesi yine düzenlenebilir", (await j("POST", "/api/admins", { email: "x@ornek.test" })).status === 201
     && (await j("GET", "/api/admins")).body.some((x: { email: string }) => x.email === "x@ornek.test"));
}

await app.close();
await closeDb();
await tdb.drop();
clearInterval(keepAlive);
console.log(fail ? `\nbirim: ${fail} HATA` : "\nbirim: hepsi gecti");
process.exit(fail ? 1 : 0);
