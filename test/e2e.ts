/**
 * The whole flow, end to end, on a server of its own (a fresh data folder,
 * another port): the app's inventory comes in, a word gets a picture and a
 * recording, a set, a game from an open engine, a category, a draft with its
 * checks, a release to `test`, the phone's manifest for its build, the files
 * by hash, a promotion to `production`, a rollback, and the old endpoints.
 *
 *   npm test
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { testDatabase } from "./testdb.js";

const PORT = 8790 + Math.floor(Math.random() * 8);
const B = `http://127.0.0.1:${PORT}`;
const data = mkdtempSync(path.join(tmpdir(), "loplop-e2e-"));
const appDir = path.resolve(process.env.APP_DIR ?? "../loplop");
/* never the real database: an embedded one in the test's own folder, or a
   database of this run's own on TEST_DATABASE_URL's Postgres -- checked
   before the server starts (testdb.ts) */
const tdb = await testDatabase("e2e");
const srv = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
  env: { ...process.env, DATA_DIR: data, PORT: String(PORT), LOG_LEVEL: "error", APP_DIR: appDir,
         DATABASE_URL: tdb.url, NODE_ENV: "test" },
  stdio: ["ignore", "inherit", "inherit"],
});

let fail = 0;
const ok = (what: string, cond: boolean, note = "") => {
  if (!cond) { fail++; console.error(`  HATA  ${what}${note ? "  — " + note : ""}`); }
  else console.log(`  gecti  ${what}${note ? "  (" + note + ")" : ""}`);
};
const j = async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(B + p, { method, headers: body ? { "Content-Type": "application/json", ...headers } : headers,
                                 body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null, headers: r.headers };
};
async function upload(file: string, mime: string) {
  const f = new FormData();
  f.append("file", new Blob([readFileSync(file)], { type: mime }), path.basename(file));
  const r = await fetch(B + "/api/assets", { method: "POST", body: f });
  return (await r.json()) as { id: string; sha256: string };
}

