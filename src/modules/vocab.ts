/**
 * THE VOCABULARY: words, their recordings, and the word sets built of them.
 *
 * One row per word, referenced by every set, game and category that uses it
 * -- before this, each new game and each new category kept its own copy of
 * its words, so a typo was fixed in one place and lived on in two.
 *
 * A word's id is its stable name and the app builds its clip ids from it
 * (`teacher/en_<id>`, `otter/en_<id>`), so it never changes once made. The
 * app's OWN words (`builtin`) arrive with its inventory: their text, colour
 * and picture are the app's (on a phone the app's own word always wins). The
 * panel may give them recordings, which a release carries to phones in place
 * of the bundled take.
 *
 * Recording slots, and the clip each one is played as:
 *   en      teacher/en_<id>       the English word, clean, on its own
 *   tr      teacher/tr_<id>       "Türkçesi, <tr>."
 *   about   teacher/about_<id>    the explanation (rule 10)
 *   about1… teacher/about1_<id>   the explanation one sentence at a time, the
 *                                 word between them (the action verbs)
 *   otter   otter/en_<id>         Kuki repeating the word
 *   call    animal/<id>           the thing's own sound (a dog's bark)
 *
 *   admin  GET/POST /words · GET/PATCH/DELETE /words/:id
 *          PUT/DELETE /words/:id/audio/:slot
 *          GET/POST /sets · GET/PATCH/DELETE /sets/:id
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { all, one, run, tx } from "../storage/sql.js";
import { getAsset } from "../storage/files.js";
import { studioDoc } from "../storage/studio-refs.js";

/** the clip ids the studio's fixed lines use */
export const fixedLineClips = async (): Promise<string[]> => {
  const d = await studioDoc();
  return Array.isArray(d?.lines) ? d!.lines!.map((l) => l.clip) : [];
};

export const SLOTS = ["en", "tr", "about", "about1", "about2", "about3", "otter", "call"] as const;
export type Slot = (typeof SLOTS)[number];

/** the app's clip id for a word's recording slot */
export const clipOf = (word: string, slot: Slot): string =>
  slot === "otter" ? `otter/en_${word}` : slot === "call" ? `animal/${word}` : `teacher/${slot}_${word}`;

export interface WordOut {
  id: string; en: string; tr: string; about: string; kind: string; color: string;
  icon: string | null; builtin: boolean; updatedAt: number;
  audio: Partial<Record<Slot, { asset: string; text: string; updatedAt: number; durationMs: number | null }>>;
  /** the sets it is in */
  sets: string[];
}

interface WordRow { id: string; en: string; tr: string; about: string; kind: string; color: string;
                    icon: string | null; builtin: number; updated_at: number }

const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");

async function audioOf(ids: string[]): Promise<Map<string, WordOut["audio"]>> {
  const m = new Map<string, WordOut["audio"]>();
  if (!ids.length) return m;
  const rows = await all<{ word_id: string; slot: Slot; asset: string; text: string; updated_at: number; duration_ms: number | null }>(
    `SELECT * FROM word_audio WHERE word_id IN (${marks(ids.length)})`, ...ids);
  for (const r of rows) {
    const a = m.get(r.word_id) ?? {};
    a[r.slot] = { asset: r.asset, text: r.text, updatedAt: r.updated_at, durationMs: r.duration_ms ?? null };
    m.set(r.word_id, a);
  }
  return m;
}

async function setsOf(ids: string[]): Promise<Map<string, string[]>> {
  const m = new Map<string, string[]>();
  if (!ids.length) return m;
  for (const r of await all<{ set_id: string; word_id: string }>(
    `SELECT set_id, word_id FROM set_words WHERE word_id IN (${marks(ids.length)}) ORDER BY set_id COLLATE "C"`, ...ids))
    m.set(r.word_id, [...(m.get(r.word_id) ?? []), r.set_id]);
  return m;
}

