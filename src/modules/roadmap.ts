/**
 * THE ROADMAP'S NEW ROWS (the panel's "Yol Haritası"; drawn map, 2026-11-03).
 *
 * The app's only map is DRAWN by code (`../loplop/src/core/meadowmap.ts`):
 * rows of stops, one row per category, two rows a page. The app ships its own
 * six rows (24 stops, in its bundle and its inventory). A ROW made here is the
 * next category on the map: up to `stopsPerRow` stops -- the category's game
 * steps as stops 1, 2, 3 and, last, an optional music stop. A release carries
 * the live rows, in order, and a phone lays them after its own: the map grows
 * to the right, no app update. The contract is the app's
 * `docs/YOL-HARITASI-CIZILI.md`.
 *
 * A row is still a `road_slides` row (the table and its ids stay: no
 * migration). Its painted-map columns -- image, w, entry, land, trail, and a
 * stop's x/y -- are no longer read or written; an old row keeps them, unread.
 *
 * WHAT KEEPS IT ONE MAP
 *   - append only: a row goes after the app's rows and after the row before
 *     it; nothing before it moves, so every stop keeps its place
 *   - a chain: a row is published only if every row before it is -- a row
 *     with no way to it would be an island
 *   - stop ids are forever: a child's progress is kept by them on the phone.
 *     Taking away a stop that production phones have is said out loud.
 *
 *   admin   GET /roadmap · POST /roadmap/slides · PATCH/DELETE /roadmap/slides/:id
 *           PUT /roadmap/order
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { all, one, run, tx } from "../storage/sql.js";
import { assetMap } from "../storage/files.js";
import { latestInventory, type DrawnRoad, type InventoryDoc } from "./inventory.js";
import { asCat, loadCategories } from "./categories.js";
import { asLike, loadGames, slug } from "./games.js";
import { checkCategory, setWords, templateOf, type Issue, type Step } from "./checks.js";
import { nextStamp, staleFor } from "./vocab.js";

export type StopKind = "1" | "2" | "3" | "music";
/** a stop opens a run of a category's steps -- or, a music stop, plays its song */
export interface SlideStop { id: string; kind: StopKind; category: string; steps: string[]; song?: string | null }
export interface SlideRow {
  id: string; title: string; stops: string; status: "live" | "draft" | "hidden"; ord: number;
  created_at: number; updated_at: number; pack: string | null;
  /* the painted map's columns, kept in the table and no longer read:
     image, w, entry, land, trail */
}
export interface Slide {
  id: string; title: string; stops: SlideStop[]; status: SlideRow["status"]; order: number;
  createdAt: number; updatedAt: number;
  /** the download pack it travels in, or null: downloaded with everything else */
  pack: string | null;
}

export const loadSlides = (): Promise<SlideRow[]> => all<SlideRow>(`SELECT * FROM road_slides ORDER BY ord, created_at, id COLLATE "C"`);
const row = (id: string) => one<SlideRow>("SELECT * FROM road_slides WHERE id = ?", id);
/** a stop as stored: an old row's stop still has the painted map's x/y -- not passed on */
const asStop = (x: SlideStop & { x?: unknown; y?: unknown }): SlideStop => {
  const { x: _x, y: _y, ...st } = x;
  return { ...st, category: st.category ?? "", steps: Array.isArray(st.steps) ? st.steps : [] };
};
export const asSlide = (r: SlideRow): Slide => ({
  id: r.id, title: r.title, stops: (JSON.parse(r.stops) as SlideStop[]).map(asStop), status: r.status, order: r.ord,
  createdAt: r.created_at, updatedAt: r.updated_at, pack: r.pack ?? null,
});

/** the app's map, if its build draws one: the only map rows can be laid on */
export const drawnOf = (inv: InventoryDoc | null): DrawnRoad | null =>
  inv?.roadmap?.kind === "drawn" ? inv.roadmap : null;

/* ── the checks ───────────────────────────────────────────────────────────── */

/** a row's game stops are its category's games in order: 1, 2, 3 */
const GAME_KINDS: StopKind[] = ["1", "2", "3"];

