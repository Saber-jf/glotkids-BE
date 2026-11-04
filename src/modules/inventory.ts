/**
 * WHAT EACH BUILD OF THE APP CAN PLAY (`app-inventory.json`, written by the
 * app's `npm run inventory` from `src/content/inventory.ts`).
 *
 * The app is the only one who knows which game engines and live scenes it has
 * -- they are code. So it says so, per build, and this server believes it:
 *
 *   - a category or game is only ever sent to a phone whose build has every
 *     engine and scene it uses (`requires`, `releases.ts`)
 *   - the app's OWN games, categories, word sets and words appear here as
 *     built-in rows, refreshed from the inventory -- never typed a second
 *     time on the server (the old `*.seed.ts` lists went stale the day the
 *     app gained a category)
 *   - the bundled recordings are listed, so the panel knows what a phone
 *     already has and what a published take would replace
 *
 *   admin   GET /inventory · GET /inventory/builds · PUT /inventory
 *   startup the app folder's file (APP_DIR), in development
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { all, meta, one, run, tx } from "../storage/sql.js";
import { appAsset, installFile } from "../storage/builtin.js";

/* ── the shape the app sends ──────────────────────────────────────────────── */

const Template = z.object({
  id: z.string(), kind: z.enum(["game", "scene", "demo"]), role: z.enum(["teach", "practice", "measure"]),
  family: z.string(), gesture: z.string(), menu: z.boolean(), open: z.boolean(),
  needs: z.object({ icon: z.boolean() }), slots: z.array(z.string()), since: z.number().int(),
  /** can a category step ask it to introduce each word with a card (M05) */
  teach: z.boolean().default(false),
  name: z.string(), subtitle: z.string(), accepts: z.string().nullable(),
});
const Scene = z.object({ id: z.string(), name: z.string(), for: z.string().nullable(), since: z.number().int() });
const IWord = z.object({
  id: z.string(), en: z.string(), tr: z.string(), about: z.string(), aboutParts: z.array(z.string()).default([]),
  kind: z.string(), color: z.string(), icon: z.string().nullable(),
});
const ISet = z.object({ id: z.string(), name: z.string(), words: z.array(z.string()) });
const ICategory = z.object({
  id: z.string(), title: z.string(), subtitle: z.string(), set: z.string(),
  steps: z.array(z.looseObject({ id: z.string(), kind: z.string() })), since: z.number().int(),
});
/**
 * The app's own roadmap: the DRAWN map (`core/meadowmap.ts`, 2026-11-03) --
 * rows of stops, one row per category, drawn by code, no picture. The
 * server's rows go after the app's, in order (`roadmap.ts`), and the map grows
 * to the right. The painted world before it (tiles, trail, crossings, stops
 * with x/y) is gone: an inventory that still sends it is read (its other
 * parts count) but its roadmap is not -- that build cannot lay rows.
 */
const IRoad = z.object({
  kind: z.literal("drawn"),
  /** the first build that lays a release's rows after its own */
  since: z.number().int(),
  /** the most stops one row has: games 1, 2, 3 and a music stop */
  stopsPerRow: z.number().int().min(1),
  /** the app's own stops, in map order, each with the row (category) it is on */
  stops: z.array(z.object({ id: z.string(), kind: z.string(), row: z.string() })),
});
export type DrawnRoad = z.infer<typeof IRoad>;
/** the painted map's roadmap, from a build before the drawn one: accepted, dropped */
const LegacyRoad = z.looseObject({ tiles: z.array(z.unknown()) }).transform(() => undefined);
/** the mascots: the contract a Lottie keeps, the behaviours a role plays,
 *  the app's own two and the lines that say a name (`content/mascots.ts`) */