export async function wordsById(ids: readonly string[]): Promise<WordOut[]> {
  if (!ids.length) return [];
  const uniq = [...new Set(ids)];
  const rows = await all<WordRow>(`SELECT * FROM words WHERE id IN (${marks(uniq.length)})`, ...uniq);
  const [audio, sets] = await Promise.all([audioOf(rows.map((r) => r.id)), setsOf(rows.map((r) => r.id))]);
  const by = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => by.get(id)).filter((r): r is WordRow => !!r).map((r) => ({
    id: r.id, en: r.en, tr: r.tr, about: r.about, kind: r.kind, color: r.color, icon: r.icon,
    builtin: !!r.builtin, updatedAt: r.updated_at, audio: audio.get(r.id) ?? {}, sets: sets.get(r.id) ?? [],
  }));
}

export const allWords = async (): Promise<WordOut[]> =>
  wordsById((await all<{ id: string }>(`SELECT id FROM words ORDER BY builtin DESC, id COLLATE "C"`)).map((r) => r.id));

export interface SetOut {
  id: string; name: string; note: string; builtin: boolean; words: string[];
  createdAt: number; updatedAt: number;
  /** who plays it: games and categories by id */
  usedBy: { games: string[]; categories: string[] };
}

interface SetRow { id: string; name: string; note: string; builtin: number; created_at: number; updated_at: number }

/** sets with their words and users, in four queries however many there are */
async function setsOut(rows: SetRow[]): Promise<SetOut[]> {
  if (!rows.length) return [];
  const ids = rows.map((s) => s.id);
  const [words, games, cats] = await Promise.all([
    all<{ set_id: string; word_id: string }>(`SELECT set_id, word_id FROM set_words WHERE set_id IN (${marks(ids.length)}) ORDER BY set_id, pos`, ...ids),
    all<{ id: string; set_id: string }>(`SELECT id, set_id FROM games WHERE set_id IN (${marks(ids.length)}) ORDER BY id COLLATE "C"`, ...ids),
    all<{ id: string; set_id: string }>(`SELECT id, set_id FROM categories WHERE set_id IN (${marks(ids.length)}) ORDER BY id COLLATE "C"`, ...ids),
  ]);
  const of = <T extends { set_id: string }>(xs: T[], id: string) => xs.filter((x) => x.set_id === id);
  return rows.map((s) => ({
    id: s.id, name: s.name, note: s.note, builtin: !!s.builtin, createdAt: s.created_at, updatedAt: s.updated_at,
    words: of(words, s.id).map((r) => r.word_id),
    usedBy: { games: of(games, s.id).map((r) => r.id), categories: of(cats, s.id).map((r) => r.id) },
  }));
}

export async function setById(id: string): Promise<SetOut | null> {
  const s = await one<SetRow>("SELECT * FROM sets WHERE id = ?", id);
  return s ? (await setsOut([s]))[0]! : null;
}

export const allSets = async (): Promise<SetOut[]> =>
  setsOut(await all<SetRow>(`SELECT * FROM sets ORDER BY builtin DESC, created_at, id COLLATE "C"`));

/* ── validation ───────────────────────────────────────────────────────────── */

export const wordId = z.string().regex(/^[a-z0-9_-]{1,40}$/, "kelime kimliği: küçük harf, rakam, - ve _");
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "renk #RRGGBB olmalı");
const asset = z.string().max(80).nullable();
const WordIn = z.object({
  id: wordId, en: z.string().trim().min(1).max(60), tr: z.string().trim().min(1).max(60),
  about: z.string().max(600).default(""), kind: z.enum(["thing", "action", "feeling", "size", "place", "colour", "number"]).default("thing"),
  color: color.default("#6D3FC8"), icon: asset.default(null),
});
/* written out, not `WordIn.partial()`: a partial of a schema with defaults
   fills the defaults in, and fixing a word's Turkish wiped its description,
   picture and colour */