export async function checkSlide(sl: Slide, index: number, slides: Slide[], inv: InventoryDoc | null,
                                 published: Map<string, PublishedStop>): Promise<Issue[]> {
  const assets = await assetMap();
  const out: Issue[] = [];
  const err = (text: string) => out.push({ level: "error", text });
  const warn = (text: string) => out.push({ level: "warn", text });
  const road = drawnOf(inv);
  if (!road) err("Uygulama çizili haritayı bildirmedi (envanterde `roadmap.kind: \"drawn\"` yok): bu sürüm yeni sıra alamaz.");
  if (!sl.title.trim()) err("Adı yok.");
  /*
   * THE SHAPE OF A ROW: one category, its games as stops 1, 2, 3 in order
   * (as many as there are, none skipped), at most one music stop, last. The
   * phone draws a row as exactly that -- a stop "2" before a "1", or a second
   * category on one row, has no place on the drawn map.
   */
  const lessons = sl.stops.filter((s) => s.kind !== "music");
  const per = road?.stopsPerRow ?? 4;
  if (!lessons.length) err("Oyun durağı yok: bir sıra en az bir oyun açar.");
  if (sl.stops.length > per) err(`${sl.stops.length} durak var; bir sırada en çok ${per} durak olur (oyunlar 1 · 2 · 3 ve müzik).`);
  const rowCats = [...new Set(lessons.map((s) => s.category).filter(Boolean))];
  if (rowCats.length > 1) err(`Bir sıra tek bir kategoridir; bu sırada ${rowCats.length} kategori var (${rowCats.join(", ")}).`);
  lessons.forEach((st, i) => {
    const want = GAME_KINDS[i];
    if (!want) return;   /* more than three games: said by the count above */
    if (st.kind !== want) err(`${sl.stops.indexOf(st) + 1}. durak: türü "${st.kind}", sırada "${want}" olmalı (oyun durakları 1 · 2 · 3 sırasıyla, atlamadan).`);
  });
  if (lessons.length > GAME_KINDS.length) err(`${lessons.length} oyun durağı var; bir sırada en çok ${GAME_KINDS.length}.`);
  const music = sl.stops.filter((s) => s.kind === "music");
  if (music.length > 1) err("Bir sırada en çok bir müzik durağı olur.");
  if (music.length && sl.stops[sl.stops.length - 1]?.kind !== "music") err("Müzik durağı sıranın en sonunda olmalı.");
  const cats = await loadCategories();
  const games = (await loadGames()).map(asLike);
  /* the songs of "Müzik" in the app, by stop; and which categories have an error */
  const liveSongs = new Map((await all<{ stop: string; chosen: string | null }>("SELECT stop, chosen FROM songs WHERE status = 'live'"))
    .map((r) => [r.stop, r.chosen]));
  const broken = new Set<string>();
  for (const c of cats)
    if (sl.stops.some((st) => st.category === c.id) && (await checkCategory(asCat(c), inv, games)).some((x) => x.level === "error"))
      broken.add(c.id);
  const ids = new Set<string>([...(road?.stops ?? []).map((s) => s.id),
                               ...slides.slice(0, index).flatMap((x) => x.stops.map((s) => s.id))]);
  sl.stops.forEach((st, i) => {
    const at = `${i + 1}. durak`;
    if (ids.has(st.id)) err(`${at}: "${st.id}" kimliği başka bir durakta da var.`);
    ids.add(st.id);
    if (st.kind === "music") {
      /* a music stop plays its song to its end; it opens no category */
      /* the song may come from the panel's "Müzik" instead (one live song per stop) */
      const fromSongs = liveSongs.get(st.id);
      if (!st.song && fromSongs) { /* a song from Müzik */ }
      else if (!st.song) err(`${at}: müzik durağının şarkısı yok: Müzik sayfasından yapın ya da burada yükleyin.`);
      else if (assets.get(st.song)?.kind !== "audio") err(`${at}: şarkı bir ses dosyası değil.`);
    }
    if (st.kind === "music") return;
    const c = cats.find((x) => x.id === st.category);
    if (!c) { err(`${at}: kategori seçilmedi.`); return; }
    if (c.builtin) err(`${at}: "${c.title}" uygulamanın kendi kategorisi; haritada zaten yeri var.`);
    else if (c.status !== "live") err(`${at}: "${c.title}" uygulamada değil (Kategoriler → Kontrol ve yayın).`);
    else if (broken.has(c.id)) err(`${at}: "${c.title}" kategorisinde hata var.`);
    const steps = JSON.parse(c.steps) as Step[];
    if (!st.steps.length) err(`${at}: hangi adımları açacağı seçilmedi.`);
    for (const id of st.steps) if (!steps.some((s) => s.id === id)) err(`${at}: "${id}" adımı "${c.title}" kategorisinde yok.`);
    if (!st.steps.some((id) => steps.find((s) => s.id === id)?.kind === "game")) warn(`${at}: hiç oyun açmıyor.`);
  });
  /*
   * F05 -- TEACHING BEFORE PRACTICE, ALONG THE MAP. A category's own order can
   * be right while the map plays it backwards: "Bul bakalım" on the first stop,
   * the cards that introduce the words on the next. Walk the map in the order
   * a child does (every row before this one, then this one stop by stop, each
   * stop's steps in its category's order): a step that introduces words with
   * cards marks them taught; a practice step whose words are not all taught
   * yet is refused, at its stop. The app's own words are taught on the app's
   * own rows, which every child walks first; a set taught by ANOTHER category
   * earlier counts too (a review is not refused). Rows of packs come in map
   * order on a phone (`packOrder`), so an earlier pack's lesson is there first.
   */
  const builtinWords = (await all<{ id: string }>("SELECT id FROM words WHERE builtin = 1")).map((r) => r.id);
  const taught = new Set<string>(builtinWords);
  const wordsOf = new Map<string, string[]>();
  const walk = async (stops: SlideStop[], report: boolean) => {
    for (const [i, st] of stops.entries()) {
      if (st.kind === "music") continue;
      const c = cats.find((x) => x.id === st.category);
      if (!c || c.builtin) continue;
      if (!wordsOf.has(c.id)) wordsOf.set(c.id, (await setWords(c.set_id)).map((w) => w.id));
      const words = wordsOf.get(c.id)!;
      for (const s of (JSON.parse(c.steps) as Step[]).filter((x) => st.steps.includes(x.id))) {
        if (s.kind !== "game" || !s.game) continue;
        const g = games.find((x) => x.id === s.game);
        const t = g ? templateOf(inv, g.template) : null;
        if (!g || !t) continue;
        if (s.teach && t.teach) { words.forEach((w) => taught.add(w)); continue; }
        if (!report || !t.open || t.teach) continue;
        const missing = words.filter((w) => !taught.has(w));
        if (missing.length)
          err(`${i + 1}. durak: "${g.name}" kelimeleri tanıtmaz, ama ${missing.join(", ")} haritada daha önce hiçbir durakta kartla tanıtılmadı. Öğreten adımı (ör. “Lili'ye ver”, “önce kartla tanıtsın”) daha önceki bir durağa koyun.`);
      }
    }
  };
  for (const before of slides.slice(0, index)) await walk(before.stops, false);
  await walk(sl.stops, true);

  /* every game of its category should be somewhere on the row */
  for (const cid of new Set(sl.stops.filter((s) => s.kind !== "music").map((s) => s.category))) {
    const c = cats.find((x) => x.id === cid);
    if (!c) continue;
    const on = new Set(sl.stops.filter((s) => s.category === cid).flatMap((s) => s.steps));
    const left = (JSON.parse(c.steps) as Step[]).filter((s) => s.kind === "game" && !on.has(s.id)).map((s) => s.id);
    if (left.length) warn(`"${c.title}" kategorisinin ${left.join(", ")} oyunu hiçbir durakta yok.`);
  }
  /* a stop phones already have is a child's place: taking it away moves them */
  const gone = [...published.keys()].filter((id) => id.startsWith(`${sl.id}-`) && !sl.stops.some((s) => s.id === id));
  if (gone.length) warn(`Üretimde yayında olan durak kaldırılmış: ${gone.join(", ")}. O duraktaki çocuklar en ileri bitirdikleri durağa döner.`);
  /*
   * F04 + review (2026-10-19): A PHONE REMEMBERS FINISHED STOPS BY ID, so an
   * id that phones have may only go on opening the SAME LESSON. The lesson is
   * the stop's signature: its category, the game steps it opens and the game
   * each of them plays. Another signature under a published id would hand the
   * new lesson the old one's tick: refused -- the stop needs a new id (the
   * panel gives one when the category or the games change, and offers "yeni
   * ders" for a change made inside the category). A new title, film or
   * scene keeps the id and the children's progress.
   */
  sl.stops.forEach((st, i) => {
    const was = published.get(st.id);
    if (!was) return;
    const kindNow = st.kind === "music" ? "music" : "lesson", kindWas = was.kind === "music" ? "music" : "lesson";
    const fix = "Durağa yeni bir kimlik verin (panelde “yeni ders”): eski ilerleme eski derste kalır.";
    if (kindNow !== kindWas || (kindNow === "lesson" && was.category !== st.category)) {
      err(`${i + 1}. durak: "${st.id}" üretimde başka bir dersi açıyordu; bitirenlerin tiki yeni derse geçerdi. ${fix}`);
      return;
    }
    if (kindNow !== "lesson") return;
    const now = lessonOf(st, cats);
    if (now !== was.lesson && was.lesson !== null)
      err(`${i + 1}. durak: "${st.id}" üretimde başka oyunları oynatıyordu (${was.lesson || "—"} → ${now || "—"}); onu bitirmiş çocuklar yeni dersi bitirmiş sayılırdı. ${fix}`);
  });
  return out;
}