const MRole = z.enum(["learner", "friend"]);
const IMascots = z.object({
  canvas: z.number(), fr: z.number(), since: z.number().int(),
  /** the gaze file's least length (frame = angle) */
  lookOp: z.number().optional(),
  roles: z.array(z.object({
    role: MRole, slot: z.string(),
    /** the base file's least length: the scenes' quiet twins live past the last marker */
    minOp: z.number().optional(),
    markers: z.record(z.string(), z.object({ from: z.number(), to: z.number(), hold: z.enum(["any", "length", "frames"]) })),
    behaviours: z.array(z.object({ key: z.string(), group: z.string(), label: z.string(), when: z.string(), mappable: z.boolean() })),
  })),
  travel: z.object({ map: z.enum(["walk", "stroll"]), scene: z.enum(["walk", "stroll"]) }),
  builtin: z.array(z.object({ role: MRole, slot: z.string(), name: z.string(), base: z.string(), look: z.string().nullable(),
                              foot: z.object({ x: z.number(), y: z.number(), top: z.number() }) })),
  namedLines: z.array(z.object({ clip: z.string(), speaker: z.string(), template: z.string(), roles: z.array(MRole) })),
  forms: z.array(z.string()),
});
export type MascotInventory = z.infer<typeof IMascots>;

/** the app's type (`loplop/src/content/typography.ts`): four roles, the weight
 *  each is drawn at, the app's own face for each, and the letters a font must
 *  have before it may fill a role */
export const FONT_ROLES = ["title", "strong", "body", "bodyStrong"] as const;
export type FontRole = (typeof FONT_ROLES)[number];
const ITypography = z.object({
  since: z.number().int(),
  required: z.string().min(1),
  roles: z.array(z.object({
    role: z.enum(FONT_ROLES), weight: z.number().int(), label: z.string(), use: z.string(),
    builtin: z.object({ name: z.string(), file: z.string(), minLine: z.number() }),
  })),
});
export type TypographyInventory = z.infer<typeof ITypography>;

/** the app's colour palette (`loplop/src/core/palette.ts`): its roles, the
 *  app's own palette and the ready ones the panel offers to start from */
const Hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
export const PaletteColors = z.object({
  background: z.object({ start: Hex, end: Hex, text: Hex }),
  card: z.object({ background: Hex, text: Hex }),
  primary: z.object({ background: Hex, text: Hex, lip: Hex }),
  secondary: z.object({ background: Hex, text: Hex, lip: Hex }),
  accent: Hex,
});
export type PaletteColors = z.infer<typeof PaletteColors>;
const IPalette = z.object({
  since: z.number().int(),
  roles: z.array(z.object({ key: z.string(), label: z.string(), use: z.string() })),
  builtin: PaletteColors.extend({ id: z.string(), name: z.string() }),
  presets: z.array(PaletteColors.extend({ id: z.string(), name: z.string() })),
});
export type PaletteInventory = z.infer<typeof IPalette>;

export const Inventory = z.object({
  schema: z.number().int(),
  app: z.object({ version: z.string(), build: z.number().int().min(1) }),
  templates: z.array(Template), scenes: z.array(Scene),
  words: z.array(IWord), sets: z.array(ISet), categories: z.array(ICategory),
  clips: z.array(z.string()),
  roadmap: z.union([IRoad, LegacyRoad]).optional(),
  mascots: IMascots.optional(),
  /** every fixed sentence the app says, and the category steps it is said in
   *  (the app's `tools/inventory/lines.ts`): the panel's script offers each
   *  one to be recorded. An older app's inventory has none. */
  lines: z.array(z.object({
    clip: z.string(), speaker: z.enum(["teacher", "otter", "bunny"]), text: z.string(),
    places: z.array(z.object({ category: z.string(), step: z.string() })),
    /** an English line ("three apples", 2026-11-03): recorded with the English
     *  voice settings. Absent: the app's own language. */
    lang: z.literal("en").optional(),
    /** how it is said, an ElevenLabs tag the studio starts from ("[sing-song,
     *  rhythmic]" for the counting song, 2026-11-03) */
    tag: z.string().max(80).optional(),
  })).optional(),
  /** the app's own music stops a release may give a song (`content/inventory.ts` → SONGS_SINCE) */
  songs: z.object({ since: z.number().int(), stops: z.array(z.object({ id: z.string(), title: z.string(), category: z.string() })) }).optional(),
  /** the app's type: an older app's inventory has none, and no release brings it fonts */
  typography: ITypography.optional(),
  /** the app's colour palette: an older app's inventory has none, and no release brings it one */
  palette: IPalette.optional(),
});
export type InventoryDoc = z.infer<typeof Inventory>;
export type TemplateInfo = z.infer<typeof Template>;
export type SceneInfo = z.infer<typeof Scene>;

