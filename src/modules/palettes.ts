/**
 * COLOUR PALETTES (the panel's "Renk paleti", 2026-10-29): the app's chrome
 * colours, as content.
 *
 * The app draws its chrome -- the screen behind it, cards, the main and the
 * second button, a small accent -- in named roles (`loplop/src/core/
 * palette.ts`); scenes, words and mascots keep their own colours. A PALETTE
 * here fills every role; at most one is in play, and a release carries it
 * (`releases.ts` → `palette`). With none in play the phone keeps the app's
 * own ("Kayısı × Okyanus"). The app's inventory brings its roles, its own
 * palette and a set of ready ones to start from.
 *
 * READABLE, OR NOT IN PLAY. Every role is a colour, and every text is
 * measured against what it is written on (WCAG contrast): under 3:1 is an
 * error -- such a palette never reaches a phone -- under 4.5:1 a warning.
 *
 *   admin   GET /palettes · POST /palettes · PATCH/DELETE /palettes/:id
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { all, one, run, tx } from "../storage/sql.js";
import { latestInventory, PaletteColors, type PaletteInventory } from "./inventory.js";
import { slug } from "./games.js";
import type { Issue } from "./checks.js";
import { nextStamp, staleFor } from "./vocab.js";

interface PaletteRow { id: string; name: string; note: string; colors: string; status: "live" | "draft"; created_at: number; updated_at: number }
export interface Palette {
  id: string; name: string; note: string; colors: Partial<PaletteColors>; status: PaletteRow["status"];
  createdAt: number; updatedAt: number;
}

const row = (id: string) => one<PaletteRow>("SELECT * FROM palettes WHERE id = ?", id);
const asPalette = (r: PaletteRow): Palette => ({
  id: r.id, name: r.name, note: r.note, colors: JSON.parse(r.colors || "{}") as Partial<PaletteColors>,
  status: r.status, createdAt: r.created_at, updatedAt: r.updated_at,
});
export const loadPalettes = async (): Promise<Palette[]> =>
  (await all<PaletteRow>(`SELECT * FROM palettes ORDER BY created_at, id COLLATE "C"`)).map(asPalette);
export const livePalette = async (): Promise<Palette | null> => (await loadPalettes()).find((p) => p.status === "live") ?? null;

/* ── the arithmetic (the same as the app's `core/palette.ts`) ─────────────── */

