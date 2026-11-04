/**
 * The panel's STUDIO document: voices, the fixed lines and which take each
 * uses, every take, directions, image generations, settings. Saved whole with
 * a revision number, so two open panels cannot silently overwrite each other:
 * a save that names an old revision is refused with the current document (409).
 *
 * The CONTENT -- words, sets, games, categories -- is not in it any more: it
 * lives in tables (`vocab.ts`, `games.ts`, `categories.ts`), one row each,
 * referenced instead of copied. An old document's `sets` are kept as they were
 * (and taken into the vocabulary once, `migrate-json.ts`), never read again.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { config } from "../config.js";
import { one, run, tx } from "../storage/sql.js";
import { assetMap } from "../storage/files.js";
import { isWordClip } from "./vocab.js";

export interface Stored { rev: number; savedAt: string; data: unknown }

export async function readDocument(name: string): Promise<Stored | null> {
  const r = await one<{ rev: number; saved_at: string; data: string }>("SELECT rev, saved_at, data FROM documents WHERE name = ?", name);
  return r ? { rev: r.rev, savedAt: r.saved_at, data: JSON.parse(r.data) } : null;
}

export async function writeDocument(name: string, data: unknown, rev: number): Promise<Stored> {
  const savedAt = new Date().toISOString();
  await tx(async () => {
    const cur = await one<{ rev: number; saved_at: string; data: string }>("SELECT rev, saved_at, data FROM documents WHERE name = ?", name);
    if (cur) {
      await run("INSERT INTO document_history(name, rev, saved_at, data) VALUES(?, ?, ?, ?)", name, cur.rev, cur.saved_at, cur.data);
      await run(`DELETE FROM document_history WHERE name = ? AND id NOT IN
             (SELECT id FROM document_history WHERE name = ? ORDER BY id DESC LIMIT ?)`, name, name, config.history);
    }
    await run(`INSERT INTO documents(name, rev, saved_at, data) VALUES(?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET rev = excluded.rev, saved_at = excluded.saved_at, data = excluded.data`,
        name, rev, savedAt, JSON.stringify(data));
  });
  return { rev, savedAt, data };
}

/*
 * THE SHAPE (S07). Every part the server reads -- the fixed lines and their
 * approved takes go into releases, the takes and pictures are the archive
 * that keeps files from being deleted -- is checked before anything is
 * stored; a wrong document is refused (400) and the stored one stays.
 *
 * Compatibility: fields the server does not know are kept as they are and
 * never read (an older document's `sets`, a newer panel's additions); the
 * known parts must have their shape. `version` names this shape.
 */
const assetRef = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/, "dosya kimliği");
export const CLIP = /^(teacher|otter|bunny|animal|sfx)\/[a-z0-9_]{1,80}$/;
const Speaker = z.enum(["teacher", "otter", "bunny"]);
const Line = z.looseObject({
  clip: z.string().regex(CLIP, "kayıt kimliği: konuşan/ad (küçük harf, rakam, _)"),
  speaker: Speaker, text: z.string().min(1).max(600), group: z.string().max(80),
  approved: assetRef.optional(),
  /** the text the approved take was confirmed for, when it was approved for a changed text (A08) */
  approvedText: z.string().max(600).optional(),
});
/** a child's own language (the teacher's lines); Turkish is the app's and needs no entry */
const LANG = /^[a-z]{2}$/;
const Lang = z.string().regex(LANG, "dil kodu: iki küçük harf (it, de, es …)");
const Take = z.looseObject({
  id: z.string().max(80), clip: z.string().regex(CLIP), asset: assetRef, text: z.string().max(5000),
  source: z.enum(["eleven", "upload"]), createdAt: z.number(),
  /** the language it is in, when it is not the app's Turkish (or the shared English) */
  lang: Lang.optional(),
  /** a frame's take: where its pause is, [end of part 1, start of part 2] s */
  cut: z.tuple([z.number().positive().max(120), z.number().positive().max(120)])
    .refine(([a, b]) => b > a, "boşluğun sonu başından sonra olmalı").optional(),
});
const Voice = z.looseObject({
  speaker: Speaker, voiceId: z.string().max(80), enVoiceId: z.string().max(80).optional(), model: z.string().max(80),
  similarity: z.number().min(0).max(1), style: z.number().min(0).max(1), speed: z.number().min(0.5).max(2),
  /** the isolated English words' own speed (2026-10-24) */
  enSpeed: z.number().min(0.5).max(2).optional(),
  /** a different voice for this speaker in another language */
  langVoices: z.record(Lang, z.string().max(80)).optional(),
});
const Language = z.looseObject({
  code: Lang, name: z.string().trim().min(1).max(40),
  /** how the teacher gives a word's meaning: "In italiano, %." */
  meaningTemplate: z.string().max(120).refine((t) => t.includes("%"), "şablonda % olmalı (anlamın yeri)"),
});
const WordText = z.looseObject({ meaning: z.string().max(200).optional(), about: z.string().max(600).optional(),
                                  parts: z.array(z.string().max(300)).max(3).optional() });