/* ── reading what is stored ───────────────────────────────────────────────── */

/*
 * Every build's inventory is kept in memory, newest first: almost every
 * screen asks "what can the app play" and the answer is a few hundred KB of
 * JSON that changes only when a build is taken in -- by this process, the
 * one server there is (rule 25d). Loaded at start (`loadInventories`), and
 * replaced here after each import commits.
 */
let known: { build: number; data: string; doc: InventoryDoc }[] = [];

/** an inventory read back from the database was not parsed again: its roadmap
 *  counts only if it is the drawn map */
const drawnOrNone = (doc: InventoryDoc): InventoryDoc => {
  const r = doc.roadmap as { kind?: unknown } | undefined;
  if (r && r.kind !== "drawn") { const { roadmap: _r, ...rest } = doc; return rest; }
  return doc;
};

/** read every stored inventory into memory (at start, and after a restore) */
export async function loadInventories(): Promise<void> {
  const rows = await all<{ build: number; data: string }>("SELECT build, data FROM capabilities ORDER BY build DESC");
  known = rows.map((r) => ({ build: r.build, data: r.data, doc: drawnOrNone(JSON.parse(r.data) as InventoryDoc) }));
}

/** the newest build the server has heard of, or null before any */
export function latestInventory(): InventoryDoc | null {
  return known[0]?.doc ?? null;
}

/** what a phone of `build` can play: the newest inventory at or below it
 *  (a build the server never heard of is an older one it did, or nothing) */
export function inventoryFor(build: number): InventoryDoc | null {
  return known.find((k) => k.build <= build)?.doc ?? null;
}

export const builds = () =>
  all<{ build: number; version: string; schema: number; received_at: number }>(
    "SELECT build, version, schema, received_at FROM capabilities ORDER BY build DESC");

/* ── taking one in ────────────────────────────────────────────────────────── */

/**
 * Store an inventory and refresh the built-in rows from it. Built-in rows
 * keep what the PANEL decides about them (a game's status, order and card
 * picture; a word's recordings) and take everything the APP decides (names,
 * words, steps). Returns what changed.
 */
export class BuildImmutable extends Error {}

/** what the server keeps track of when the app's own ids meet the panel's (S12) */
export interface Conflict { kind: "kelime" | "set" | "oyun" | "kategori"; id: string }

