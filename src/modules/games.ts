/**
 * The game catalog: every game the app shows, and the new ones made from them.
 *
 * A BUILT-IN game is one of the app's own engines (`app-inventory.json`): its
 * name and words are the app's; the panel can set its card picture, status
 * and order (panel-side bookkeeping -- the app's menu is its own code). A NEW
 * game is an OPEN engine (one that draws a word from its picture) with a word
 * set, a name, a card picture and settings of its own. Its words are not
 * copied in: it names a set (`vocab.ts`), and a fix to a word is a fix in
 * every game that plays it.
 *
 *   admin   GET/POST /games · GET/PATCH/DELETE /games/:id · PUT /games/order
 *           GET /games/templates
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { all, one, run, tx } from "../storage/sql.js";
import { getAsset } from "../storage/files.js";
import { latestInventory } from "./inventory.js";
import { checkGame, setWords, templateOf, type Issue } from "./checks.js";
import { nextStamp, staleFor } from "./vocab.js";

export interface GameRow {
  id: string; template: string; builtin: number; name: string; subtitle: string; family: string;
  icon: string | null; set_id: string | null; config: string; status: "live" | "draft" | "hidden";
  ord: number; created_at: number; updated_at: number;
}

export interface GameOut {
  id: string; template: string; builtin: boolean; name: string; subtitle: string; family: string;
  icon: string | null; set: string | null; config: Record<string, unknown>;
  status: "live" | "draft" | "hidden"; order: number; createdAt: number; updatedAt: number;
  /** from the engine: what it is */
  role: string; kind: string; gesture: string; accepts: string | null;
  /** can new games be made from it (an open engine) */
  takesWords: boolean;
  /** its set's words, for showing (never edited through a game) */
  words: { id: string; en: string; tr: string; icon: string | null; color: string }[];
  issues: Issue[];
}

export const loadGames = (): Promise<GameRow[]> => all<GameRow>(`SELECT * FROM games ORDER BY ord, created_at, id COLLATE "C"`);
export const gameRow = (id: string) => one<GameRow>("SELECT * FROM games WHERE id = ?", id);

export const asLike = (g: GameRow) => ({ id: g.id, template: g.template, builtin: !!g.builtin, name: g.name,
                                         status: g.status, set: g.set_id });

export async function out(g: GameRow): Promise<GameOut> {
  const inv = latestInventory();
  const t = templateOf(inv, g.template);
  const [words, issues] = await Promise.all([setWords(g.set_id), checkGame(asLike(g), inv)]);
  return {
    id: g.id, template: g.template, builtin: !!g.builtin, name: g.name, subtitle: g.subtitle, family: g.family,
    icon: g.icon, set: g.set_id, config: JSON.parse(g.config || "{}"), status: g.status, order: g.ord,
    createdAt: g.created_at, updatedAt: g.updated_at,
    role: t?.role ?? "teach", kind: t?.kind ?? "game", gesture: t?.gesture ?? "", accepts: t?.accepts ?? null,
    takesWords: !!t?.open && t.kind === "game",
    words: words.map((w) => ({ id: w.id, en: w.en, tr: w.tr, icon: w.icon, color: w.color })),
    issues,
  };
}

const Create = z.object({
  template: z.string(), name: z.string().trim().min(1).max(60), subtitle: z.string().max(80).default(""),
  family: z.string().max(40).optional(), icon: z.string().max(80).nullable().default(null),
  set: z.string().max(40).nullable().default(null),
  id: z.string().regex(/^[a-z0-9-]{2,40}$/).optional(),
});
const Patch = z.object({
  name: z.string().trim().min(1).max(60).optional(), subtitle: z.string().max(80).optional(),
  icon: z.string().max(80).nullable().optional(), set: z.string().max(40).nullable().optional(),
  family: z.string().max(40).optional(), config: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(["live", "draft", "hidden"]).optional(),
});

export const slug = (s: string) => s.trim().toLowerCase()
  .replace(/[çğıİöşü]/g, (c) => ({ ç: "c", ğ: "g", ı: "i", İ: "i", ö: "o", ş: "s", ü: "u" } as Record<string, string>)[c] ?? c)
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "oyun";

const imageOk = async (id: string | null | undefined) => !id || (await getAsset(id))?.kind === "image";
const setOk = async (id: string | null | undefined) => !id || !!(await one("SELECT id FROM sets WHERE id = ?", id));
/** the games, as the panel shows them */
export const gamesOut = async (rows?: GameRow[]) => Promise.all((rows ?? await loadGames()).map(out));