export interface PublishedStop { kind: string; category: string; steps: string[]; lesson: string | null }

/** a stop's lesson: the game steps it opens, in its category's order, each with the game it plays
 *  ("game-1=drag,game-2=pop"). Films and scenes are not part of it: changing them keeps the lesson. */
export function lessonOf(st: { category: string; steps: string[] }, cats: { id: string; steps: string }[]): string {
  const c = cats.find((x) => x.id === st.category);
  const steps = c ? (JSON.parse(c.steps) as Step[]) : [];
  return steps.filter((s) => s.kind === "game" && st.steps.includes(s.id))
    .map((s) => `${s.id}=${(s as Extract<Step, { kind: "game" }>).game ?? ""}`).join(",");
}

/** the stops production phones have (the production channel's release), by id, with the lesson each played */
export async function publishedStops(): Promise<Map<string, PublishedStop>> {
  const h = (await one<{ release_id: number | null }>("SELECT release_id FROM channels WHERE name = 'production'"))?.release_id;
  if (!h) return new Map();
  const r = await one<{ manifest: string }>("SELECT manifest FROM releases WHERE id = ?", h);
  const m = r ? (JSON.parse(r.manifest) as {
    roadmap?: { slides: { stops: { id: string; kind?: string; category?: string; steps?: string[] }[] }[] };
    categories?: { id: string; steps: unknown[] }[] }) : null;
  /* the categories as that release froze them: what the stop REALLY played */
  const cats = (m?.categories ?? []).map((c) => ({ id: c.id, steps: JSON.stringify(c.steps ?? []) }));
  return new Map((m?.roadmap?.slides ?? []).flatMap((s) => s.stops.map((x) => {
    const steps = Array.isArray(x.steps) ? x.steps : [];
    const category = String(x.category ?? "");
    /* a category missing from that release (cannot be): nothing to compare */
    const lesson = x.kind === "music" || !cats.some((c) => c.id === category) ? null : lessonOf({ category, steps }, cats);
    return [x.id, { kind: String(x.kind ?? ""), category, steps, lesson }] as const;
  })));
}