export async function importInventory(doc: InventoryDoc, appDir: string | null,
                                      opts: { replace?: boolean } = {}): Promise<string> {
  const data = JSON.stringify(doc);
  const prev = await one<{ data: string }>("SELECT data FROM capabilities WHERE build = ?", doc.app.build);
  /* S11: a build is what is on phones; it does not change after the fact.
     Development (the app folder, `replace`) rewrites its own build freely. */
  if (prev && prev.data !== data && !opts.replace)
    throw new BuildImmutable(`Sürüm ${doc.app.build} zaten kayıtlı ve bu envanter ondan farklı. `
      + `Mağazadaki bir sürümün yetenekleri değişmez: yeni bir APP_BUILD ile gönderin.`);
  const conflicts: Conflict[] = [];
  /* S12: a row the PANEL made is never turned into one of the app's own --
     it is left as it is and reported */
  let made = new Set<string>();
  const custom = (table: string, id: string) => made.has(`${table}/${id}`);
  /* the word pictures the app ships, copied in as `app-word-<id>` */
  let pics = 0;
  if (appDir)
    for (const w of doc.words)
      if (w.icon && await installFile(appAsset(`word-${w.id}`), path.join(appDir, w.icon))) pics++;
  /* the app's own mascots, so the panel can play them and a designer can
     start from them (`app-mascot-learner`, `-learner-look`, `app-mascot-friend`) */
  if (appDir && doc.mascots)
    for (const m of doc.mascots.builtin) {
      await installFile(appAsset(`mascot-${m.role}`), path.join(appDir, m.base));
      if (m.look) await installFile(appAsset(`mascot-${m.role}-look`), path.join(appDir, m.look));
    }
  /* the app's own four faces, so the panel can show what a role looks like now
     (`app-font-title` …) */
  if (appDir && doc.typography)
    for (const r of doc.typography.roles) await installFile(appAsset(`font-${r.role}`), path.join(appDir, r.builtin.file));
  const now = Date.now();
  /* the app's own pictures, looked up once (they were installed above) */
  const have = new Set((await all<{ id: string }>("SELECT id FROM assets WHERE id LIKE 'app-%'")).map((r) => r.id));
  const pic = (name: string) => (have.has(appAsset(name)) ? appAsset(name) : null);
  await tx(async () => {
    await run(`INSERT INTO capabilities(build, version, schema, data, received_at) VALUES(?, ?, ?, ?, ?)
         ON CONFLICT(build) DO UPDATE SET version = excluded.version, schema = excluded.schema,
           data = excluded.data, received_at = excluded.received_at`,
        doc.app.build, doc.app.version, doc.schema, data, now);
    /* only the NEWEST build shapes the built-in rows; an older build arriving
       late (a CI re-run) is stored for filtering and changes nothing else */
    const newest = (await one<{ build: number }>("SELECT MAX(build) AS build FROM capabilities"))!.build;
    if (newest !== doc.app.build) return;
    /* the panel's own rows, read once */
    made = new Set((await all<{ k: string }>(
      `SELECT 'words/' || id AS k FROM words WHERE builtin = 0 UNION ALL SELECT 'sets/' || id FROM sets WHERE builtin = 0
       UNION ALL SELECT 'games/' || id FROM games WHERE builtin = 0 UNION ALL SELECT 'categories/' || id FROM categories WHERE builtin = 0`)).map((r) => r.k));

    for (const w of doc.words) {
      if (custom("words", w.id)) { conflicts.push({ kind: "kelime", id: w.id }); continue; }
      const icon = pic(`word-${w.id}`);
      await run(`INSERT INTO words(id, en, tr, about, kind, color, icon, builtin, created_at, updated_at)
           VALUES(?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET en = excluded.en, tr = excluded.tr, about = excluded.about,
             kind = excluded.kind, color = excluded.color, builtin = 1,
             icon = COALESCE(words.icon, excluded.icon), updated_at = excluded.updated_at`,
          w.id, w.en, w.tr, w.about, w.kind, w.color, icon, now, now);
    }
    for (const s of doc.sets) {
      if (custom("sets", s.id)) { conflicts.push({ kind: "set", id: s.id }); continue; }
      await run(`INSERT INTO sets(id, name, note, builtin, created_at, updated_at) VALUES(?, ?, '', 1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET name = excluded.name, builtin = 1, updated_at = excluded.updated_at`,
          s.id, s.name, now, now);
      await run("DELETE FROM set_words WHERE set_id = ?", s.id);
      for (const [i, w] of s.words.entries()) await run("INSERT INTO set_words(set_id, word_id, pos) VALUES(?, ?, ?)", s.id, w, i);
    }
    const baseOrd = 0;
    for (const [i, t] of doc.templates.entries()) {
      if (custom("games", t.id)) { conflicts.push({ kind: "oyun", id: t.id }); continue; }
      const card = pic(`game-${t.id}`);
      const set = doc.categories.find((c) => c.steps.some((st) => st.kind === "game" && st.game === t.id))?.set ?? null;
      await run(`INSERT INTO games(id, template, builtin, name, subtitle, family, icon, set_id, config, status, ord, created_at, updated_at)
           VALUES(?, ?, 1, ?, ?, ?, ?, ?, '{}', 'live', ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET template = excluded.template, builtin = 1, name = excluded.name,
             subtitle = excluded.subtitle, family = excluded.family, set_id = excluded.set_id,
             icon = COALESCE(games.icon, excluded.icon), updated_at = excluded.updated_at`,
          t.id, t.id, t.name, t.subtitle, t.family, card, set, baseOrd + i, now, now);
    }
    for (const [i, c] of doc.categories.entries()) {
      if (custom("categories", c.id)) { conflicts.push({ kind: "kategori", id: c.id }); continue; }
      await run(`INSERT INTO categories(id, builtin, title, subtitle, icon, set_id, steps, status, ord, created_at, updated_at)
           VALUES(?, 1, ?, ?, ?, ?, ?, 'live', ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET builtin = 1, title = excluded.title, subtitle = excluded.subtitle,
             set_id = excluded.set_id, steps = excluded.steps, updated_at = excluded.updated_at`,
          c.id, c.title, c.subtitle, firstIcon(doc, c.set, pic), c.set, JSON.stringify(c.steps), i, now, now);
    }
  });
  await loadInventories();
  await meta.set("inventory-conflicts", JSON.stringify({ build: doc.app.build, at: now, items: conflicts }));
  const same = prev?.data === data;
  return `build ${doc.app.build}: ${same ? "değişmedi" : "güncellendi"}, ${doc.templates.length} motor, `
    + `${doc.categories.length} kategori, ${doc.words.length} kelime${pics ? `, ${pics} resim` : ""}`
    + (conflicts.length ? `; ÇAKIŞMA (panelin içeriği korundu): ${conflicts.map((c) => `${c.kind} ${c.id}`).join(", ")}` : "");
}