const WordPatch = z.object({
  en: z.string().trim().min(1).max(60).optional(), tr: z.string().trim().min(1).max(60).optional(),
  about: z.string().max(600).optional(),
  kind: z.enum(["thing", "action", "feeling", "size", "place", "colour", "number"]).optional(),
  color: color.optional(), icon: asset.optional(),
});
const AudioIn = z.object({ asset: z.string().max(80), text: z.string().max(600).default(""),
                          durationMs: z.number().int().min(0).max(10 * 60_000).nullable().optional() });
const SetIn = z.object({
  id: z.string().regex(/^[a-z0-9-]{2,40}$/).optional(), name: z.string().trim().min(1).max(60),
  note: z.string().max(600).default(""), words: z.array(wordId).max(12).default([]),
});
/* written out, not `SetIn.partial()` (S01): a partial of a schema with
   defaults fills them in -- renaming a set sent `words: []` and emptied it */
const SetPatch = z.object({
  name: z.string().trim().min(1).max(60).optional(), note: z.string().max(600).optional(),
  words: z.array(wordId).max(12).optional(),
});

const slug = (s: string) => s.trim().toLowerCase()
  .replace(/[çğıİöşü]/g, (c) => ({ ç: "c", ğ: "g", ı: "i", İ: "i", ö: "o", ş: "s", ü: "u" } as Record<string, string>)[c] ?? c)
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "set";

const bad = (reply: { code: (n: number) => { send: (b: unknown) => unknown } }, e: z.ZodError) =>
  reply.code(400).send({ error: e.issues[0]?.message ?? "Geçersiz istek" });

/**
 * Optimistic concurrency (A02): a PATCH may say which version it was based on
 * (`If-Match: "<updatedAt>"`); a row changed since answers 409 `STALE` with
 * the row as it is now, so nothing is overwritten unseen. Without the header
 * the write goes through, as before.
 */
