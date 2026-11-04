/**
 * DOWNLOAD PACKS (2026-10-17): the next part of the world, offered -- not
 * pushed.
 *
 * A pack is one or more of the roadmap's new rows (`roadmap.ts`; the
 * server still calls them lands/slides) and
 * everything they need: the categories their stops open, those categories'
 * games, films and words (pictures, recordings), and the songs of their music
 * stops. A release carries a pack as a list of its files and their size; a
 * phone does NOT download it with the rest. When the child reaches the stop
 * named here (`offer_at`), the map shows "a new adventure", and only after a
 * grown-up says yes does the phone download it -- then its rows join the
 * map and the child walks on. A pack the phone has keeps itself up to date.
 *
 *   admin   GET /packs · POST /packs · PATCH/DELETE /packs/:id
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { all, one, run, tx } from "../storage/sql.js";
import { assetMap } from "../storage/files.js";
import { latestInventory } from "./inventory.js";
import { loadCategories } from "./categories.js";
import { loadGames, slug } from "./games.js";
import { setWords, type Issue, type Step } from "./checks.js";
import { drawnOf, slidesOut } from "./roadmap.js";
import { nextStamp, staleFor } from "./vocab.js";

export interface PackRow {
  id: string; title: string; subtitle: string; note: string; offer_at: string | null;
  status: "live" | "draft" | "hidden"; created_at: number; updated_at: number;
}
const row = (id: string) => one<PackRow>("SELECT * FROM packs WHERE id = ?", id);
export const loadPacks = (): Promise<PackRow[]> => all<PackRow>(`SELECT * FROM packs ORDER BY created_at, id COLLATE "C"`);

/** a pack this big is a long wait on a phone's data plan */
export const PACK_WARN_BYTES = 150 * 1024 * 1024;

type SlideOut = Awaited<ReturnType<typeof slidesOut>>[number];

/** everything a set of lands needs: their categories and every file they use */
export async function contentsOf(lands: readonly SlideOut[]) {
  const assets = new Set<string>();
  const add = (id: string | null | undefined) => { if (id) assets.add(id); };
  const cats = (await loadCategories()).filter((c) => lands.some((sl) => sl.stops.some((st) => st.kind !== "music" && st.category === c.id)));
  const games = await loadGames();
  for (const sl of lands)
    for (const st of sl.stops) {
      if (st.kind === "music") { add(st.song); continue; }
      if (!st.category) continue;
      /* a stop's sign is the picture of the game it plays (the row's is its
         category's, added below): it travels with the row (`releases.ts`) */
      const steps = JSON.parse(cats.find((c) => c.id === st.category)?.steps ?? "[]") as Step[];
      for (const s of steps) if (s.kind === "game" && st.steps.includes(s.id)) add(games.find((g) => g.id === s.game)?.icon);
    }
  for (const c of cats) {
    add(c.icon);
    for (const s of JSON.parse(c.steps) as Step[]) if (s.kind === "video") add(s.video);
    for (const w of await setWords(c.set_id)) {
      add(w.icon);
      for (const a of Object.values(w.audio)) add(a?.asset);
    }
  }
  const sizes = { image: 0, audio: 0, video: 0 };
  const rows = await assetMap();
  for (const id of assets) {
    const a = rows.get(id);
    if (a) sizes[a.kind as keyof typeof sizes] += a.size;
  }
  return { categories: cats.map((c) => ({ id: c.id, title: c.title, status: c.status })), assets, sizes,
           bytes: sizes.image + sizes.audio + sizes.video };
}

/**
 * THE ORDER OF PACKS IS THE ORDER OF THE MAP (F02) -- the one place it is
 * written. A pack stands where its first land stands on the roadmap; a pack
 * with no land yet goes last, oldest first. The panel's creation order means
 * nothing to a phone: a phone offers packs front to back and never one whose
 * lands would come after a pack it does not have. (The app sorts the same way
 * on its side, `core/remote.ts` → `readRemote`, so an older server's order
 * cannot stall it either.)
 */
export function packOrder<P extends { id: string; created_at?: number }>(packs: readonly P[], slides: readonly { pack: string | null }[]): P[] {
  const at = (id: string) => { const i = slides.findIndex((s) => s.pack === id); return i < 0 ? Infinity : i; };
  return [...packs].map((p, i) => ({ p, i })).sort((a, b) => at(a.p.id) - at(b.p.id) || a.i - b.i).map((x) => x.p);
}

/** the world's stops in order: the app's own, then every land's */
function stopOrder(slides: readonly SlideOut[]): string[] {
  return [...(drawnOf(latestInventory())?.stops ?? []).map((s) => s.id), ...slides.flatMap((s) => s.stops.map((x) => x.id))];
}