/** a built-in category's card: its first word's picture */
function firstIcon(doc: InventoryDoc, set: string, pic: (name: string) => string | null): string | null {
  const first = doc.sets.find((s) => s.id === set)?.words[0];
  return first ? pic(`word-${first}`) : null;
}

/** in development: the app folder's inventory, taken in at start */
export async function importFromAppDir(log: (m: string) => void) {
  const file = path.join(config.appDir, "app-inventory.json");
  if (!existsSync(file)) { log(`envanter yok (${file}) — uygulamada \`npm run inventory\``); return; }
  const raw = await readFile(file, "utf8");
  const doc = Inventory.safeParse(JSON.parse(raw));
  if (!doc.success) { log(`envanter okunamadı: ${doc.error.issues[0]?.message}`); return; }
  log("envanter: " + await importInventory(doc.data, config.appDir, { replace: true }));
}

export const inventoryHash = (d: InventoryDoc | null) =>
  d ? createHash("sha256").update(JSON.stringify(d)).digest("hex").slice(0, 12) : null;

/* ── routes ───────────────────────────────────────────────────────────────── */

export async function inventoryRoutes(app: FastifyInstance) {
  app.get("/inventory", async (_req, reply) => {
    const d = latestInventory();
    return d ?? reply.code(404).send({ error: "Uygulama henüz envanterini göndermedi (uygulamada `npm run inventory`)." });
  });
  app.get("/inventory/builds", async () => builds());
  /* ids the app's inventory brought that the panel had already made (S12) */
  app.get("/inventory/conflicts", async () => JSON.parse((await meta.get("inventory-conflicts")) ?? '{"items":[]}'));
  /* the app's build pipeline sends what the build can play */
  app.put("/inventory", async (req, reply) => {
    const d = Inventory.safeParse(req.body);
    if (!d.success) return reply.code(400).send({ error: "Geçersiz envanter", detail: d.error.issues.slice(0, 5) });
    try { return { ok: true, text: await importInventory(d.data, null) }; }
    catch (e) {
      if (e instanceof BuildImmutable) return reply.code(409).send({ code: "BUILD_IMMUTABLE", error: e.message });
      throw e;
    }
  });
}