export function staleFor(req: { headers: Record<string, string | string[] | undefined> }, updatedAt: number): boolean {
  const h = req.headers["if-match"];
  if (typeof h !== "string" || !h.trim()) return false;
  return h.replace(/"/g, "").trim() !== String(updatedAt);
}
/** a version stamp that always moves forward, even within one millisecond */
export const nextStamp = (prev: number) => Math.max(Date.now(), prev + 1);

/** does this clip id belong to a word that exists (A09)? */
export async function isWordClip(clip: string): Promise<boolean> {
  const m = /^(?:teacher\/(?:en|tr|about|about[123])_|otter\/en_|animal\/)([a-z0-9_-]+)$/.exec(clip);
  return !!m && !!(await one("SELECT id FROM words WHERE id = ?", m[1]));
}

/** the clips a word would be played as (`clipOf`, every slot) */
export const clipsOfWord = (id: string) => SLOTS.map((s) => clipOf(id, s));

async function checkAsset(id: string | null | undefined, kind: "image" | "audio"): Promise<string | null> {
  if (!id) return null;
  const a = await getAsset(id);
  if (!a) return `"${id}" diye bir dosya yok`;
  if (a.kind !== kind) return `"${id}" bir ${kind === "image" ? "resim" : "ses"} değil`;
  return null;
}

/** the words of a list that do not exist */
async function missingWords(ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const have = new Set((await all<{ id: string }>(`SELECT id FROM words WHERE id IN (${marks(ids.length)})`, ...ids)).map((r) => r.id));
  return ids.filter((w) => !have.has(w));
}

async function putSetWords(id: string, words: string[]) {
  await run("DELETE FROM set_words WHERE set_id = ?", id);
  for (const [i, w] of words.entries()) await run("INSERT INTO set_words(set_id, word_id, pos) VALUES(?, ?, ?)", id, w, i);
}

/* ── routes ───────────────────────────────────────────────────────────────── */

export async function vocabRoutes(app: FastifyInstance) {
  app.get("/words", async () => allWords());
  app.get("/words/:id", async (req, reply) =>
    (await wordsById([(req.params as { id: string }).id]))[0] ?? reply.code(404).send({ error: "Kelime yok" }));

  /* every write below is one transaction: what it checked is still so when it writes */
  app.post("/words", (req, reply) => tx(async () => {
    const b = WordIn.safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    const w = b.data;
    if (await one("SELECT id FROM words WHERE id = ?", w.id)) return reply.code(409).send({ error: `"${w.id}" kelimesi zaten var` });
    /* A09: a fixed line already uses one of this word's clip ids */
    const taken = (await fixedLineClips()).filter((c) => clipsOfWord(w.id).includes(c));
    if (taken.length) return reply.code(409).send({ code: "CLIP_TAKEN",
      error: `Bu kelimenin kayıt kimliği bir sabit cümlede kullanılıyor: ${taken.join(", ")}. Önce o satırın kimliğini değiştirin.` });
    const e = await checkAsset(w.icon, "image");
    if (e) return reply.code(400).send({ error: e });
    const now = Date.now();
    await run(`INSERT INTO words(id, en, tr, about, kind, color, icon, builtin, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`, w.id, w.en, w.tr, w.about, w.kind, w.color, w.icon, now, now);
    reply.code(201);
    return (await wordsById([w.id]))[0];
  }));

  app.patch("/words/:id", (req, reply) => tx(async () => {
    const id = (req.params as { id: string }).id;
    const b = WordPatch.safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    const cur = await one<WordRow>("SELECT * FROM words WHERE id = ?", id);
    if (!cur) return reply.code(404).send({ error: "Kelime yok" });
    if (staleFor(req, cur.updated_at))
      return reply.code(409).send({ code: "STALE", error: "Bu kelime başka bir yerde değişti.", current: (await wordsById([id]))[0] });
    /* the app's own words are the app's: a phone draws them from its bundle,
       so a change here would only ever show in the panel */
    if (cur.builtin && Object.values(b.data).some((v) => v !== undefined))
      return reply.code(400).send({ error: "Bu kelime uygulamanın kendi kelimesi; metni, rengi ve resmi uygulamada değişir. Kayıt eklenebilir." });
    const e = await checkAsset(b.data.icon, "image");
    if (e) return reply.code(400).send({ error: e });
    const n = { ...cur, ...b.data };
    await run(`UPDATE words SET en = ?, tr = ?, about = ?, kind = ?, color = ?, icon = ?, updated_at = ? WHERE id = ?`,
        n.en, n.tr, n.about, n.kind, n.color, n.icon ?? null, nextStamp(cur.updated_at), id);
    return (await wordsById([id]))[0];
  }));

  app.delete("/words/:id", (req, reply) => tx(async () => {
    const id = (req.params as { id: string }).id;
    const w = await one<WordRow>("SELECT * FROM words WHERE id = ?", id);
    if (!w) return reply.code(404).send({ error: "Kelime yok" });
    if (w.builtin) return reply.code(400).send({ error: "Uygulamanın kendi kelimesi silinemez." });
    const used = await all<{ set_id: string }>("SELECT set_id FROM set_words WHERE word_id = ?", id);
    if (used.length) return reply.code(400).send({ error: `Bu kelime şu setlerde: ${used.map((u) => u.set_id).join(", ")}. Önce setlerden çıkarın.` });
    await run("DELETE FROM words WHERE id = ?", id);
    return { ok: true };
  }));

  /* a recording for one slot: the asset (uploaded, or made by the voice
     studio) and the text it was made from -- a word whose text changed since
     is "stale" in the panel */
  app.put("/words/:id/audio/:slot", (req, reply) => tx(async () => {
    const { id, slot } = req.params as { id: string; slot: string };
    if (!(SLOTS as readonly string[]).includes(slot)) return reply.code(400).send({ error: `Bilinmeyen yuva: ${slot}` });
    if (!(await one("SELECT id FROM words WHERE id = ?", id))) return reply.code(404).send({ error: "Kelime yok" });
    const b = AudioIn.safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    const e = await checkAsset(b.data.asset, "audio");
    if (e) return reply.code(400).send({ error: e });
    await run(`INSERT INTO word_audio(word_id, slot, asset, text, updated_at, duration_ms) VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(word_id, slot) DO UPDATE SET asset = excluded.asset, text = excluded.text,
           updated_at = excluded.updated_at, duration_ms = excluded.duration_ms`,
        id, slot, b.data.asset, b.data.text, Date.now(), b.data.durationMs ?? null);
    return (await wordsById([id]))[0];
  }));
  app.delete("/words/:id/audio/:slot", (req) => tx(async () => {
    const { id, slot } = req.params as { id: string; slot: string };
    await run("DELETE FROM word_audio WHERE word_id = ? AND slot = ?", id, slot);
    return (await wordsById([id]))[0] ?? { ok: true };
  }));

  /* ── sets ── */
  app.get("/sets", async () => allSets());
  app.get("/sets/:id", async (req, reply) =>
    (await setById((req.params as { id: string }).id)) ?? reply.code(404).send({ error: "Set yok" }));

  app.post("/sets", (req, reply) => tx(async () => {
    const b = SetIn.safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    const missing = await missingWords(b.data.words);
    if (missing.length) return reply.code(400).send({ error: `Kelime yok: ${missing.join(", ")}` });
    let id = b.data.id ?? slug(b.data.name);
    for (let n = 2; await one("SELECT id FROM sets WHERE id = ?", id); n++) id = `${slug(b.data.name)}-${n}`;
    const now = Date.now();
    await run("INSERT INTO sets(id, name, note, builtin, created_at, updated_at) VALUES(?, ?, ?, 0, ?, ?)",
        id, b.data.name, b.data.note, now, now);
    await putSetWords(id, b.data.words);
    reply.code(201);
    return setById(id);
  }));

  app.patch("/sets/:id", (req, reply) => tx(async () => {
    const id = (req.params as { id: string }).id;
    const s = await setById(id);
    if (!s) return reply.code(404).send({ error: "Set yok" });
    const b = SetPatch.safeParse(req.body);
    if (!b.success) return bad(reply, b.error);
    if (staleFor(req, s.updatedAt))
      return reply.code(409).send({ code: "STALE", error: "Bu set başka bir yerde değişti.", current: s });
    if (s.builtin && b.data.words !== undefined) return reply.code(400).send({ error: "Uygulamanın kendi setinin kelimeleri uygulamada değişir." });
    if (b.data.words) {
      if (new Set(b.data.words).size !== b.data.words.length) return reply.code(400).send({ error: "Aynı kelime iki kez" });
      const missing = await missingWords(b.data.words);
      if (missing.length) return reply.code(400).send({ error: `Kelime yok: ${missing.join(", ")}` });
    }
    await run("UPDATE sets SET name = ?, note = ?, updated_at = ? WHERE id = ?",
        b.data.name ?? s.name, b.data.note ?? s.note, nextStamp(s.updatedAt), id);
    if (b.data.words) await putSetWords(id, b.data.words);
    return setById(id);
  }));

  app.delete("/sets/:id", (req, reply) => tx(async () => {
    const id = (req.params as { id: string }).id;
    const s = await setById(id);
    if (!s) return reply.code(404).send({ error: "Set yok" });
    if (s.builtin) return reply.code(400).send({ error: "Uygulamanın kendi seti silinemez." });
    if (s.usedBy.games.length || s.usedBy.categories.length)
      return reply.code(400).send({ error: `Bu seti kullananlar var: ${[...s.usedBy.games, ...s.usedBy.categories].join(", ")}` });
    await run("DELETE FROM sets WHERE id = ?", id);
    return { ok: true };
  }));
}