const Translation = z.looseObject({
  words: z.record(z.string().max(80), WordText).default({}),
  lines: z.record(z.string().regex(CLIP), z.string().max(600)).default({}),
});
const LocaleTake = z.object({ asset: assetRef, text: z.string().max(5000) });
/** a free take from the workshop tab: not a line of the app's script */
const Workshop = z.looseObject({
  id: z.string().max(80), name: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/, "dosya adı: harf, rakam, _ ve -"),
  text: z.string().max(5000), tag: z.string().max(200), lang: z.string().max(8), voiceId: z.string().max(80),
  model: z.string().max(80), asset: assetRef, createdAt: z.number(),
});
const Gen = z.looseObject({
  id: z.string().max(80), asset: assetRef, kind: z.enum(["icon", "background"]), provider: z.enum(["openai", "gemini"]),
  model: z.string().max(80), prompt: z.string().max(8000), subject: z.string().max(200), createdAt: z.number(),
});
export const Doc = z.looseObject({
  version: z.literal(1),
  voices: z.array(Voice).max(10).default([]),
  lines: z.array(Line).max(5000).default([]),
  takes: z.array(Take).max(50000).default([]),
  directions: z.record(z.string().max(100), z.object({ tag: z.string().max(200), stability: z.number().min(0).max(1) })).default({}),
  seed: z.number().int().default(4242),
  gens: z.array(Gen).max(20000).default([]),
  imageSettings: z.looseObject({ provider: z.enum(["openai", "gemini"]), openaiModel: z.string().max(80),
                                 geminiModel: z.string().max(80) }).optional(),
  /* the children's other languages (decision, 2026-10-16): their texts, and
     the take in use per line -- by the same clip id, under the language */
  languages: z.array(Language).max(30).default([]),
  i18n: z.record(Lang, Translation).default({}),
  localeApproved: z.record(Lang, z.record(z.string().regex(CLIP), LocaleTake)).default({}),
  /* English words said inside another language's sentence: how, in IPA */
  pron: z.record(z.string().max(60), z.object({ ipa: z.string().max(120) })).default({}),
  pronDict: z.looseObject({ id: z.string().max(80), version: z.string().max(80).nullable(), hash: z.string().max(80) }).optional(),
  workshop: z.array(Workshop).max(20000).default([]),
});
const Save = z.object({ rev: z.number().int().min(0), db: z.unknown() });
/** a document larger than this is a mistake, not a studio */
export const DOC_MAX_BYTES = 20 * 1024 * 1024;

/** what is wrong with a document, or null; `prev` decides which clash is new */
export async function docProblem(raw: unknown, prev: unknown): Promise<string | null> {
  const d = Doc.safeParse(raw);
  if (!d.success) {
    const i = d.error.issues[0];
    return `Geçersiz stüdyo belgesi: ${i?.path.join(".") || "kök"} — ${i?.message}`;
  }
  if (JSON.stringify(raw).length > DOC_MAX_BYTES) return "Stüdyo belgesi çok büyük.";
  const seen = new Set<string>();
  for (const l of d.data.lines) {
    if (seen.has(l.clip)) return `"${l.clip}" kimliği iki sabit cümlede kullanılıyor.`;
    seen.add(l.clip);
  }
  const langs = new Set<string>();
  for (const l of d.data.languages) {
    if (l.code === "tr" || l.code === "en") return `"${l.code}" ayrıca eklenmez: Türkçe uygulamanın dili, İngilizce öğretilen dil.`;
    if (langs.has(l.code)) return `"${l.code}" dili iki kez eklenmiş.`;
    langs.add(l.code);
  }
  const assets = await assetMap();
  for (const [code, lines] of Object.entries(d.data.localeApproved))
    for (const [clip, t] of Object.entries(lines)) {
      const a = assets.get(t.asset);
      if (!a || a.kind !== "audio") return `${code} · "${clip}" kaydı (${t.asset}) bir ses dosyası değil ya da yok.`;
    }
  for (const l of d.data.lines) {
    if (!l.approved) continue;
    const a = assets.get(l.approved);
    if (!a) return `"${l.clip}" satırının onaylı kaydı (${l.approved}) yok.`;
    if (a.kind !== "audio") return `"${l.clip}" satırının onaylı kaydı bir ses dosyası değil.`;
  }
  /* A09: a word's clip ids are the word's. A clash already in the stored
     document is not refused (that would lock every save) -- the release
     skips it and lists it -- but no new one is let in */
  const before = new Set(Array.isArray((prev as { lines?: { clip: string }[] } | null)?.lines)
    ? (prev as { lines: { clip: string }[] }).lines.map((l) => l.clip) : []);
  const clash: string[] = [];
  for (const l of d.data.lines) if (!before.has(l.clip) && await isWordClip(l.clip)) clash.push(l.clip);
  if (clash.length) return `Bu kimlikler bir kelimenin kaydına ait: ${clash.join(", ")}. Sabit cümleye başka bir kimlik verin.`;
  return null;
}

export async function contentRoutes(app: FastifyInstance) {
  app.get("/db", async (_req, reply) => {
    const s = await readDocument("studio");
    if (!s) return reply.code(404).send({ rev: 0, db: null });
    return { rev: s.rev, savedAt: s.savedAt, db: s.data };
  });

  /* one transaction: the revision checked is the revision replaced */
  app.put("/db", (req, reply) => tx(async () => {
    const body = Save.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Geçersiz belge", detail: body.error.issues.slice(0, 5) });
    const cur = await readDocument("studio");
    const problem = await docProblem(body.data.db, cur?.data ?? null);
    if (problem) return reply.code(400).send({ code: "BAD_DOCUMENT", error: problem });
    const rev = cur?.rev ?? 0;
    if (body.data.rev !== rev) return reply.code(409).send({ error: "Belge başka bir yerde değişti", rev, db: cur?.data ?? null });
    const saved = await writeDocument("studio", body.data.db, rev + 1);
    return { rev: saved.rev, savedAt: saved.savedAt };
  }));
}