export async function packsOut() {
  const slides = await slidesOut();
  const order = stopOrder(slides);
  const allCats = await loadCategories();
  const packs = packOrder(await loadPacks(), slides);
  const contents = await Promise.all(packs.map((p) => contentsOf(slides.filter((s) => s.pack === p.id))));
  return packs.map((p, i) => {
    const lands = slides.filter((s) => s.pack === p.id);
    const c = contents[i]!;
    const issues: Issue[] = [];
    const err = (text: string) => issues.push({ level: "error", text });
    const warn = (text: string) => issues.push({ level: "warn", text });
    if (!p.title.trim()) err("Adı yok.");
    if (!lands.length) err("Pakette sıra yok: Yol haritası'nda bir sıra yapıp bu pakete bağlayın.");
    for (const l of lands) {
      if (l.status !== "live") err(`"${l.title}" sırası uygulamada değil.`);
      if (l.issues.some((i) => i.level === "error")) err(`"${l.title}" sırasında hata var.`);
    }
    for (const k of c.categories) if (k.status !== "live") err(`"${k.title}" kategorisi uygulamada değil.`);
    const first = lands[0]?.stops[0]?.id;
    const firstAt = first ? order.indexOf(first) : -1;
    if (p.offer_at) {
      const at = order.indexOf(p.offer_at);
      /* the land the offer stop is on must itself reach phones before this pack (F02) */
      const host = slides.find((s) => s.stops.some((x) => x.id === p.offer_at));
      if (at < 0) err(`Sunulacağı durak ("${p.offer_at}") haritada yok.`);
      else if (firstAt >= 0 && at >= firstAt) err("Sunulacağı durak, paketin kendi duraklarından önce olmalı.");
      else if (host && host.status !== "live") err(`Sunulacağı durak "${host.title}" sırasında; o sıra uygulamada değil, çocuk oraya hiç varamaz.`);
    } else warn("Ne zaman sunulacağı seçilmedi: uygulama açılır açılmaz sunulur.");
    if (c.bytes > PACK_WARN_BYTES) warn(`Paket ${Math.round(c.bytes / 1048576)} MB: mobil veride uzun sürer. Videoları küçültmeyi düşünün.`);
    const noVideo = c.categories.length && allCats.filter((x) => c.categories.some((k) => k.id === x.id))
      .flatMap((x) => (JSON.parse(x.steps) as Step[]).filter((s) => s.kind === "video" && !s.video)).length;
    if (noVideo) warn(`${noVideo} video adımı boş: uygulama yerine notu gösterir.`);
    return {
      id: p.id, title: p.title, subtitle: p.subtitle, note: p.note, offerAt: p.offer_at, status: p.status,
      createdAt: p.created_at, updatedAt: p.updated_at,
      lands: lands.map((l) => ({ id: l.id, title: l.title, status: l.status, stops: l.stops.length,
                                 errors: l.issues.filter((i) => i.level === "error").length })),
      categories: c.categories, bytes: c.bytes, sizes: c.sizes, files: c.assets.size, issues,
    };
  });
}

const Patch = z.object({
  title: z.string().trim().min(1).max(60).optional(), subtitle: z.string().max(80).optional(),
  note: z.string().max(600).optional(), offerAt: z.string().max(80).nullable().optional(),
  status: z.enum(["live", "draft", "hidden"]).optional(),
});

export async function packRoutes(app: FastifyInstance) {
  app.get("/packs", async () => packsOut());

  app.post("/packs", (req, reply) => tx(async () => {
    const b = z.object({ title: z.string().trim().min(1).max(60), subtitle: z.string().max(80).default("") }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "Ad gerekli" });
    let id = slug(b.data.title);
    for (let n = 2; await row(id); n++) id = `${slug(b.data.title)}-${n}`;
    const now = Date.now();
    await run("INSERT INTO packs(id, title, subtitle, status, created_at, updated_at) VALUES(?, ?, ?, 'draft', ?, ?)",
        id, b.data.title, b.data.subtitle, now, now);
    reply.code(201);
    return (await packsOut()).find((p) => p.id === id);
  }));

  app.patch("/packs/:id", (req, reply) => tx(async () => {
    const pid = (req.params as { id: string }).id;
    const r = await row(pid);
    if (!r) return reply.code(404).send({ error: "Paket yok" });
    const b = Patch.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: b.error.issues[0]?.message ?? "Geçersiz istek" });
    if (staleFor(req, r.updated_at)) return reply.code(409).send({ code: "STALE", error: "Bu paket başka bir yerde değişti." });
    const d = b.data;
    await run("UPDATE packs SET title = ?, subtitle = ?, note = ?, offer_at = ?, status = ?, updated_at = ? WHERE id = ?",
        d.title ?? r.title, d.subtitle ?? r.subtitle, d.note ?? r.note, d.offerAt !== undefined ? d.offerAt : r.offer_at,
        d.status ?? r.status, nextStamp(r.updated_at), pid);
    const out = (await packsOut()).find((p) => p.id === pid)!;
    if (d.status === "live" && out.issues.some((i) => i.level === "error")) {
      await run("UPDATE packs SET status = ? WHERE id = ?", r.status, pid);
      return reply.code(400).send({ error: "Hatası olan paket uygulamaya konamaz.", issues: out.issues });
    }
    return out;
  }));

  app.delete("/packs/:id", (req, reply) => tx(async () => {
    const pid = (req.params as { id: string }).id;
    if (!(await row(pid))) return reply.code(404).send({ error: "Paket yok" });
    await run("UPDATE road_slides SET pack = NULL WHERE pack = ?", pid);
    await run("DELETE FROM packs WHERE id = ?", pid);
    return { ok: true };
  }));
}