export async function slidesOut() {
  const inv = latestInventory();
  const slides = (await loadSlides()).map(asSlide);
  const pub = await publishedStops();
  const checked = await Promise.all(slides.map((sl, i) => checkSlide(sl, i, slides, inv, pub)));
  return slides.map((sl, i) => {
    const issues = checked[i]!;
    /* the chain: a row is published only if every row before it is */
    const gap = slides.slice(0, i).find((x) => x.status !== "live");
    if (sl.status === "live" && gap) issues.unshift({ level: "error", text: `Önceki sıra ("${gap.title}") uygulamada değil: buraya yol yok.` });
    /* a row with no pack is downloaded with everything; after a row that
       waits for a pack it would be an island on a phone without that pack */
    const packed = slides.slice(0, i).find((x) => x.pack);
    if (!sl.pack && packed) issues.unshift({ level: "error", text: `"${packed.title}" bir indirme paketinde; ondan sonraki sıra da bir pakette olmalı (paketsiz telefonda yol kopuk kalırdı).` });
    const prevPack = slides[i - 1]?.pack ?? null;
    if (sl.pack && prevPack && prevPack !== sl.pack && slides.slice(0, i - 1).some((x) => x.pack === sl.pack))
      issues.unshift({ level: "error", text: "Bir paketin sıraları haritada art arda olmalı." });
    return { ...sl, category: categoryOf(sl), issues };
  });
}

/** a row's category: the one its game stops open (a row is one category), or null */
export const categoryOf = (sl: { stops: readonly SlideStop[] }): string | null =>
  sl.stops.find((s) => s.kind !== "music" && s.category)?.category ?? null;

/**
 * The app's own map as the panel previews it: its rows in order, each with
 * its category's title and its stops' kinds -- the rows a new one goes after.
 * Null when the newest build does not draw the map.
 */