try {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(B + "/api/health")).ok) break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  const h = await j("GET", "/api/health");
  ok("sunucu acildi, uygulama envanteri alindi", h.status === 200 && h.body.app?.build >= 1, JSON.stringify(h.body.app));

  /* the app's own content arrived from its inventory */
  const games = await j("GET", "/api/games");
  ok("hazir oyunlar envanterden geldi (Hareketler dahil)", games.body.some((g: { id: string }) => g.id === "park")
     && games.body.every((g: { builtin: boolean }) => g.builtin));
  const tpl = await j("GET", "/api/games/templates");
  ok("acik motorlar: drag, pop", tpl.body.map((g: { id: string }) => g.id).sort().join() === "drag,pop");
  const cats = await j("GET", "/api/categories");
  ok("hazir kategoriler envanterden: alti seri", cats.body.length === 6 && cats.body.every((c: { builtin: boolean }) => c.builtin));
  const scenes = await j("GET", "/api/categories/scenes");
  ok("sahneler envanterden", scenes.body.some((s: { id: string }) => s.id === "action-park-intro"));
  const bw = await j("PATCH", "/api/words/banana", { tr: "MUZ" });
  ok("uygulamanin kelimesinin metni panelden degismez", bw.status === 400);
  const bc = await j("PATCH", "/api/words/banana", { color: "#000000" });
  ok("uygulamanin kelimesinin rengi/resmi de (telefonda hep uygulamaninki)", bc.status === 400);

  /* a word, its picture and its recording */
  const pic = await upload(path.join(appDir, "src/assets/actions/jump.png"), "image/png");
  const pic2 = await upload(path.join(appDir, "src/assets/actions/jump.png"), "image/png");
  ok("ayni dosya iki kez: iki ad, tek bayt (icerik ozeti)", pic.id !== pic2.id && pic.sha256 === pic2.sha256);
  const snd = await upload(path.join(appDir, "src/assets/sfx/camera-shutter.mp3"), "audio/mpeg");
  for (const [id, en, tr] of [["fish", "fish", "balık"], ["bird", "bird", "kuş"], ["turtle", "turtle", "kaplumbağa"]]) {
    const r = await j("POST", "/api/words", { id, en, tr, about: `${tr} çok sevimlidir.`, icon: pic.id, color: "#2A84C8" });
    ok(`kelime: ${id}`, r.status === 201, String(r.status));
  }
  const dup = await j("POST", "/api/words", { id: "fish", en: "fish", tr: "balık" });
  ok("ayni kimlikle ikinci kelime yok", dup.status === 409);
  const rec = await j("PUT", "/api/words/fish/audio/en", { asset: snd.id, text: "fish" });
  ok("kelimenin kaydi (en yuvasi)", rec.status === 200 && rec.body.audio.en?.asset === snd.id);
  const recB = await j("PUT", "/api/words/dog/audio/en", { asset: snd.id, text: "dog" });
  ok("uygulamanin kelimesine kayit verilebilir (paketteki kaydin yerine gecer)", recB.status === 200);

  /* a set, a game from an open engine, a category */
  const set = await j("POST", "/api/sets", { name: "Deniz dostları", words: ["fish", "bird", "turtle"] });
  ok("set", set.status === 201 && set.body.words.join() === "fish,bird,turtle", set.body.id);
  const closed = await j("POST", "/api/games", { template: "train", name: "Balık treni", set: set.body.id });
  ok("kapali motordan yeni oyun yapilamaz (tren balik cizemez)", closed.status === 400);
  const g = await j("POST", "/api/games", { template: "drag", name: "Denizde ver", set: set.body.id });
  ok("acik motordan yeni oyun, taslak", g.status === 201 && g.body.status === "draft" && g.body.words.length === 3, g.body.id);
  ok("3 kelime: uyari var, hata yok", g.body.issues.some((i: { level: string }) => i.level === "warn")
     && !g.body.issues.some((i: { level: string }) => i.level === "error"));
  await j("PATCH", `/api/games/${g.body.id}`, { status: "live" });
  const c = await j("POST", "/api/categories", { title: "Deniz", set: set.body.id, steps: [
    { id: "open", kind: "scene", scene: "blank" }, { id: "g1", kind: "game", game: g.body.id, teach: true },
    { id: "done", kind: "finish" }] });
  ok("kategori", c.status === 201, c.body.id);
  const live = await j("PATCH", `/api/categories/${c.body.id}`, { status: "live" });
  ok("hatasiz kategori uygulamaya hazir", live.status === 200 && live.body.status === "live");
  const delSet = await j("DELETE", `/api/sets/${set.body.id}`);
  ok("kullanilan set silinemez", delSet.status === 400);

  /* the draft, and publishing */
  const d = await j("GET", "/api/releases/draft");
  ok("taslak: 1 oyun, 1 kategori, 3 kelime, kayitlar", d.body.counts.games === 1 && d.body.counts.categories === 1
     && d.body.counts.words === 3 && d.body.counts.clips === 2 && !d.body.blocked, JSON.stringify(d.body.counts));
  ok("taslak farki: test kanali bos, her sey yeni", d.body.diff.test.added.length >= 5);
  const none = await j("GET", "/api/app/manifest?build=1&channel=test");
  ok("yayin yokken telefon bos doner (taslak asla gitmez)", none.status === 204);
  const pub = await j("POST", "/api/releases", { note: "ilk", channels: ["test"] });
  ok("yayin -> test", pub.status === 201 && pub.body.id === 1);
  const m = await j("GET", "/api/app/manifest?build=1&schema=1&channel=test");
  ok("telefon manifesti: oyun, kategori, kelimeler, kayitlar", m.status === 200 && m.body.games.length === 1
     && m.body.categories.length === 1 && m.body.words.length === 3 && !!m.body.clips["teacher/en_fish"]
     && !!m.body.clips["teacher/en_dog"]);
  ok("production'a henuz gitmedi", (await j("GET", "/api/app/manifest?build=1&channel=production")).status === 204);
  const tag = m.headers.get("etag")!;
  const again = await fetch(B + "/api/app/manifest?build=1&channel=test", { headers: { "If-None-Match": tag } });
  ok("ayni yayin ikinci kez: 304", again.status === 304);
  const a = Object.values(m.body.assets as Record<string, { url: string; sha256: string }>)[0]!;
  const cdn = await fetch(B + a.url);
  ok("dosya ozetiyle iner, sonsuza dek onbellek", cdn.status === 200
     && (cdn.headers.get("cache-control") ?? "").includes("immutable"));
  const schema = await j("GET", "/api/app/manifest?build=1&schema=99&channel=test");
  ok("bilinmeyen sema reddedilir", schema.status === 409);

  /* a change, a second release, promotion and rollback */
  const fix = await j("PATCH", "/api/words/fish", { tr: "balıkçık" });
  ok("kelime duzeltmesi yalniz o alani degistirir", fix.status === 200 && fix.body.tr === "balıkçık"
     && fix.body.about === "balık çok sevimlidir." && fix.body.icon === pic.id, JSON.stringify(fix.body).slice(0, 160));
  const d2 = await j("GET", "/api/releases/draft");
  ok("degisen kelime farkta gorunur", d2.body.diff.test.changed.includes("kelime: fish"));
  const r2 = await j("POST", "/api/releases", { note: "ikinci", channels: ["test"] });
  ok("ikinci yayin", r2.status === 201 && r2.body.id === 2, JSON.stringify(r2.body).slice(0, 200));
  await j("PUT", "/api/channels/production", { release: 2 });
  const prod = await j("GET", "/api/app/manifest?build=1&channel=production");
  ok("production'a terfi", prod.status === 200 && prod.body.release === 2
     && prod.body.words.find((w: { id: string }) => w.id === "fish").tr === "balıkçık");
  await j("PUT", "/api/channels/production", { release: 1 });
  const back = await j("GET", "/api/app/manifest?build=1&channel=production");
  ok("geri alma: production yeniden 1. yayinda", back.body.release === 1
     && back.body.words.find((w: { id: string }) => w.id === "fish").tr === "balık");

  /* an error blocks publishing -- breaking a live game directly is refused
     at the door; broken from the side (its set loses words) the release stops */
  const direct = await j("PATCH", `/api/games/${g.body.id}`, { set: null });
  ok("canli oyunu dogrudan bozmak reddedilir (hatali oyun uygulamada sayilmaz)", direct.status === 400
     && (await j("GET", "/api/games")).body.find((x: { id: string }) => x.id === g.body.id)?.set === set.body.id);
  const before = (await j("GET", "/api/sets")).body.find((x: { id: string }) => x.id === set.body.id);
  await j("PATCH", `/api/sets/${set.body.id}`, { words: [before.words[0]] }, { "If-Match": `"${before.updatedAt}"` });
  const blocked = await j("POST", "/api/releases", { note: "hatali" });
  ok("hatali canli icerik yayini durdurur", blocked.status === 400 && blocked.body.issues.length > 0, JSON.stringify(blocked.body).slice(0, 160));
  const now = (await j("GET", "/api/sets")).body.find((x: { id: string }) => x.id === set.body.id);
  await j("PATCH", `/api/sets/${set.body.id}`, { words: before.words }, { "If-Match": `"${now.updatedAt}"` });

  /* a build that does not have an engine never gets what needs it */
  const inv = (await j("GET", "/api/inventory")).body;
  /* the drawn map (2026-11-03): the app's six rows. An app folder whose
     inventory still reports the painted map is read without its roadmap; the
     second build then reports the drawn one the app's ids would have */
  const drawn = inv.roadmap?.kind === "drawn" ? inv.roadmap : {
    kind: "drawn", since: 1, stopsPerRow: 4,
    stops: inv.categories.flatMap((c: { id: string }) => ["1", "2", "3", "music"].map((k) => ({ id: `${c.id}-${k}`, kind: k, row: c.id }))) };
  if (inv.roadmap?.kind !== "drawn") console.log("  not  uygulamanin envanteri henuz cizili haritayi bildirmiyor; 2. derleme bildiriyor");
  const b2 = { ...inv, app: { ...inv.app, build: 2 }, roadmap: drawn, templates: inv.templates.map((t: { id: string; since: number }) =>
    t.id === "drag" ? { ...t, since: 2 } : t) };
  ok("ikinci derlemenin envanteri", (await j("PUT", "/api/inventory", b2)).status === 200);
  const r3 = await j("POST", "/api/releases", { note: "drag build 2", channels: ["test"] });
  ok("ucuncu yayin", r3.status === 201, JSON.stringify(r3.body).slice(0, 200));
  const old = await j("GET", "/api/app/manifest?build=1&channel=test");
  const neu = await j("GET", "/api/app/manifest?build=2&channel=test");
  ok("eski derleme yeni motoru isteyen icerigi almaz", old.body.games.length === 0 && old.body.categories.length === 0
     && neu.body.games.length === 1, `b1: ${old.body.games.length}, b2: ${neu.body.games.length}`);

  /* the old endpoints still answer, from production */
  const legacy = await j("GET", "/api/app/categories");
  ok("eski uc: production'daki kategori, kelimeler icinde", legacy.body.categories.length === 1
     && legacy.body.categories[0].words.length === 3);

  /* a new category from the wizard: the skeleton, a film, its framing */
  const sk = await j("POST", "/api/categories", { title: "Yedinci", set: set.body.id });
  const skGames = sk.body.steps.filter((s: { kind: string }) => s.kind === "game").map((s: { game: string; teach: boolean }) => `${s.game}:${s.teach}`);
  ok("yeni kategori acik motorlarla gelir (ogret, bul, kartsiz tekrar)", skGames.join() === "drag:true,pop:false,drag:false", skGames.join());
  ok("sorunlar yerlerini soyler (kart, kelimeler, akis)", sk.body.issues.every((i: { area?: string }) => ["card", "words", "flow"].includes(i.area ?? ""))
     && sk.body.issues.some((i: { area?: string }) => i.area === "words"));
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(2048, 7)]);
  const vf = new FormData();
  vf.append("file", new Blob([mp4], { type: "video/mp4" }), "acilis.mp4");
  const vid = (await (await fetch(B + "/api/assets", { method: "POST", body: vf })).json()) as { id: string; kind: string };
  ok("video yuklenir", vid.kind === "video");
  const part = await fetch(`${B}/api/assets/${vid.id}`, { headers: { Range: "bytes=10-19" } });
  ok("video parca parca okunur (Range, onizlemede ileri sarma)", part.status === 206 && (await part.arrayBuffer()).byteLength === 10
     && part.headers.get("content-range") === `bytes 10-19/${mp4.length}`);
  const steps = sk.body.steps.map((s: { id: string; kind: string }) => (s.id === "open" ? { ...s, video: vid.id, fit: "contain" } : s));
  const withVid = await j("PATCH", `/api/categories/${sk.body.id}`, { steps });
  const open = withVid.body.steps.find((s: { id: string }) => s.id === "open");
  ok("video adimi: dosya ve cerceve (bantli) saklanir", open.video === vid.id && open.fit === "contain");
  ok("indirme boyutu videoyu sayar", withVid.body.download >= mp4.length, String(withVid.body.download));
  ok("kategori silinir", (await j("DELETE", `/api/categories/${sk.body.id}`)).status === 200);

  /* the drawn map grows: a row after the app's six (2026-11-03, the app's docs/YOL-HARITASI-CIZILI.md) */
  const rm = await j("GET", "/api/roadmap");
  ok("harita: uygulamanin alti sirasi, 24 durak, sira basina en cok 4", rm.body.world?.kind === "drawn" && rm.body.world.rows.length === 6
     && rm.body.world.stops.length === 24 && rm.body.world.stopsPerRow === 4 && rm.body.world.rows[0].row === "kitchen"
     && rm.body.world.rows[0].stops.map((x: { kind: string }) => x.kind).join() === "1,2,3,music" && !("tiles" in rm.body.world),
     JSON.stringify(rm.body.world?.rows?.map((r: { row: string; title: string }) => `${r.row}:${r.title}`)));
  const ls = await j("POST", "/api/roadmap/slides", { title: "Deniz" });
  ok("yeni sira taslak, boyali haritanin alanlari yok", ls.status === 201 && ls.body.status === "draft"
     && !["image", "w", "trail", "entry", "land"].some((k) => k in ls.body));
  const st = (kind: string, steps: string[], extra: object = {}) => ({ id: `${ls.body.id}-${kind}`, kind, category: c.body.id, steps, ...extra });
  const textsOf = (r: { body: { issues: { text: string }[] } }) => r.body.issues.map((i) => i.text).join(" | ");
  let base = ls.body.updatedAt;
  const put = async (body: object) => {
    const r = await j("PATCH", `/api/roadmap/slides/${ls.body.id}`, body, { "If-Match": `"${base}"` });
    if (r.status === 200) base = r.body.updatedAt;
    return r;
  };
  const skip = await put({ stops: [st("2", ["open", "g1"])] });
  ok("sira kurali: oyun duraklari 1 · 2 · 3 sirasiyla", /sırada "1" olmalı/.test(textsOf(skip)), textsOf(skip).slice(0, 200));
  const musicFirst = await put({ stops: [{ id: `${ls.body.id}-m`, kind: "music", category: "", steps: [], song: snd.id }, st("1", ["open", "g1"])] });
  ok("sira kurali: muzik duragi en sonda", /en sonunda/.test(textsOf(musicFirst)), textsOf(musicFirst).slice(0, 200));
  const twoMusic = await put({ stops: [st("1", ["open", "g1"]), { id: `${ls.body.id}-m1`, kind: "music", song: snd.id },
                                       { id: `${ls.body.id}-m2`, kind: "music", song: snd.id }] });
  ok("sira kurali: en cok bir muzik duragi", /en çok bir müzik/.test(textsOf(twoMusic)), textsOf(twoMusic).slice(0, 200));
  const twoCats = await put({ stops: [st("1", ["open", "g1"]), { id: `${ls.body.id}-2`, kind: "2", category: "kitchen", steps: ["game-1"] }] });
  ok("sira kurali: bir sira tek kategori", /tek bir kategoridir/.test(textsOf(twoCats)), textsOf(twoCats).slice(0, 200));
  const five = await put({ stops: [st("1", ["open", "g1"]), st("2", ["g1"]), st("3", ["g1"]),
                                   { ...st("4", ["g1"]), kind: "3" }, { id: `${ls.body.id}-m`, kind: "music", song: snd.id }] });
  ok("sira kurali: sirada en cok 4 durak", /en çok 4 durak/.test(textsOf(five)), textsOf(five).slice(0, 200));
  const noGame = await put({ stops: [{ id: `${ls.body.id}-m`, kind: "music", song: snd.id }] });
  ok("sira kurali: en az bir oyun duragi", /Oyun durağı yok/.test(textsOf(noGame)), textsOf(noGame).slice(0, 200));
  /* the painted map's fields from an older panel tab: accepted, not stored */
  const good = await put({ image: pic.id, w: 600, entry: "boat", land: 1, trail: [[10, 569], [590, 360]],
    stops: [st("1", ["open", "g1"], { x: 300, y: 450 })] });
  ok("dogru sira: hatasiz; eski x/y/resim alanlari kabul edilir ama yazilmaz", good.status === 200
     && !good.body.issues.some((i: { level: string }) => i.level === "error") && good.body.category === c.body.id
     && !("x" in good.body.stops[0]) && !("image" in good.body), textsOf(good));
  const second = await j("POST", "/api/roadmap/slides", { title: "Orman" });
  await j("PATCH", `/api/roadmap/slides/${second.body.id}`, { stops: [{ id: `${second.body.id}-1`, kind: "1", category: c.body.id, steps: ["g1"] }] });
  const island = await j("PATCH", `/api/roadmap/slides/${second.body.id}`, { status: "live" });
  ok("zincir: oncesi yayinda degilken sonraki sira uygulamaya konamaz", island.status === 400
     && island.body.issues.some((i: { text: string }) => /Önceki sıra/.test(i.text)));
  /* the row's sign is the category's picture, a stop's the picture of its game */
  const gNow = (await j("GET", "/api/games")).body.find((x: { id: string }) => x.id === g.body.id);
  await j("PATCH", `/api/games/${g.body.id}`, { icon: pic2.id }, { "If-Match": `"${gNow.updatedAt}"` });
  const cNow = (await j("GET", "/api/categories")).body.find((x: { id: string }) => x.id === c.body.id);
  await j("PATCH", `/api/categories/${c.body.id}`, { icon: pic.id }, { "If-Match": `"${cNow.updatedAt}"` });
  const landLive = await put({ status: "live" });
  ok("sira uygulamaya konur", landLive.status === 200 && landLive.body.status === "live", textsOf(landLive));
  const dr = await j("GET", "/api/releases/draft");
  const row0 = dr.body.manifest.roadmap?.slides[0];
  console.log(`  manifest sirasi: ${JSON.stringify(row0)}`);
  ok("taslakta sira: sozlesmenin bicimi (kategori, tabela, duragin adimlari ve oyun resmi; resim/patika/konum yok)",
     JSON.stringify(row0) === JSON.stringify({ id: ls.body.id, title: "Deniz", category: c.body.id, icon: pic.id,
       stops: [{ id: `${ls.body.id}-1`, kind: "1", category: c.body.id, steps: ["open", "g1"], icon: pic2.id }] })
     && !!dr.body.manifest.assets[pic.id] && !!dr.body.manifest.assets[pic2.id]
     && dr.body.diff.test.added.some((x: string) => x.startsWith("harita sırası")));
  await j("POST", "/api/releases", { note: "sira", channels: ["test"] });
  const m1 = await j("GET", "/api/app/manifest?build=1&channel=test");
  const m2 = await j("GET", "/api/app/manifest?build=2&channel=test");
  ok("kategorisi telefona gitmeyen sira da gitmez (ada olmaz); gidende ikonlar da iner",
     !m1.body.roadmap && m2.body.roadmap?.slides[0].id === ls.body.id && !!m2.body.assets[pic.id] && !!m2.body.assets[pic2.id]);
  ok("sira silinir", (await j("DELETE", `/api/roadmap/slides/${ls.body.id}`)).status === 200
     && (await j("DELETE", `/api/roadmap/slides/${second.body.id}`)).status === 200);
  {
    const cBack = (await j("GET", "/api/categories")).body.find((x: { id: string }) => x.id === c.body.id);
    await j("PATCH", `/api/categories/${c.body.id}`, { icon: null }, { "If-Match": `"${cBack.updatedAt}"` });
  }

  /* download packs: a land and everything it needs, offered, not pushed (2026-10-17) */
  const crabPic = await upload(path.join(appDir, "src/assets/actions/run.png"), "image/png");
  const song = await upload(path.join(appDir, "src/assets/sfx/camera-shutter.mp3"), "audio/mpeg");
  for (const [id, en, tr] of [["crab", "crab", "yengeç"], ["starfish", "starfish", "denizyıldızı"]])
    await j("POST", "/api/words", { id, en, tr, about: `${tr} kumda yaşar.`, icon: crabPic.id, color: "#C4483C" });
  const crabClip = await upload(path.join(appDir, "src/assets/sfx/camera-shutter.mp3"), "audio/mpeg");
  await j("PUT", "/api/words/crab/audio/en", { asset: crabClip.id, text: "crab" });
  const pset = await j("POST", "/api/sets", { name: "Kumsal", words: ["crab", "starfish"] });
  const pc = await j("POST", "/api/categories", { title: "Kumsal", set: pset.body.id });
  const vf2 = new FormData();
  vf2.append("file", new Blob([Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(4096, 3)])], { type: "video/mp4" }), "kumsal.mp4");
  const pvid = (await (await fetch(B + "/api/assets", { method: "POST", body: vf2 })).json()) as { id: string };
  await j("PATCH", `/api/categories/${pc.body.id}`, { steps: pc.body.steps.map((x: { id: string }) => (x.id === "open" ? { ...x, video: pvid.id } : x)) });
  ok("paket kategorisi uygulamada", (await j("PATCH", `/api/categories/${pc.body.id}`, { status: "live" })).status === 200);
  const pk = await j("POST", "/api/packs", { title: "Kumsal paketi", subtitle: "yeni bir sahil" });
  ok("paket olusur (taslak, sirasiz: hata)", pk.status === 201 && pk.body.issues.some((i: { text: string }) => /sıra yok/.test(i.text)));
  const pl = await j("POST", "/api/roadmap/slides", { title: "Kumsal" });
  /* the row's sign (the category's picture) is the pack's alone */
  const landImg = await upload(path.join(appDir, "src/assets/actions/sit.png"), "image/png");
  const pcNow = (await j("GET", "/api/categories")).body.find((x: { id: string }) => x.id === pc.body.id);
  await j("PATCH", `/api/categories/${pc.body.id}`, { icon: landImg.id }, { "If-Match": `"${pcNow.updatedAt}"` });
  const stp = (id: string, kind: string, extra: object) => ({ id: `${pl.body.id}-${id}`, kind, category: "", steps: [], ...extra });
  const pls = await j("PATCH", `/api/roadmap/slides/${pl.body.id}`, { pack: pk.body.id,
    stops: [stp("1", "1", { category: pc.body.id, steps: ["open", "game-1"] }),
            stp("2", "2", { category: pc.body.id, steps: ["to-2", "game-2"] }),
            stp("3", "3", { category: pc.body.id, steps: ["to-3", "game-3"] }),
            stp("m", "music", { song: song.id })] });
  ok("paketli sira: uc oyun ve muzik duragi sarkisiyla, hatasiz", pls.status === 200 && !pls.body.issues.some((i: { level: string }) => i.level === "error"),
     pls.body.issues.map((i: { text: string }) => i.text).join(" | "));
  const tail = await j("POST", "/api/roadmap/slides", { title: "Sonraki" });
  const tailOut = (await j("GET", "/api/roadmap")).body.slides.find((x: { id: string }) => x.id === tail.body.id);
  ok("paketli siradan sonra paketsiz sira gelemez (ada)", tailOut.issues.some((i: { text: string }) => /bir pakette olmalı/.test(i.text)));
  await j("DELETE", `/api/roadmap/slides/${tail.body.id}`);
  await j("PATCH", `/api/roadmap/slides/${pl.body.id}`, { status: "live" });
  const late = await j("PATCH", `/api/packs/${pk.body.id}`, { offerAt: `${pl.body.id}-2` });
  ok("sunulma noktasi paketin kendi duraklarindan once olmali", late.body.issues.some((i: { text: string }) => /önce olmalı/.test(i.text)));
  const pkOk = await j("PATCH", `/api/packs/${pk.body.id}`, { offerAt: "numbers-3", status: "live" }, { "If-Match": `"${late.body.updatedAt}"` });
  ok("paket uygulamaya konur; boyutu ve icindekiler", pkOk.status === 200 && pkOk.body.bytes > 0 && pkOk.body.categories[0]?.id === pc.body.id
     && pkOk.body.lands[0]?.id === pl.body.id, JSON.stringify(pkOk.body.issues));
  const pd = await j("GET", "/api/releases/draft");
  const mp = pd.body.manifest.packs?.[0];
  console.log(`  paketli manifest sirasi: ${JSON.stringify(pd.body.manifest.roadmap?.slides?.[0])}`);
  ok("taslakta paket: yalniz ona ait dosyalar (sira tabelasi, video, sarki, kendi kelimelerinin resim ve kaydi)",
     !!mp && ["landImg", "pvid", "song", "crabPic", "crabClip"].every((k) => mp.assets.includes(({ landImg, pvid, song, crabPic, crabClip } as Record<string, { id: string }>)[k]!.id))
     && !mp.assets.includes(pic.id) && mp.offerAt === "numbers-3", JSON.stringify(mp?.assets));
  ok("paketin kategorisi isaretli; herkese inen dosyalar pakete sayilmaz",
     pd.body.manifest.categories.find((x: { id: string }) => x.id === pc.body.id)?.pack === pk.body.id
     && !mp.assets.includes(snd.id));
  await j("POST", "/api/releases", { note: "paket", channels: ["test"] });
  const pm = await j("GET", "/api/app/manifest?build=2&channel=test");
  ok("telefon paketi listede gorur (dosyalariyla), kategori paketine bagli", pm.body.packs?.[0]?.id === pk.body.id
     && pm.body.packs[0].assets.every((id: string) => !!pm.body.assets[id]));
  const legacyNow = await j("GET", "/api/app/categories");
  ok("eski uc paketin kategorisini vermez (soramayan surum izinsiz indirmez)", !legacyNow.body.categories.some((x: { id: string }) => x.id === pc.body.id));
  await j("DELETE", `/api/roadmap/slides/${pl.body.id}`);
  ok("paket silinir", (await j("DELETE", `/api/packs/${pk.body.id}`)).status === 200);

  console.log("\n── Akış incelemesi (2026-10-18): F02 F03 F04 F05 F07 · çizili harita ──");
  {
    /* two sea categories, each on its own land of its own pack */
    for (const [id, en, tr] of [["eel", "eel", "yılanbalığı"], ["squid", "squid", "kalamar"], ["shell", "shell", "deniz kabuğu"], ["wave", "wave", "dalga"]])
      await j("POST", "/api/words", { id, en, tr, about: `${tr} denizdedir.`, icon: crabPic.id, color: "#2A6FB0" });
    const sa = await j("POST", "/api/sets", { name: "Deniz A", words: ["eel", "squid"] });
    const sb = await j("POST", "/api/sets", { name: "Deniz B", words: ["shell", "wave"] });
    const ca = await j("POST", "/api/categories", { title: "Deniz A", set: sa.body.id });
    const cb = await j("POST", "/api/categories", { title: "Deniz B", set: sb.body.id });
    ok("iki kategori uygulamada", (await j("PATCH", `/api/categories/${ca.body.id}`, { status: "live" })).status === 200
       && (await j("PATCH", `/api/categories/${cb.body.id}`, { status: "live" })).status === 200);
    const img = await upload(path.join(appDir, "src/assets/actions/clap.png"), "image/png");
    const la = await j("POST", "/api/roadmap/slides", { title: "Deniz A" });
    const lb = await j("POST", "/api/roadmap/slides", { title: "Deniz B" });
    const stop = (land: string, n: string, kind: string, category: string, steps: string[]) =>
      ({ id: `${land}-${n}`, kind, category, steps });
    const textsOf = (r: { body: { issues: { text: string }[] } }) => r.body.issues.map((i) => i.text).join(" | ");

    /* F05: practice on the first stop, the cards on the next */
    const backwards = await j("PATCH", `/api/roadmap/slides/${la.body.id}`, {
      stops: [stop(la.body.id, "a", "1", ca.body.id, ["to-2", "game-2"]), stop(la.body.id, "b", "2", ca.body.id, ["open", "game-1"])] });
    ok("F05: haritada alistirma ogretimden once: ilgili duraga hata", /1\. durak: .*kartla tanıtılmadı/.test(textsOf(backwards)), textsOf(backwards).slice(0, 200));
    /* the drawn map's row: games 1, 2, 3 in order, the music stop last */
    const swapped = await j("PATCH", `/api/roadmap/slides/${la.body.id}`, {
      stops: [stop(la.body.id, "a", "2", ca.body.id, ["open", "game-1"]), stop(la.body.id, "b", "1", ca.body.id, ["to-2", "game-2"])] },
      { "If-Match": `"${backwards.body.updatedAt}"` });
    ok("cizili harita: 2. durak 1.'den once olamaz", /sırada "1" olmalı/.test(textsOf(swapped)), textsOf(swapped).slice(0, 200));
    const right = await j("PATCH", `/api/roadmap/slides/${la.body.id}`, {
      stops: [stop(la.body.id, "a", "1", ca.body.id, ["open", "game-1"]), stop(la.body.id, "b", "2", ca.body.id, ["to-2", "game-2"]),
              stop(la.body.id, "c", "3", ca.body.id, ["to-3", "game-3"])] },
      { "If-Match": `"${swapped.body.updatedAt}"` });
    ok("F05: dogru sira: hatasiz", !right.body.issues.some((i: { level: string }) => i.level === "error"), textsOf(right));
    await j("PATCH", `/api/roadmap/slides/${lb.body.id}`, {
      stops: [stop(lb.body.id, "a", "1", cb.body.id, ["open", "game-1"]), stop(lb.body.id, "b", "2", cb.body.id, ["to-2", "game-2", "to-3", "game-3"])] });

    /* F02: pack B made FIRST, A second; the map is A then B */
    const pb = await j("POST", "/api/packs", { title: "Deniz B paketi" });
    const pa = await j("POST", "/api/packs", { title: "Deniz A paketi" });
    await j("PATCH", `/api/roadmap/slides/${la.body.id}`, { pack: pa.body.id, status: "live" });
    await j("PATCH", `/api/roadmap/slides/${lb.body.id}`, { pack: pb.body.id, status: "live" });

    /* F03: A's pack still a draft -- its category must not fall into the base */
    const leak = await j("GET", "/api/releases/draft");
    ok("F03: taslak paketin kategorisi temel indirmeye dusmez", !leak.body.manifest.categories.some((x: { id: string }) => x.id === ca.body.id)
       && leak.body.issues.some((i: { kind: string; item: string; text: string }) => i.kind === "category" && i.item === ca.body.id && /paket/.test(i.text)),
       JSON.stringify(leak.body.manifest.categories.map((x: { id: string; pack?: string }) => [x.id, x.pack ?? null])));
    ok("UX02: zincirin koptugu yer ve atlanan siralar nedeniyle listelenir",
       leak.body.issues.some((i: { kind: string; item: string; text: string }) => i.kind === "roadmap" && i.item === la.body.id && /yayına girmiyor/.test(i.text)));
    const fresh = (await j("GET", "/api/packs")).body;
    const pa2 = fresh.find((x: { id: string }) => x.id === pa.body.id), pb2 = fresh.find((x: { id: string }) => x.id === pb.body.id);
    await j("PATCH", `/api/packs/${pa.body.id}`, { offerAt: "numbers-3", status: "live" }, { "If-Match": `"${pa2.updatedAt}"` });
    await j("PATCH", `/api/packs/${pb.body.id}`, { offerAt: `${la.body.id}-b`, status: "live" }, { "If-Match": `"${pb2.updatedAt}"` });
    ok("F02: paketler listesi haritanin sirasiyla", (await j("GET", "/api/packs")).body.filter((x: { id: string }) => [pa.body.id, pb.body.id].includes(x.id))
       .map((x: { id: string }) => x.id).join() === `${pa.body.id},${pb.body.id}`);
    const two = await j("GET", "/api/releases/draft");
    ok("F02: yayinda paketler haritanin sirasiyla (olusturma sirasiyla degil)",
       (two.body.manifest.packs ?? []).map((x: { id: string }) => x.id).join() === `${pa.body.id},${pb.body.id}`,
       JSON.stringify((two.body.manifest.packs ?? []).map((x: { id: string }) => x.id)));
    ok("F03: paketi yayindaki kategori kendi paketine bagli", two.body.manifest.categories.find((x: { id: string }) => x.id === ca.body.id)?.pack === pa.body.id);

    /* F04: a stop id phones have may not open another lesson */
    await j("POST", "/api/releases", { note: "akis", channels: ["production"] });
    const now = (await j("GET", "/api/roadmap")).body.slides.find((x: { id: string }) => x.id === lb.body.id);
    const rebound = await j("PATCH", `/api/roadmap/slides/${lb.body.id}`, {
      stops: [stop(lb.body.id, "a", "1", ca.body.id, ["open", "game-1"]), stop(lb.body.id, "b", "2", cb.body.id, ["to-2", "game-2", "to-3", "game-3"])] },
      { "If-Match": `"${now.updatedAt}"` });
    ok("F04: uretimdeki durak kimligi baska kategoriye baglanamaz", /başka bir dersi açıyordu/.test(textsOf(rebound)), textsOf(rebound).slice(0, 200));

    /* review (2026-10-19): the same lesson with another film keeps the id;
       the same id playing other games is refused */
    const now2 = (await j("GET", "/api/roadmap")).body.slides.find((x: { id: string }) => x.id === lb.body.id);
    const filmOnly = await j("PATCH", `/api/roadmap/slides/${lb.body.id}`, {
      stops: [stop(lb.body.id, "a", "1", cb.body.id, ["game-1"]), stop(lb.body.id, "b", "2", cb.body.id, ["to-2", "game-2", "to-3", "game-3"])] },
      { "If-Match": `"${now2.updatedAt}"` });
    ok("yayindaki durakta yalniz video degisirse kimlik ve ilerleme korunur", !/başka/.test(textsOf(filmOnly)), textsOf(filmOnly).slice(0, 200));
    const otherGames = await j("PATCH", `/api/roadmap/slides/${lb.body.id}`, {
      stops: [stop(lb.body.id, "a", "1", cb.body.id, ["open", "game-1"]), stop(lb.body.id, "b", "2", cb.body.id, ["to-2", "game-2"])] },
      { "If-Match": `"${filmOnly.body.updatedAt}"` });
    ok("yayindaki durak baska oyunlari oynatirsa hata (yeni kimlik gerekir)", /başka oyunları oynatıyordu/.test(textsOf(otherGames)), textsOf(otherGames).slice(0, 240));

    /* review (2026-10-19): a song request sent twice (its answer lost) makes one song */
    const ms = (await j("GET", "/api/songs")).body;
    const mstop = ms.stops[0].id;
    const op = "song-test-op-12345";
    const s1 = await j("POST", "/api/songs", { title: "Tekrar şarkısı", stop: mstop, op });
    const s2 = await j("POST", "/api/songs", { title: "Tekrar şarkısı", stop: mstop, op });
    const many = (await j("GET", "/api/songs")).body.songs.filter((x: { title: string }) => x.title === "Tekrar şarkısı").length;
    ok("ayni islem kimligiyle iki istek tek sarki olusturur", s1.status === 201 && s2.status === 200 && s1.body.id === s2.body.id && many === 1,
       `${s1.status}/${s2.status} ${s1.body.id}/${s2.body.id} ${many}`);
    const s3 = await j("POST", "/api/songs", { title: "Tekrar şarkısı", stop: mstop });
    ok("islem kimligi olmadan eski davranis (yeni sarki)", s3.status === 201 && s3.body.id !== s1.body.id);
    for (const x of [s1.body.id, s3.body.id]) await j("DELETE", `/api/songs/${x}`);

    /* F07: an app game's card picture is the app's */
    const builtin = (await j("GET", "/api/games")).body.find((g: { builtin: boolean }) => g.builtin);
    const pic7 = await j("PATCH", `/api/games/${builtin.id}`, { icon: img.id }, { "If-Match": `"${builtin.updatedAt}"` });
    ok("F07: hazir oyunun kart resmi panelden degistirilemez", pic7.status === 400 && /kart resmini uygulama çizer/.test(pic7.body.error ?? ""), JSON.stringify(pic7.body).slice(0, 160));

    for (const sl of [lb.body.id, la.body.id]) await j("DELETE", `/api/roadmap/slides/${sl}`);
    for (const pid of [pa.body.id, pb.body.id]) await j("DELETE", `/api/packs/${pid}`);
  }

  console.log("\n── Maskotlar ──");
  {
    const mw = await j("GET", "/api/mascots");
    const lr = mw.body.roles.find((r: { role: string }) => r.role === "learner");
    ok("iki rol, sozlesme ve uygulamanin kendi maskotlari envanterden", mw.body.roles.length === 2 && mw.body.contract?.canvas === 512
       && lr?.builtin?.name === "Lili" && lr.builtin.base === "app-mascot-learner"
       && lr.behaviours.some((b: { key: string; mappable: boolean }) => b.key === "tickle" && b.mappable)
       && lr.behaviours.some((b: { key: string; mappable: boolean }) => b.key === "intro" && !b.mappable)
       && lr.namedLines.length > 10 && mw.body.travel.map === "stroll");
    const own = await fetch(B + "/api/assets/app-mascot-learner");
    ok("uygulamanin tavsani bir animasyon dosyasi olarak sunuluyor", own.ok && own.headers.get("content-type")?.startsWith("application/json") === true
       && own.headers.get("x-content-type-options") === "nosniff");
    /* the "bear": the bunny's file; an emotions set with its own markers */
    const tmp = mkdtempSync(path.join(tmpdir(), "loplop-lottie-"));
    const bunny = JSON.parse(readFileSync(path.join(appDir, "src/assets/bunny_states.json"), "utf8"));
    const mk = (name: string, doc: unknown) => { const f = path.join(tmp, name); writeFileSync(f, JSON.stringify(doc)); return f; };
    const tickle = bunny.markers.find((m: { cm: string }) => m.cm === "tickle");
    const bearF = mk("ayi.json", bunny);
    const feelF = mk("duygular.json", { ...bunny, markers: [{ cm: "sevinme_2", tm: tickle.tm, dr: tickle.dr }, { cm: "aglama", tm: 150, dr: 120 }] });
    const exprF = mk("ifade.json", { ...bunny, layers: [{ ks: { o: { a: 0, k: 100, x: "var $bm_rt = time;" } } }] });
    const extF = mk("dis.json", { ...bunny, assets: [{ id: "img", w: 10, h: 10, p: "https://kotu.example/x.png" }] });
    const notF = mk("degil.json", { merhaba: 1 });
    const iosF = mk("ios.json", JSON.parse(JSON.stringify(bunny).replace('"c":true', '"c":1.0')));
    const up = async (f: string) => {
      const fd = new FormData();
      fd.append("file", new Blob([readFileSync(f)], { type: "application/json" }), path.basename(f));
      const r = await fetch(B + "/api/assets", { method: "POST", body: fd });
      return { status: r.status, body: await r.json() as { id: string; kind: string; error?: string } };
    };
    const bear = await up(bearF), feel = await up(feelF);
    ok("Lottie yuklenir, turu animasyon", bear.status === 200 && bear.body.kind === "animation" && feel.body.kind === "animation", JSON.stringify(bear.body));
    const ex = await up(exprF), ext = await up(extF), not = await up(notF), ios = await up(iosF);
    ok("şekil bayrağı sayı olan Lottie reddedilir (iOS hiç çizmezdi)", ios.status === 415 && /iOS/.test(ios.body.error ?? ""), ios.body.error);
    ok("ifadeli Lottie reddedilir (program)", ex.status === 415 && /ifade/.test(ex.body.error ?? ""), ex.body.error);
    ok("disaridan resim isteyen Lottie reddedilir", ext.status === 415 && /dışarıdan/.test(ext.body.error ?? ""), ext.body.error);
    ok("Lottie olmayan JSON reddedilir", not.status === 415, not.body.error);
    const mk2 = (name: string, doc: unknown) => { const t2 = mkdtempSync(path.join(tmpdir(), "loplop-lottie2-")); const f = path.join(t2, name); writeFileSync(f, JSON.stringify(doc)); return f; };
    rmSync(tmp, { recursive: true, force: true });

    const made = await j("POST", "/api/mascots", { role: "learner", name: "Ayı" });
    ok("yeni maskot taslak, ana dosyasi yok diye hata", made.status === 201 && made.body.status === "draft"
       && made.body.issues.some((i: { level: string; text: string }) => i.level === "error" && /Ana dosya/.test(i.text)));
    const id = made.body.id as string;
    const early = await j("PATCH", `/api/mascots/${id}`, { status: "live" });
    ok("hatali maskot uygulamaya konamaz", early.status === 400);
    const wrong = await j("PATCH", `/api/mascots/${id}`, { base: bear.body.id, sets: [{ id: "duygular", label: "Duygular", kind: "feel", asset: feel.body.id }],
      map: { tickle: [{ set: "duygular", marker: "yok" }] } });
    ok("sette olmayan isaretci hata", wrong.body.issues.some((i: { text: string }) => /"yok" işaretçisi yok/.test(i.text)));
    const scene = await j("PATCH", `/api/mascots/${id}`, { map: { intro: [{ set: "duygular", marker: "sevinme_2" }] } }, { "If-Match": `"${wrong.body.updatedAt}"` });
    ok("sahne baska sete eslenemez", scene.body.issues.some((i: { text: string }) => /eşlenemez/.test(i.text)));
    const notAnim = await j("PATCH", `/api/mascots/${id}`, { base: pic.id });
    ok("resim ana dosya olamaz", notAnim.status === 400);
    const live = await j("PATCH", `/api/mascots/${id}`, {
      map: { tickle: [{ set: "duygular", marker: "sevinme_2" }, { set: "base", marker: "tickle" }], ear_wiggle: [{ set: "duygular", marker: "aglama" }] },
      foot: { x: 0.47, y: 0.88, top: 0.17 }, status: "live" }, { "If-Match": `"${scene.body.updatedAt}"` });
    ok("maskot uygulamada; adi degisti diye uyari", live.status === 200 && live.body.status === "live"
       && live.body.issues.some((i: { text: string }) => /satır bu adı söylüyor/.test(i.text))
       && live.body.files.duygular?.some((m: { name: string }) => m.name === "aglama"), JSON.stringify(live.body.issues));
    /* a single animation (no markers): played whole */
    const one = await up(mk2("tek.json", { ...bunny, ip: 0, op: 90, markers: [] }));
    const whole = await j("PATCH", `/api/mascots/${id}`, { sets: [...live.body.sets, { id: "tek", label: "Tek sevinme", kind: "feel", asset: one.body.id }],
      map: { ...live.body.map, tickle: [{ set: "tek", marker: "*" }] } }, { "If-Match": `"${live.body.updatedAt}"` });
    ok("isaretcisiz tek animasyon tumuyle eslenir", whole.status === 200 && !whole.body.issues.some((i: { level: string }) => i.level === "error")
       && whole.body.files.tek?.some((m: { name: string; to: number }) => m.name === "*" && m.to === 90), JSON.stringify(whole.body.issues));
    await j("PATCH", `/api/mascots/${id}`, { map: live.body.map, sets: live.body.sets }, { "If-Match": `"${whole.body.updatedAt}"` });
    const shortBase = await up(mk2("kisa.json", { ...bunny, op: 6270 }));
    const sb = await j("PATCH", `/api/mascots/${id}`, { base: shortBase.body.id });
    ok("kısa ana dosya (sessiz ikizler yok) hata; uygulamadaki maskot olarak kalamaz", sb.status === 400
       && JSON.stringify(sb.body).includes("sessiz ikiz"), JSON.stringify(sb.body).slice(0, 200));
    const cur = (await j("GET", "/api/mascots")).body.list.find((x: { id: string }) => x.id === id);
    const vo = await j("PATCH", `/api/mascots/${id}`, { voice: "own" }, { "If-Match": `"${cur.updatedAt}"` });
    ok("kendi sesi: kaydedilir, uyarı verir", vo.body.voice === "own" && vo.body.issues.some((i: { text: string }) => /Kendi sesi/.test(i.text)));
    const md = await j("GET", "/api/releases/draft");
    const mm = md.body.manifest.mascots;
    ok("taslakta maskot: dosyalari, eslemesi, ayaklari", mm?.list?.[0]?.role === "learner" && mm.list[0].name === "Ayı"
       && md.body.manifest.assets[mm.list[0].base]?.kind === "animation" && mm.list[0].sets[0].asset === feel.body.id
       && mm.list[0].map.tickle.length === 2 && mm.list[0].foot.x === 0.47 && mm.travel.map === "stroll");
    ok("maskot dosyasi kullanimda: silinemez", (await j("DELETE", `/api/assets/${feel.body.id}`)).status === 409);
    const tr = await j("PUT", "/api/mascots/travel", { map: "walk", scene: "stroll" });
    ok("yuruyus secilir", tr.body.map === "walk" && (await j("GET", "/api/releases/draft")).body.manifest.mascots.travel.scene === "stroll");
    await j("POST", "/api/releases", { note: "maskot", channels: ["test"] });
    const ph = await j("GET", "/api/app/manifest?build=1&channel=test");
    ok("telefon maskotu ve dosyalarini alir", ph.body.mascots?.list?.[0]?.voice === "own" && ph.body.mascots?.list?.[0]?.id === id
       && !!ph.body.assets[ph.body.mascots.list[0].base] && !!ph.body.assets[feel.body.id] && ph.body.mascots.travel.map === "walk");
    const second = await j("POST", "/api/mascots", { role: "learner", name: "Panda", from: "builtin" });
    ok("uygulamanin dosyasindan baslayan maskot: ana dosya ve ayak hazir", second.body.base === "app-mascot-learner" && !!second.body.foot
       && !second.body.issues.some((i: { level: string }) => i.level === "error"), JSON.stringify(second.body.issues));
    await j("PATCH", `/api/mascots/${second.body.id}`, { status: "live" });
    const both = await j("GET", "/api/mascots");
    ok("bir rolde tek maskot: yenisi uygulamaya girince oncekisi taslaga doner",
       both.body.list.find((m: { id: string }) => m.id === id)?.status === "draft"
       && both.body.list.find((m: { id: string }) => m.id === second.body.id)?.status === "live");
    await j("PUT", "/api/mascots/travel", { map: "stroll", scene: "walk" });
    for (const m of both.body.list) await j("DELETE", `/api/mascots/${m.id}`);
    const gone = await j("GET", "/api/releases/draft");
    ok("maskot yoksa ve yuruyus varsayilansa taslakta maskot bolumu yok", gone.body.manifest.mascots === undefined);
  }

  console.log("\n── Yazı tipleri (2026-10-23) ──");
  {
    const fw = await j("GET", "/api/fonts");
    const title = fw.body.roles?.find((r: { role: string }) => r.role === "title");
    ok("dort rol, zorunlu harfler ve uygulamanin kendi fontlari envanterden",
       fw.body.roles?.length === 4 && /Ş/.test(fw.body.contract?.required ?? "") && title?.builtin?.asset === "app-font-title"
       && title.weight === 600, JSON.stringify(fw.body.roles?.map((r: { role: string; builtin: { asset: string } }) => [r.role, r.builtin.asset])));
    const own = await fetch(B + "/api/assets/app-font-title");
    ok("uygulamanin fontu panelde gosterilebilir (font/ttf)", own.ok && (own.headers.get("content-type") ?? "").startsWith("font/ttf"));

    /* the bytes decide: WOFF is for the web, the phone cannot load it */
    const woff = new FormData();
    woff.append("file", new Blob([Buffer.concat([Buffer.from("wOFF"), Buffer.alloc(60)])], { type: "font/ttf" }), "x.ttf");
    const wr = await fetch(B + "/api/assets", { method: "POST", body: woff });
    ok("WOFF reddedilir (telefon acamaz)", wr.status === 415 && /WOFF/.test((await wr.json()).error ?? ""));

    /* the official Fredoka: no Ğ ğ İ Ş ş, and a variable file -- never in play */
    const fred = await upload(path.join(appDir, "tools/fonts/src/Fredoka[wdth,wght].ttf"), "font/ttf");
    const bad = await j("POST", "/api/fonts", { role: "title", name: "Fredoka (resmi)", asset: fred.id });
    const miss = bad.body.issues?.find((i: { text: string }) => /harf yok/.test(i.text))?.text ?? "";
    ok("Turkce harfi eksik font: eksik harfler tek tek soylenir", bad.status === 201
       && ["Ğ", "ğ", "İ", "Ş", "ş"].every((c) => miss.includes(c)) && bad.body.report?.variable === true, miss);
    const badLive = await j("PATCH", `/api/fonts/${bad.body.id}`, { status: "live", license: "SIL OFL 1.1" }, { "If-Match": `"${bad.body.updatedAt}"` });
    ok("eksik harfli / degisken font uygulamaya konamaz", badLive.status === 400);

    /* a whole static font of the role's weight, with a licence */
    const nun = await upload(path.join(appDir, "src/assets/fonts/Nunito-SemiBold.ttf"), "font/ttf");
    const good = await j("POST", "/api/fonts", { role: "title", name: "Nunito başlık", asset: nun.id });
    ok("tam font: eksik harf yok, agirlik 600, satir olculdu", good.status === 201 && good.body.report?.missing?.length === 0
       && good.body.report.weight === 600 && good.body.report.minLine >= 1.2 && good.body.report.minLine <= 1.5, JSON.stringify(good.body.report));
    const noLic = await j("PATCH", `/api/fonts/${good.body.id}`, { status: "live" }, { "If-Match": `"${good.body.updatedAt}"` });
    ok("lisansi yazilmamis font uygulamaya konamaz", noLic.status === 400 && /Lisans/.test(JSON.stringify(noLic.body.issues ?? [])));
    const cur = (await j("GET", "/api/fonts")).body.list.find((x: { id: string }) => x.id === good.body.id);
    const live = await j("PATCH", `/api/fonts/${good.body.id}`, { status: "live", license: "SIL OFL 1.1" }, { "If-Match": `"${cur.updatedAt}"` });
    ok("lisansiyla uygulamaya girer", live.status === 200 && live.body.status === "live", JSON.stringify(live.body).slice(0, 200));

    const regular = await upload(path.join(appDir, "src/assets/fonts/Nunito-Regular.ttf"), "font/ttf");
    const heavy = await j("POST", "/api/fonts", { role: "strong", name: "İnce vurgu", asset: regular.id });
    ok("yanlis agirlik (400, vurgu 700 ister): hata, sahte kalinlik yok",
       (heavy.body.issues ?? []).some((i: { level: string; text: string }) => i.level === "error" && /ağırlığı 400/.test(i.text)));

    const d = await j("GET", "/api/releases/draft");
    const faces = d.body.manifest.typography?.faces ?? [];
    ok("taslakta yalniz canli ve hatasiz font: baslik", faces.length === 1 && faces[0].role === "title"
       && d.body.manifest.assets[faces[0].asset]?.md5 && d.body.counts.fonts === 1, JSON.stringify(faces));
    const remote = await import("../../loplop/src/core/remote.ts");
    const read = remote.readManifest({ ...d.body.manifest, release: 1 }, (id: string) => `file:///x/${id}`);
    ok("uygulamanin okuyucusu fontu alir (icerik ozetiyle adlanir)", read.fonts?.length === 1 && read.fonts[0]!.role === "title"
       && /^font-[a-f0-9]{16}$/.test(read.fonts[0]!.family) && read.fonts[0]!.minLine === faces[0].minLine, JSON.stringify(read.fonts));
    ok("manifest butun (uygulamanin denetimi)", remote.manifestProblem({ ...d.body.manifest, release: 1 }) === null);

    /* one per role: the second title takes the first one out */
    const nun2 = await upload(path.join(appDir, "src/assets/fonts/FredokaTR-SemiBold.ttf"), "font/ttf");
    const second = await j("POST", "/api/fonts", { role: "title", name: "Fredoka TR (kopya)", asset: nun2.id });
    ok("uygulamanin Fredoka TR'si baska bir okuyucuyla da tam: hicbir harf eksik degil", second.body.report?.missing?.length === 0
       && second.body.report.weight === 600 && second.body.report.family === "Fredoka TR", JSON.stringify(second.body.report));
    const s2 = await j("PATCH", `/api/fonts/${second.body.id}`, { status: "live", license: "SIL OFL 1.1" }, { "If-Match": `"${second.body.updatedAt}"` });
    const after = (await j("GET", "/api/fonts")).body.list;
    ok("bir rolde tek font: yenisi girince oncekisi taslaga doner", s2.status === 200
       && after.find((x: { id: string }) => x.id === good.body.id)?.status === "draft");
    const usage = await j("GET", `/api/assets/${nun2.id}/usage`);
    ok("dosyanin kullanimi gorunur (silinemez)", JSON.stringify(usage.body).includes("Yazı tipi"), JSON.stringify(usage.body).slice(0, 160));
    for (const x of after) await j("DELETE", `/api/fonts/${x.id}`);
    const none = await j("GET", "/api/releases/draft");
    ok("font yoksa taslakta yazi tipi bolumu yok (uygulamanin kendi fontlari)", none.body.manifest.typography === undefined);
  }

  console.log("\n── Renk paletleri (2026-10-29) ──");
  {
    const pw = await j("GET", "/api/palettes");
    const c = pw.body.contract;
    ok("roller, uygulamanin kendi paleti ve hazir paletler envanterden",
       c?.roles?.length === 12 && c.builtin?.id === "kayisi-okyanus" && (c.presets?.length ?? 0) >= 7, JSON.stringify(c?.builtin?.name));
    const mk = await j("POST", "/api/palettes", { name: "Deneme", from: "sabah-cayiri" });
    ok("hazir paletten yeni palet (taslak), kontrastlar olculur", mk.status === 201 && mk.body.status === "draft"
       && mk.body.colors?.primary?.background === "#FFC83D" && mk.body.contrast?.card > 4.5, JSON.stringify(mk.body.contrast));
    const unreadable = await j("PATCH", `/api/palettes/${mk.body.id}`, { colors: { primary: { text: "#FFD24A" } } }, { "If-Match": `"${mk.body.updatedAt}"` });
    ok("okunmayan dugme yazisi: hata, yalniz o rol degisti", unreadable.status === 200
       && unreadable.body.colors.primary.background === "#FFC83D"
       && unreadable.body.issues.some((i: { level: string; text: string }) => i.level === "error" && /Ana düğmenin yazısı/.test(i.text)));
    const refused = await j("PATCH", `/api/palettes/${mk.body.id}`, { status: "live" }, { "If-Match": `"${unreadable.body.updatedAt}"` });
    ok("hatali palet uygulamaya konamaz", refused.status === 400);
    const bad = await j("PATCH", `/api/palettes/${mk.body.id}`, { colors: { accent: "kırmızı" } }, { "If-Match": `"${unreadable.body.updatedAt}"` });
    ok("renk olmayan deger reddedilir", bad.status === 400);
    const stale = await j("PATCH", `/api/palettes/${mk.body.id}`, { name: "x" }, { "If-Match": `"${mk.body.updatedAt}"` });
    ok("eski surume dayanan yazim reddedilir (If-Match)", stale.status === 409);
    const fixed = await j("PATCH", `/api/palettes/${mk.body.id}`, { colors: { primary: { text: "#2F3B5C" } }, status: "live" }, { "If-Match": `"${unreadable.body.updatedAt}"` });
    ok("duzeltilince uygulamaya girer", fixed.status === 200 && fixed.body.status === "live", JSON.stringify(fixed.body.issues));
    const d = await j("GET", "/api/releases/draft");
    ok("taslakta palet: renkleriyle, sayaçta adi", d.body.manifest.palette?.colors?.primary?.text === "#2F3B5C"
       && d.body.manifest.palette.since === 1 && d.body.counts.palette === "Deneme", JSON.stringify(d.body.manifest.palette));
    const remote = await import("../../loplop/src/core/remote.ts");
    const read = remote.readManifest({ ...d.body.manifest, release: 1 }, (id: string) => `file:///x/${id}`);
    ok("uygulamanin okuyucusu paleti alir", read.palette?.primary.text === "#2F3B5C" && read.palette.background.start === "#BDE6F6", JSON.stringify(read.palette));
    ok("manifest butun (uygulamanin denetimi)", remote.manifestProblem({ ...d.body.manifest, release: 1 }) === null);
    const two = await j("POST", "/api/palettes", { name: "İkinci", from: "orman-kulubesi" });
    await j("PATCH", `/api/palettes/${two.body.id}`, { status: "live" }, { "If-Match": `"${two.body.updatedAt}"` });
    const after = (await j("GET", "/api/palettes")).body.list;
    ok("tek palet uygulamada: yenisi girince oncekisi taslaga doner",
       after.find((x: { id: string }) => x.id === mk.body.id)?.status === "draft" && after.find((x: { id: string }) => x.id === two.body.id)?.status === "live");
    for (const x of after) await j("DELETE", `/api/palettes/${x.id}`);
    const none = await j("GET", "/api/releases/draft");
    ok("palet yoksa taslakta palet bolumu yok (uygulamanin kendi renkleri)", none.body.manifest.palette === undefined);
  }

  console.log("\n── Şarkı videoları (2026-11-17) ──");
  {
    const film = await upload(path.join(appDir, "src/assets/video/sample-4x3.mp4"), "video/mp4");
    const pic = await upload(path.join(appDir, "src/assets/ui/hand.png"), "image/png");
    const list0 = (await j("GET", "/api/song-videos")).body;
    ok("kategoriler: uygulamanin kendi alti serisi", ["kitchen", "animals", "actions"].every((id) => list0.categories.some((c: { id: string }) => c.id === id)));
    const bad = await j("POST", "/api/song-videos", { title: "Yok", category: "boyle-bir-sey" });
    ok("olmayan kategori reddedilir", bad.status === 400);
    const mk = await j("POST", "/api/song-videos", { title: "Mutfak şarkısı", category: "kitchen" });
    ok("yeni video taslak, eksikleri hata", mk.status === 201 && mk.body.status === "draft"
       && mk.body.issues.some((i: { level: string; text: string }) => i.level === "error" && /Video yüklenmedi/.test(i.text)));
    const wrongKind = await j("PATCH", `/api/song-videos/${mk.body.id}`, { video: pic.id }, { "If-Match": `"${mk.body.updatedAt}"` });
    ok("resim video yerine konamaz", wrongKind.status === 400);
    const filled = await j("PATCH", `/api/song-videos/${mk.body.id}`, { video: film.id, poster: pic.id, durationMs: 62000 }, { "If-Match": `"${mk.body.updatedAt}"` });
    ok("video ve kapak eklendi, yalniz hak onayi eksik", filled.status === 200 && filled.body.issues.filter((i: { level: string }) => i.level === "error").length === 1
       && filled.body.issues.some((i: { text: string }) => /kullanım hakkı/.test(i.text)), JSON.stringify(filled.body.issues));
    const refused = await j("PATCH", `/api/song-videos/${mk.body.id}`, { status: "live" }, { "If-Match": `"${filled.body.updatedAt}"` });
    ok("hak onayi olmadan uygulamaya konamaz", refused.status === 400);
    const stale = await j("PATCH", `/api/song-videos/${mk.body.id}`, { title: "x" }, { "If-Match": `"${mk.body.updatedAt}"` });
    ok("eski surume dayanan yazim reddedilir (If-Match)", stale.status === 409);
    const live = await j("PATCH", `/api/song-videos/${mk.body.id}`, { rights: { confirmed: true, owner: "Biz", note: "" }, status: "live" },
                         { "If-Match": `"${filled.body.updatedAt}"` });
    ok("onaylaninca uygulamaya girer", live.status === 200 && live.body.status === "live", JSON.stringify(live.body.issues));
    const always = await j("POST", "/api/song-videos", { title: "Hep açık" });
    const a2 = await j("PATCH", `/api/song-videos/${always.body.id}`, { video: film.id, poster: pic.id, rights: { confirmed: true, owner: "Biz", note: "" }, status: "live" },
                       { "If-Match": `"${always.body.updatedAt}"` });
    ok("kategorisiz video hep acik (category null)", a2.status === 200 && a2.body.category === null);
    const d = await j("GET", "/api/releases/draft");
    const sv = d.body.manifest.songVideos;
    ok("taslakta iki video, sirasiyla, filmler 'lazy'", sv?.list?.length === 2 && sv.list[0].id === mk.body.id && sv.list[0].category === "kitchen"
       && sv.lazy.length === 1 && sv.lazy[0] === film.id && d.body.counts.songVideos === 2 && d.body.counts.lazyBytes > 0, JSON.stringify(sv));
    const remote = await import("../../loplop/src/core/remote.ts");
    const m = { ...d.body.manifest, release: 1 };
    ok("manifest butun (uygulamanin denetimi)", remote.manifestProblem(m) === null);
    const wanted = remote.wantedFiles(m, new Set()).map((f: { id: string }) => f.id);
    ok("telefon filmi beklemez, kapagi bekler", !wanted.includes(film.id) && wanted.includes(pic.id));
    const read = remote.readManifest(m, (id: string) => `file:///x/${id}`);
    ok("uygulamanin okuyucusu videolari alir", read.songVideos?.length === 2 && read.songVideos[0].poster === `file:///x/${pic.id}`
       && read.songVideos[0].video.asset === film.id && /\/cdn\//.test(read.songVideos[0].video.url), JSON.stringify(read.songVideos?.[0]));
    const usage = await j("GET", `/api/assets/${film.id}/usage`);
    ok("dosyanin kullanimi gorunur (silinemez)", JSON.stringify(usage.body).includes("Şarkı videosu"), JSON.stringify(usage.body).slice(0, 160));
    const pub = await j("POST", "/api/releases", { note: "videolar", channels: ["test"], expect: d.body.fingerprint });
    ok("yayinlandi", pub.status === 200 || pub.status === 201, JSON.stringify(pub.body).slice(0, 200));
    const phone = await j("GET", "/api/app/manifest?build=1&schema=1&channel=test");
    ok("telefona videolar ve dosyalari gider", phone.body.songVideos?.list?.length === 2 && !!phone.body.assets[film.id] && !!phone.body.assets[pic.id]);
    for (const x of (await j("GET", "/api/song-videos")).body.list) await j("DELETE", `/api/song-videos/${x.id}`);
    const none = await j("GET", "/api/releases/draft");
    ok("video yoksa taslakta bolum yok", none.body.manifest.songVideos === undefined);
  }

  console.log("\n── Boyalı haritayı bildiren sürüm (2026-11-03) ──");
  {
    /* LAST: it makes the newest build one that cannot lay rows */
    const now = (await j("GET", "/api/inventory")).body;
    const painted = { ...now, app: { ...now.app, build: 9 }, roadmap: { since: 1, height: 724, band: { top: 205, bottom: 612 },
      tiles: [{ x: 0, w: 652, file: "x.png" }], trail: [[0, 0], [1, 1]], exit: [0, 0], crossings: [],
      stops: [{ id: "kitchen-1", kind: "1", row: "kitchen", x: 1, y: 1 }] } };
    const put = await j("PUT", "/api/inventory", painted);
    const inv9 = (await j("GET", "/api/inventory")).body;
    ok("boyali haritali envanter okunur, haritasi okunmaz", put.status === 200 && inv9.app.build === 9 && inv9.roadmap === undefined);
    const row = await j("POST", "/api/roadmap/slides", { title: "Boyalı" });
    const rm9 = await j("GET", "/api/roadmap");
    ok("cizili harita yoksa: dunya yok, her sira hatali", rm9.body.world === null
       && rm9.body.slides.find((x: { id: string }) => x.id === row.body.id)?.issues.some((i: { text: string }) => /çizili haritayı bildirmedi/.test(i.text)));
    await j("DELETE", `/api/roadmap/slides/${row.body.id}`);
  }
} catch (e) {
  fail++; console.error("  PATLADI", e);
} finally {
  srv.kill();
  await new Promise((r) => srv.once("exit", r));
  await tdb.drop().catch((e) => console.error(`test veritabanı silinemedi: ${(e as Error).message}`));
  rmSync(data, { recursive: true, force: true });
}
console.log(fail ? `\n${fail} HATA` : "\nsunucu: hepsi gecti");
process.exit(fail ? 1 : 0);
