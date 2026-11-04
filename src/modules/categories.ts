/**
 * Categories: a series -- its word set, and the flow the child walks through
 * (scene or film, game, scene or film, game, ..., the end).
 *
 * The app's own categories (`app-inventory.json`) are listed here BUILT-IN and
 * read-only: the app plays them from its bundle. A NEW category is the
 * server's: a word set (`vocab.ts`), films (uploaded assets), live scenes the
 * app has, and games from the catalog -- every game in it plays the
 * category's set (rule 11: a series is one set of words across its games).
 *
 * Every answer carries `issues` (`checks.ts`). Status here is the EDITOR'S
 * intent; what phones see is decided by publishing (`releases.ts`), which
 * refuses a live category with an error.
 *
 *   admin   GET/POST /categories · GET/PATCH/DELETE /categories/:id
 *           PUT /categories/order · GET /categories/scenes
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { all, one, run, tx } from "../storage/sql.js";
import { assetMap, getAsset } from "../storage/files.js";
import { latestInventory } from "./inventory.js";
import { checkCategory, setWords, type Issue, type Step } from "./checks.js";
import { asLike, loadGames, slug } from "./games.js";
import { nextStamp, staleFor } from "./vocab.js";

export interface CategoryRow {
  id: string; builtin: number; title: string; subtitle: string; icon: string | null; set_id: string | null;
  steps: string; status: "live" | "draft" | "hidden"; ord: number; created_at: number; updated_at: number;
}

export interface CategoryOut {
  id: string; builtin: boolean; title: string; subtitle: string; icon: string | null; set: string | null;
  status: "live" | "draft" | "hidden"; order: number; steps: Step[]; createdAt: number; updatedAt: number;
  words: { id: string; en: string; tr: string; icon: string | null; color: string }[];
  issues: Issue[];
  /** about what a phone downloads for it, in bytes: its card, films, its
   *  words' pictures and recordings -- as the release would carry them */
  download: number;
}

export const loadCategories = (): Promise<CategoryRow[]> => all<CategoryRow>(`SELECT * FROM categories ORDER BY ord, created_at, id COLLATE "C"`);
const row = (id: string) => one<CategoryRow>("SELECT * FROM categories WHERE id = ?", id);

export const asCat = (c: CategoryRow) => ({ id: c.id, builtin: !!c.builtin, title: c.title, set: c.set_id,
                                            steps: JSON.parse(c.steps) as Step[] });

/** the bytes a phone would fetch for this category (see `CategoryOut.download`) */
async function downloadOf(c: CategoryRow, steps: Step[]): Promise<number> {
  const ids = new Set<string>();
  if (c.icon) ids.add(c.icon);
  for (const s of steps) if (s.kind === "video" && s.video) ids.add(s.video);
  for (const w of await setWords(c.set_id)) {
    if (w.icon) ids.add(w.icon);
    for (const a of Object.values(w.audio)) if (a?.asset) ids.add(a.asset);
  }
  const assets = await assetMap();
  let n = 0;
  for (const id of ids) n += assets.get(id)?.size ?? 0;
  return n;
}

export async function catOut(c: CategoryRow): Promise<CategoryOut> {
  const like = asCat(c);
  const games = (await loadGames()).map(asLike);
  const [words, issues, download] = await Promise.all([
    setWords(c.set_id), checkCategory(like, latestInventory(), games), c.builtin ? 0 : downloadOf(c, like.steps)]);
  return {
    id: c.id, builtin: !!c.builtin, title: c.title, subtitle: c.subtitle, icon: c.icon, set: c.set_id,
    status: c.status, order: c.ord, steps: like.steps, createdAt: c.created_at, updatedAt: c.updated_at,
    words: words.map((w) => ({ id: w.id, en: w.en, tr: w.tr, icon: w.icon, color: w.color })),
    issues, download,
  };
}

const id = z.string().regex(/^[a-z0-9_-]{1,40}$/, "adım kimliği: küçük harf, rakam, - ve _");
const note = z.string().max(600).default("");
const StepIn = z.discriminatedUnion("kind", [
  z.object({ id, kind: z.literal("video"), video: z.string().max(80).nullable().default(null), note,
             fit: z.enum(["cover", "contain"]).default("cover") }),
  z.object({ id, kind: z.literal("scene"), scene: z.string().max(40).default(""), note }),
  z.object({ id, kind: z.literal("game"), game: z.string().max(40).nullable().default(null), teach: z.boolean().default(false) }),
  z.object({ id, kind: z.literal("finish") }),
]);
const steps = z.array(StepIn).max(20);
const Create = z.object({
  title: z.string().trim().min(1).max(60), subtitle: z.string().max(80).default(""),
  icon: z.string().max(80).nullable().default(null), set: z.string().max(40).nullable().default(null),
  steps: steps.optional(),
});
const Patch = z.object({
  title: z.string().trim().min(1).max(60).optional(), subtitle: z.string().max(80).optional(),
  icon: z.string().max(80).nullable().optional(), set: z.string().max(40).nullable().optional(),
  steps: steps.optional(), status: z.enum(["live", "draft", "hidden"]).optional(),
});

/**
 * A series starts as its skeleton: a film, three games with a film between,
 * the end. The games are filled in with what the app can play for words it
 * has never seen (its OPEN engines): the first introduces the words with
 * cards, the second practises them, the third asks again without cards --
 * there is no open measuring engine yet. Any of them can be changed.
 */