const lum = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
};
export function contrast(a: string, b: string): number {
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
/** every text against what it is written on, the lowest where a text sits on two colours */
export function contrasts(c: PaletteColors) {
  return {
    background: Math.min(contrast(c.background.text, c.background.start), contrast(c.background.text, c.background.end)),
    card: contrast(c.card.text, c.card.background),
    primary: contrast(c.primary.text, c.primary.background),
    secondary: contrast(c.secondary.text, c.secondary.background),
  };
}
const ON = { background: "Arka plan yazısı arka planın üstünde", card: "Kart yazısı kartın üstünde",
             primary: "Ana düğmenin yazısı", secondary: "İkinci düğmenin yazısı" } as const;

/* ── the checks ───────────────────────────────────────────────────────────── */

/** what is wrong with a palette, error by error -- a palette with an error never plays */
export function checkPalette(p: Palette, inv: PaletteInventory | undefined = latestInventory()?.palette): Issue[] {
  const out: Issue[] = [];
  const err = (text: string) => out.push({ level: "error", text });
  const warn = (text: string) => out.push({ level: "warn", text });
  if (!inv) { err("Uygulamanın envanterinde renk paleti sözleşmesi yok: önce uygulamanın yeni envanterini alın (npm run inventory)."); return out; }
  if (!p.name.trim()) err("Bir ad verin (panelde ne olduğu anlaşılsın).");
  const c = PaletteColors.safeParse(p.colors);
  if (!c.success) { err("Her rolün bir rengi olmalı (#RRGGBB)."); return out; }
  for (const [k, v] of Object.entries(contrasts(c.data)) as [keyof typeof ON, number][]) {
    const n = v.toFixed(1);
    if (v < 3) err(`${ON[k]} okunmuyor: kontrast ${n}:1 (en az 3:1, iyisi 4.5:1).`);
    else if (v < 4.5) warn(`${ON[k]} zayıf: kontrast ${n}:1 (önerilen en az 4.5:1).`);
  }
  return out;
}

/* ── what the panel reads ─────────────────────────────────────────────────── */

export async function palettesOut() {
  const inv = latestInventory()?.palette;
  const list = (await loadPalettes()).map((p) => {
    const c = PaletteColors.safeParse(p.colors);
    return { ...p, issues: checkPalette(p, inv), contrast: c.success ? contrasts(c.data) : null };
  });
  return { contract: inv ? { since: inv.since, roles: inv.roles, builtin: inv.builtin, presets: inv.presets } : null, list };
}

/* ── routes ───────────────────────────────────────────────────────────────── */

/* an edit names only the roles it changes */
const Hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Renk #RRGGBB olmalı");
const Colors = z.object({
  background: z.object({ start: Hex, end: Hex, text: Hex }).partial().optional(),
  card: z.object({ background: Hex, text: Hex }).partial().optional(),
  primary: z.object({ background: Hex, text: Hex, lip: Hex }).partial().optional(),
  secondary: z.object({ background: Hex, text: Hex, lip: Hex }).partial().optional(),
  accent: Hex.optional(),
});
const Patch = z.object({
  name: z.string().trim().max(60).optional(), note: z.string().max(600).optional(),
  colors: Colors.optional(),
  status: z.enum(["live", "draft"]).optional(),
});
/** a partial colour object laid over the current one, role by role */
function merge(cur: Partial<PaletteColors>, d: z.infer<typeof Colors>): Partial<PaletteColors> {
  const out: Record<string, unknown> = { ...cur };
  for (const [k, v] of Object.entries(d)) out[k] = v && typeof v === "object" ? { ...(cur as Record<string, object>)[k], ...v } : v;
  return out as Partial<PaletteColors>;
}

export async function paletteRoutes(app: FastifyInstance) {
  app.get("/palettes", async () => palettesOut());

  /* a new palette: from a ready one (`from`), from given colours, or from the app's own */
  app.post("/palettes", (req, reply) => tx(async () => {
    const b = z.object({ name: z.string().trim().min(1).max(60), from: z.string().max(80).optional(),
                         colors: PaletteColors.optional() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "Ad gerekli" });
    const inv = latestInventory()?.palette;
    if (!inv) return reply.code(400).send({ error: "Uygulamanın envanterinde renk paleti sözleşmesi yok." });
    const src = b.data.colors ?? (b.data.from ? inv.presets.find((x) => x.id === b.data.from) : inv.builtin);
    if (!src) return reply.code(400).send({ error: `"${b.data.from}" hazır paletlerde yok.` });
    const { background, card, primary, secondary, accent } = src;
    let id = slug(b.data.name) || "palet";
    for (let n = 2; await row(id); n++) id = `${slug(b.data.name) || "palet"}-${n}`;
    const now = Date.now();
    await run(`INSERT INTO palettes(id, name, colors, status, created_at, updated_at) VALUES(?, ?, ?, 'draft', ?, ?)`,
              id, b.data.name, JSON.stringify({ background, card, primary, secondary, accent }), now, now);
    reply.code(201);
    return (await palettesOut()).list.find((x) => x.id === id);
  }));

  app.patch("/palettes/:id", (req, reply) => tx(async () => {
    const pid = (req.params as { id: string }).id;
    const r = await row(pid);
    if (!r) return reply.code(404).send({ error: "Palet yok" });
    const b = Patch.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: b.error.issues[0]?.message ?? "Geçersiz istek" });
    if (staleFor(req, r.updated_at)) return reply.code(409).send({ code: "STALE", error: "Bu palet başka bir yerde değişti." });
    const d = b.data;
    const cur = asPalette(r);
    const next: Palette = { ...cur, name: d.name ?? cur.name, note: d.note ?? cur.note,
                            colors: d.colors ? merge(cur.colors, d.colors) : cur.colors, status: d.status ?? cur.status };
    if (next.status === "live") {
      const issues = checkPalette(next);
      if (issues.some((i) => i.level === "error"))
        return reply.code(400).send({ error: "Hatası olan palet uygulamaya konamaz.", issues });
    }
    /* one palette in play: putting this one in takes the other out -- first,
       since the database holds the rule too (migration 6) */
    if (next.status === "live")
      for (const o of await all<{ id: string; updated_at: number }>("SELECT id, updated_at FROM palettes WHERE status = 'live' AND id != ?", pid))
        await run("UPDATE palettes SET status = 'draft', updated_at = ? WHERE id = ?", nextStamp(o.updated_at), o.id);
    await run(`UPDATE palettes SET name = ?, note = ?, colors = ?, status = ?, updated_at = ? WHERE id = ?`,
              next.name, next.note, JSON.stringify(next.colors), next.status, nextStamp(r.updated_at), pid);
    return (await palettesOut()).list.find((x) => x.id === pid);
  }));

  app.delete("/palettes/:id", (req, reply) => tx(async () => {
    const pid = (req.params as { id: string }).id;
    if (!(await row(pid))) return reply.code(404).send({ error: "Palet yok" });
    await run("DELETE FROM palettes WHERE id = ?", pid);
    return { ok: true };
  }));
}