export async function worldOut() {
  const inv = latestInventory();
  const r = drawnOf(inv);
  if (!r) return null;
  const rows: { row: string; title: string; stops: { id: string; kind: string }[] }[] = [];
  for (const st of r.stops) {
    let at = rows.find((x) => x.row === st.row);
    if (!at) rows.push(at = { row: st.row, title: inv?.categories.find((c) => c.id === st.row)?.title ?? st.row, stops: [] });
    at.stops.push({ id: st.id, kind: st.kind });
  }
  return { kind: r.kind, since: r.since, stopsPerRow: r.stopsPerRow, stops: r.stops, rows };
}

/* ── routes ───────────────────────────────────────────────────────────────── */

/*
 * The painted map's fields (a row's image, w, entry, land, trail; a stop's
 * x, y) are still ACCEPTED, so an older panel tab saving them is not refused,
 * and never stored: z.object drops a stop's x/y, the row's are not written.
 */
const StopIn = z.object({ id: z.string().regex(/^[a-z0-9-]{1,60}$/, "durak kimliği: küçük harf, rakam, -"),
  kind: z.enum(["1", "2", "3", "music"]), x: z.number().optional(), y: z.number().optional(),
  category: z.string().max(60).default(""), steps: z.array(z.string().max(40)).max(12).default([]),
  song: z.string().max(80).nullable().optional() }).transform(({ x: _x, y: _y, ...st }) => st);
const Patch = z.object({
  title: z.string().trim().min(1).max(60).optional(),
  image: z.string().max(80).nullable().optional(), w: z.number().optional(), entry: z.enum(["walk", "boat"]).optional(),
  land: z.number().int().nullable().optional(), trail: z.array(z.unknown()).optional(),
  stops: z.array(StopIn).max(16).optional(), status: z.enum(["live", "draft", "hidden"]).optional(),
  pack: z.string().max(60).nullable().optional(),
});

export async function roadmapRoutes(app: FastifyInstance) {
  app.get("/roadmap", async () => ({ world: await worldOut(), slides: await slidesOut() }));

  app.post("/roadmap/slides", (req, reply) => tx(async () => {
    const b = z.object({ title: z.string().trim().min(1).max(60) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "Ad gerekli" });
    let id = slug(b.data.title);
    for (let n = 2; await row(id); n++) id = `${slug(b.data.title)}-${n}`;
    const now = Date.now();
    const ord = ((await one<{ m: number | null }>("SELECT MAX(ord) AS m FROM road_slides"))?.m ?? -1) + 1;
    await run(`INSERT INTO road_slides(id, title, status, ord, created_at, updated_at) VALUES(?, ?, 'draft', ?, ?, ?)`,
        id, b.data.title, ord, now, now);
    reply.code(201);
    return (await slidesOut()).find((s) => s.id === id);
  }));

  app.patch("/roadmap/slides/:id", (req, reply) => tx(async () => {
    const sid = (req.params as { id: string }).id;
    const r = await row(sid);
    if (!r) return reply.code(404).send({ error: "Sıra yok" });
    const b = Patch.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: b.error.issues[0]?.message ?? "Geçersiz istek" });
    if (staleFor(req, r.updated_at)) return reply.code(409).send({ code: "STALE", error: "Bu sıra başka bir yerde değişti." });
    if (b.data.pack && !(await one("SELECT id FROM packs WHERE id = ?", b.data.pack))) return reply.code(400).send({ error: "Böyle bir paket yok" });
    const d = b.data;
    await run(`UPDATE road_slides SET title = ?, stops = ?, status = ?, pack = ?, updated_at = ? WHERE id = ?`,
        d.title ?? r.title, d.stops ? JSON.stringify(d.stops) : r.stops, d.status ?? r.status, d.pack !== undefined ? d.pack : r.pack,
        nextStamp(r.updated_at), sid);
    const out = (await slidesOut()).find((s) => s.id === sid)!;
    if (d.status === "live" && out.issues.some((i) => i.level === "error")) {
      await run("UPDATE road_slides SET status = ? WHERE id = ?", r.status, sid);
      return reply.code(400).send({ error: "Hatası olan sıra uygulamaya konamaz.", issues: out.issues });
    }
    return out;
  }));

  app.delete("/roadmap/slides/:id", (req, reply) => tx(async () => {
    const sid = (req.params as { id: string }).id;
    if (!(await row(sid))) return reply.code(404).send({ error: "Sıra yok" });
    await run("DELETE FROM road_slides WHERE id = ?", sid);
    return { ok: true };
  }));

  app.put("/roadmap/order", (req, reply) => tx(async () => {
    const b = z.object({ ids: z.array(z.string()) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "Geçersiz istek" });
    for (const [i, id] of b.data.ids.entries()) await run("UPDATE road_slides SET ord = ? WHERE id = ?", i, id);
    return slidesOut();
  }));
}