const skeleton = async (): Promise<Step[]> => {
  const games = await loadGames();
  const open = (id: string) => games.some((g) => g.id === id && g.builtin) ? id : null;
  const teach = open("drag"), find = open("pop");
  return [
    { id: "open", kind: "video", video: null, note: "", fit: "cover" },
    { id: "game-1", kind: "game", game: teach, teach: true },
    { id: "to-2", kind: "video", video: null, note: "", fit: "cover" },
    { id: "game-2", kind: "game", game: find ?? teach, teach: false },
    { id: "to-3", kind: "video", video: null, note: "", fit: "cover" },
    { id: "game-3", kind: "game", game: teach, teach: false },
    { id: "done", kind: "finish" },
  ];
};

async function badRefs(icon: string | null | undefined, set: string | null | undefined, st: Step[] | undefined): Promise<string | null> {
  if (icon && (await getAsset(icon))?.kind !== "image") return "Kart resmi bir resim dosyası olmalı";
  if (set && !(await one("SELECT id FROM sets WHERE id = ?", set))) return "Böyle bir kelime seti yok";
  for (const s of st ?? [])
    if (s.kind === "video" && s.video && (await getAsset(s.video))?.kind !== "video") return `"${s.id}" adımının dosyası bir video değil`;
  return null;
}

/** the categories, as the panel shows them */
export const categoriesOut = async () => Promise.all((await loadCategories()).map(catOut));

export async function categoryRoutes(app: FastifyInstance) {
  app.get("/categories", async () => categoriesOut());
  app.get("/categories/scenes", async () => latestInventory()?.scenes ?? []);

  app.get("/categories/:id", async (req, reply) => {
    const c = await row((req.params as { id: string }).id);
    return c ? catOut(c) : reply.code(404).send({ error: "Kategori yok" });
  });

  app.post("/categories", (req, reply) => tx(async () => {
    const b = Create.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: b.error.issues[0]?.message ?? "Geçersiz istek" });
    const e = await badRefs(b.data.icon, b.data.set, b.data.steps as Step[] | undefined);
    if (e) return reply.code(400).send({ error: e });
    let cid = slug(b.data.title);
    for (let n = 2; await row(cid); n++) cid = `${slug(b.data.title)}-${n}`;
    const now = Date.now();
    const ord = ((await one<{ m: number | null }>("SELECT MAX(ord) AS m FROM categories"))?.m ?? -1) + 1;
    await run(`INSERT INTO categories(id, builtin, title, subtitle, icon, set_id, steps, status, ord, created_at, updated_at)
         VALUES(?, 0, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
        cid, b.data.title, b.data.subtitle.trim(), b.data.icon, b.data.set,
        JSON.stringify((b.data.steps as Step[] | undefined) ?? await skeleton()), ord, now, now);
    reply.code(201);
    return catOut((await row(cid))!);
  }));

  app.patch("/categories/:id", (req, reply) => tx(async () => {
    const cid = (req.params as { id: string }).id;
    const b = Patch.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: b.error.issues[0]?.message ?? "Geçersiz istek" });
    const c = await row(cid);
    if (!c) return reply.code(404).send({ error: "Kategori yok" });
    if (c.builtin) return reply.code(400).send({ error: "Bu kategori uygulamanın kendi kategorisi; uygulamada değişir." });
    if (staleFor(req, c.updated_at))
      return reply.code(409).send({ code: "STALE", error: "Bu kategori başka bir yerde değişti.", current: await catOut(c) });
    const e = await badRefs(b.data.icon, b.data.set, b.data.steps as Step[] | undefined);
    if (e) return reply.code(400).send({ error: e });
    const n: CategoryRow = {
      ...c, title: b.data.title ?? c.title, subtitle: b.data.subtitle ?? c.subtitle,
      icon: b.data.icon !== undefined ? b.data.icon : c.icon, set_id: b.data.set !== undefined ? b.data.set : c.set_id,
      steps: b.data.steps ? JSON.stringify(b.data.steps) : c.steps, status: b.data.status ?? c.status,
    };
    const issues = (await catOut(n)).issues;
    if (n.status === "live" && issues.some((i) => i.level === "error"))
      return reply.code(400).send({ error: "Hatası olan bir kategori uygulamaya hazır işaretlenemez.", issues });
    await run(`UPDATE categories SET title = ?, subtitle = ?, icon = ?, set_id = ?, steps = ?, status = ?, updated_at = ? WHERE id = ?`,
        n.title, n.subtitle, n.icon, n.set_id, n.steps, n.status, nextStamp(c.updated_at), cid);
    return catOut((await row(cid))!);
  }));

  app.delete("/categories/:id", (req, reply) => tx(async () => {
    const cid = (req.params as { id: string }).id;
    const c = await row(cid);
    if (!c) return reply.code(404).send({ error: "Kategori yok" });
    if (c.builtin) return reply.code(400).send({ error: "Uygulamanın kendi kategorisi silinemez." });
    await run("DELETE FROM categories WHERE id = ?", cid);
    return { ok: true };
  }));

  app.put("/categories/order", (req, reply) => tx(async () => {
    const b = z.object({ ids: z.array(z.string()) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "Geçersiz istek" });
    const pos = new Map(b.data.ids.map((x, i) => [x, i]));
    for (const c of await loadCategories()) await run("UPDATE categories SET ord = ? WHERE id = ?", pos.get(c.id) ?? b.data.ids.length + c.ord, c.id);
    return categoriesOut();
  }));
}