export async function gameRoutes(app: FastifyInstance) {
  app.get("/games", async () => gamesOut());

  /* what a new game can be made from: the open engines */
  app.get("/games/templates", async () => {
    const inv = latestInventory();
    return gamesOut((await loadGames()).filter((g) => g.builtin && templateOf(inv, g.id)?.open));
  });

  app.get("/games/:id", async (req, reply) => {
    const g = await gameRow((req.params as { id: string }).id);
    return g ? out(g) : reply.code(404).send({ error: "Oyun yok" });
  });

  app.post("/games", (req, reply) => tx(async () => {
    const b = Create.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: b.error.issues[0]?.message ?? "Geçersiz istek" });
    const t = templateOf(latestInventory(), b.data.template);
    if (!t || !t.open || t.kind !== "game")
      return reply.code(400).send({ error: "Şablon, kelimesini dışarıdan alabilen (açık) bir oyun motoru olmalı" });
    if (!(await imageOk(b.data.icon))) return reply.code(400).send({ error: "Kart resmi bir resim dosyası olmalı" });
    if (!(await setOk(b.data.set))) return reply.code(400).send({ error: "Böyle bir kelime seti yok" });
    let id = b.data.id ?? slug(b.data.name);
    for (let n = 2; await gameRow(id); n++) id = `${slug(b.data.name)}-${n}`;
    const now = Date.now();
    const ord = ((await one<{ m: number | null }>("SELECT MAX(ord) AS m FROM games"))?.m ?? -1) + 1;
    await run(`INSERT INTO games(id, template, builtin, name, subtitle, family, icon, set_id, config, status, ord, created_at, updated_at)
         VALUES(?, ?, 0, ?, ?, ?, ?, ?, '{}', 'draft', ?, ?, ?)`,
        id, t.id, b.data.name, b.data.subtitle.trim() || t.subtitle, b.data.family?.trim() || t.family,
        b.data.icon, b.data.set, ord, now, now);
    reply.code(201);
    return out((await gameRow(id))!);
  }));

  app.patch("/games/:id", (req, reply) => tx(async () => {
    const id = (req.params as { id: string }).id;
    const b = Patch.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: b.error.issues[0]?.message ?? "Geçersiz istek" });
    const g = await gameRow(id);
    if (!g) return reply.code(404).send({ error: "Oyun yok" });
    if (staleFor(req, g.updated_at))
      return reply.code(409).send({ code: "STALE", error: "Bu oyun başka bir yerde değişti.", current: await out(g) });
    if (g.builtin && (b.data.set !== undefined || b.data.name || b.data.subtitle || b.data.family || b.data.config))
      return reply.code(400).send({ error: "Hazır bir oyunun adı ve kelimeleri uygulamanın kodunda; yeni bir oyun oluşturun." });
    /* F07: an app game's card is drawn by the app; a release carries only the
       panel's own games, so a new picture here would never reach a phone */
    if (g.builtin && b.data.icon !== undefined && b.data.icon !== g.icon)
      return reply.code(400).send({ error: "Hazır bir oyunun kart resmini uygulama çizer; panelden değiştirilemez." });
    if (!(await imageOk(b.data.icon))) return reply.code(400).send({ error: "Kart resmi bir resim dosyası olmalı" });
    if (!(await setOk(b.data.set))) return reply.code(400).send({ error: "Böyle bir kelime seti yok" });
    const n: GameRow = {
      ...g, name: b.data.name ?? g.name, subtitle: b.data.subtitle ?? g.subtitle, family: b.data.family ?? g.family,
      icon: b.data.icon !== undefined ? b.data.icon : g.icon, set_id: b.data.set !== undefined ? b.data.set : g.set_id,
      config: b.data.config ? JSON.stringify(b.data.config) : g.config, status: b.data.status ?? g.status,
    };
    /* a game that cannot go into a release is not called "in the app": the
       release would leave it out without a word (like packs, mascots and
       categories, an error keeps it a draft) */
    if (n.status === "live" && !g.builtin) {
      const issues = await checkGame(asLike(n), latestInventory());
      if (issues.some((i) => i.level === "error"))
        return reply.code(400).send({ error: `Uygulamaya konamaz: ${issues.filter((i) => i.level === "error").map((i) => i.text).join(" ")}`, issues });
    }
    await run(`UPDATE games SET name = ?, subtitle = ?, family = ?, icon = ?, set_id = ?, config = ?, status = ?, updated_at = ?
         WHERE id = ?`, n.name, n.subtitle, n.family, n.icon, n.set_id, n.config, n.status, nextStamp(g.updated_at), id);
    return out((await gameRow(id))!);
  }));

  app.delete("/games/:id", (req, reply) => tx(async () => {
    const id = (req.params as { id: string }).id;
    const g = await gameRow(id);
    if (!g) return reply.code(404).send({ error: "Oyun yok" });
    if (g.builtin) return reply.code(400).send({ error: "Hazır bir oyun silinemez; gizleyebilirsiniz." });
    const used = (await all<{ id: string; steps: string }>("SELECT id, steps FROM categories"))
      .filter((c) => (JSON.parse(c.steps) as { kind: string; game?: string }[]).some((s) => s.kind === "game" && s.game === id));
    if (used.length) return reply.code(400).send({ error: `Bu oyun şu kategorilerde: ${used.map((c) => c.id).join(", ")}` });
    await run("DELETE FROM games WHERE id = ?", id);
    return { ok: true };
  }));

  app.put("/games/order", (req, reply) => tx(async () => {
    const b = z.object({ ids: z.array(z.string()) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "Geçersiz istek" });
    const pos = new Map(b.data.ids.map((id, i) => [id, i]));
    for (const g of await loadGames()) await run("UPDATE games SET ord = ? WHERE id = ?", pos.get(g.id) ?? b.data.ids.length + g.ord, g.id);
    return gamesOut();
  }));
}
