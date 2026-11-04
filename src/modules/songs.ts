/**
 * MÜZİK (the panel's "Müzik", 2026-10-17): the song at the end of every row.
 *
 * Every category ends at a MUSIC STOP on the map: the words of the row sung,
 * the stop counted only once the song has played to its end. The app's own
 * six stops had no songs (a "Devam" placeholder, held back in a release); a
 * land's music stop took a file from the roadmap editor. A SONG here is the
 * one place a song is made and kept, for any music stop:
 *
 *   brief     which words it sings, the language, the theme, mascots in it
 *   lyrics    typed, or written by an AI (Claude, ChatGPT, Gemini) as a paid
 *             JOB -- every draft kept, none lost
 *   style     voice, genre, tempo, mood, instruments -> Suno's "style of
 *             music" text, plus what to leave out
 *   takes     audio files: made on suno.com and dropped here, or uploaded
 *             from anywhere -- one is chosen
 *   license   where it came from and with which plan. Suno's FREE plan is not
 *             for commercial use (the songs stay Suno's): such a take never
 *             goes into the app. Pro/Premier, or a file whose rights a person
 *             confirmed, may.
 *
 * SUNO'S API: Suno has no public API (2026-10; a partner programme by intake
 * form). The key can be stored now (Ayarlar); `POST /songs/:id/suno` answers
 * NOT_AVAILABLE until the official API is wired here from its documentation.
 * Unofficial gateways are deliberately not used (user decision, 2026-10-17).
 *
 *   admin   GET /songs · POST /songs · PATCH/DELETE /songs/:id
 *           POST /songs/:id/lyrics (job) · POST /songs/:id/suno
 *           GET /ai/text-models/:provider
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { all, one, run, tx } from "../storage/sql.js";
import { getAsset, type AssetRow } from "../storage/files.js";
import { latestInventory } from "./inventory.js";
import { loadSlides } from "./roadmap.js";
import { loadCategories } from "./categories.js";
import { setWords, type Issue } from "./checks.js";
import { slug } from "./games.js";
import { nextStamp, staleFor } from "./vocab.js";
import { Upstream, anthropicHeaders, call, check, failReply, key } from "./ai.js";
import { endJob, jobIdOk, openJob } from "./jobs.js";

export type LyricsProvider = "anthropic" | "openai" | "gemini";
export interface Brief {
  language: "en" | "en-tr";
  words: string[];          /* word ids it must sing */
  theme: string;            /* "a picnic in the meadow" */
  mascots: boolean;         /* Lili and Kuki sing along */
  length: "short" | "normal";
  extra: string;            /* anything else for the writer */
}
export interface Style {
  voice: "female" | "male" | "kids" | "duet" | "instrumental";
  genre: string; tempo: "slow" | "medium" | "fast"; bpm: number | null;
  mood: string; instruments: string[]; text: string; exclude: string;
}
export interface Take {
  asset: string; source: "suno-web" | "suno-api" | "upload";
  durationMs: number | null; note: string; at: number;
}
export interface Draft { jobId: string; provider: LyricsProvider; model: string; title: string; lyrics: string; style: string; at: number }
export interface License {
  plan: "free" | "pro" | "premier" | "other" | null;
  /** the account the song was made with (Suno) or who owns it (upload) */
  owner: string; madeAt: string;
  /** for a file not made on Suno: a person confirmed the right to use it */
  confirmed: boolean; note: string;
}
interface SongRow {
  id: string; title: string; stop: string; brief: string; lyrics: string; style: string; drafts: string;
  takes: string; chosen: string | null; license: string; status: "live" | "draft" | "hidden"; note: string;
  created_at: number; updated_at: number;
}
export interface Song {
  id: string; title: string; stop: string; brief: Brief; lyrics: string; style: Style; drafts: Draft[];
  takes: Take[]; chosen: string | null; license: License; status: SongRow["status"]; note: string;
  createdAt: number; updatedAt: number;
}

const DEF_BRIEF: Brief = { language: "en", words: [], theme: "", mascots: true, length: "normal", extra: "" };
const DEF_STYLE: Style = { voice: "female", genre: "children's song", tempo: "medium", bpm: null, mood: "happy, bouncy",
                           instruments: ["ukulele", "glockenspiel", "hand claps"], text: "", exclude: "" };
const DEF_LICENSE: License = { plan: null, owner: "", madeAt: "", confirmed: false, note: "" };

const row = (id: string) => one<SongRow>("SELECT * FROM songs WHERE id = ?", id);
const asSong = (r: SongRow): Song => ({
  id: r.id, title: r.title, stop: r.stop,
  brief: { ...DEF_BRIEF, ...JSON.parse(r.brief || "{}") }, lyrics: r.lyrics,
  style: { ...DEF_STYLE, ...JSON.parse(r.style || "{}") }, drafts: JSON.parse(r.drafts || "[]"),
  takes: JSON.parse(r.takes || "[]"), chosen: r.chosen, license: { ...DEF_LICENSE, ...JSON.parse(r.license || "{}") },
  status: r.status, note: r.note, createdAt: r.created_at, updatedAt: r.updated_at,
});
export const loadSongs = async (): Promise<Song[]> =>
  (await all<SongRow>(`SELECT * FROM songs ORDER BY created_at, id COLLATE "C"`)).map(asSong);

/* ── where songs go: every music stop there is ──────────────────────────── */

export interface MusicStop {
  id: string; title: string; category: string | null; words: string[];
  /** the app's own (from its inventory) or a land of the roadmap */
  kind: "app" | "land"; land?: string;
}

/** every music stop: the app's own six and every land's */
export async function musicStops(): Promise<MusicStop[]> {
  const inv = latestInventory();
  const own = (inv?.songs?.stops ?? []).map((s) => ({
    id: s.id, title: s.title, category: s.category, kind: "app" as const,
    words: inv?.categories.find((c) => c.id === s.category)?.set
      ? (inv!.sets.find((x) => x.id === inv!.categories.find((c) => c.id === s.category)!.set)?.words ?? []) : [],
  }));
  const cats = await loadCategories();
  /* a land's row sings the words of its category's set */
  const words = new Map<string, string[]>();
  for (const c of cats) if (c.set_id && !words.has(c.set_id)) words.set(c.set_id, (await setWords(c.set_id)).map((w) => w.id));
  const lands = (await loadSlides()).flatMap((sl) => (JSON.parse(sl.stops) as { id: string; kind: string; category: string }[])
    .filter((st) => st.kind === "music").map((st) => {
      /* a land's row sings the words of the category its other stops open */
      const others = (JSON.parse(sl.stops) as { kind: string; category: string }[]).filter((x) => x.kind !== "music" && x.category);
      const cat = cats.find((c) => c.id === others[others.length - 1]?.category) ?? null;
      return { id: st.id, title: `${sl.title} · müzik`, category: cat?.id ?? null, kind: "land" as const, land: sl.id,
               words: cat?.set_id ? words.get(cat.set_id) ?? [] : [] };
    }));
  return [...own, ...lands];
}

/** the live song of a stop, if any (one per stop) */
export const liveSongOf = async (stop: string): Promise<Song | undefined> =>
  (await loadSongs()).find((s) => s.stop === stop && s.status === "live");

/* ── checks ───────────────────────────────────────────────────────────────── */

const WORD = (w: string) => new RegExp(`(^|[^\\p{L}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(s|es)?([^\\p{L}]|$)`, "iu");

/**
 * What keeps a song out of the app. `known` is what the check needs to look
 * up -- the stops, the songs, the chosen file, the words' English -- read
 * by `songFacts`, once for a whole list.
 */
export interface SongFacts { stops: MusicStop[]; songs: Song[]; asset: (id: string) => AssetRow | undefined; en: (id: string) => string }

export async function songFacts(): Promise<SongFacts> {
  const [stops, songs, assets, words] = await Promise.all([
    musicStops(), loadSongs(), all<AssetRow>("SELECT * FROM assets WHERE kind = 'audio'"), all<{ id: string; en: string }>("SELECT id, en FROM words")]);
  const a = new Map(assets.map((x) => [x.id, x])), w = new Map(words.map((x) => [x.id, x.en]));
  return { stops, songs, asset: (id) => a.get(id), en: (id) => w.get(id) ?? id };
}

export function checkSong(s: Song, f: SongFacts): Issue[] {
  const { stops } = f;
  const enOf = f.en;
  const out: Issue[] = [];
  const err = (text: string) => out.push({ level: "error", text });
  const warn = (text: string) => out.push({ level: "warn", text });
  if (!s.title.trim()) err("Adı yok.");
  const stop = stops.find((x) => x.id === s.stop);
  if (!stop) err(`Müzik durağı "${s.stop}" yok.`);
  const take = s.takes.find((t) => t.asset === s.chosen);
  if (!s.chosen || !take) err("Seçilmiş bir ses dosyası yok: Suno'da üretip yükleyin ya da bir dosya yükleyin.");
  else {
    const a = f.asset(s.chosen);
    if (!a || a.kind !== "audio") err("Seçilen dosya bir ses dosyası değil ya da silinmiş.");
    if (take.source !== "upload" && (s.license.plan === "free" || !s.license.plan))
      err(s.license.plan === "free"
        ? "Suno'nun ücretsiz planıyla üretilen şarkı ticari kullanılamaz (şarkı Suno'nundur): Pro ya da Premier hesapla yeniden üretin."
        : "Şarkının hangi Suno planıyla üretildiği yazılmadı: ticari kullanım yalnız Pro/Premier'de.");
    if (take.source === "upload" && !s.license.confirmed)
      err("Yüklenen dosyanın kullanım hakkı onaylanmadı (kim yaptı, hangi lisansla).");
    if (take.durationMs !== null) {
      const sec = take.durationMs / 1000;
      if (sec < 30) err(`Şarkı ${Math.round(sec)} sn: durak şarkı bitince sayılır, bu çok kısa.`);
      else if (sec < 55 || sec > 100) warn(`Şarkı ${Math.round(sec)} sn; bu durak için 60–90 sn önerilir (çocuk sonuna kadar dinler).`);
    }
  }
  if (s.style.voice !== "instrumental") {
    if (!s.lyrics.trim()) warn("Sözler yazılmadı (yalnız panelde: hangi kelimelerin söylendiği görülemez).");
    else {
      const missing = s.brief.words.filter((w) => !WORD(enOf(w)).test(s.lyrics));
      if (missing.length) warn(`Sözlerde geçmeyen kelimeler: ${missing.map(enOf).join(", ")}.`);
    }
  }
  const other = f.songs.find((x) => x.id !== s.id && x.stop === s.stop && x.status === "live");
  if (other && s.status === "live") warn(`Bu durakta "${other.title}" de uygulamada; yalnız biri çalar.`);
  return out;
}

export const songsOut = async () => {
  const f = await songFacts();
  return f.songs.map((s) => ({ ...s, issues: checkSong(s, f) }));
};

/* ── lyrics: the brief, as a writer is asked ─────────────────────────────── */

const SYSTEM = `You write ORIGINAL songs for an app that teaches English to Turkish-speaking children aged 4 to 8.
The song is sung at the end of a lesson row: the child has just met the target words and now sings them.
Rules:
- Every target word is sung clearly at least twice, the most important ones in the chorus.
- Very simple English (CEFR pre-A1/A1): short lines, present tense, concrete things, lots of repetition.
- A catchy chorus repeated at least twice; call-and-response lines are welcome ("Can you say apple? Apple!").
- Warm, playful, safe: nothing scary, sad, violent, no brands, no real people, no copying of existing songs or melodies.
- Structure with Suno section tags on their own lines: [Intro], [Verse 1], [Chorus], [Verse 2], [Chorus], optional [Bridge], [Outro].
- Length: "normal" = about 60-90 seconds sung (about 14-22 lines); "short" = about 45-60 seconds.
- If the language is "en-tr": English lines, plus at most a few very short Turkish lines that give a word's meaning ("Elma! Apple!"); never mix both languages inside one line otherwise.
- Also propose a Suno "style of music" text (max 200 characters, English, comma-separated: genre, tempo/BPM, vocal, instruments, mood).
Answer with ONLY a JSON object: {"title": "...", "lyrics": "...", "style": "..."}.`;

function userPrompt(b: Brief, words: { en: string; tr: string }[], names: { learner: string; friend: string } | null) {
  return [
    `Target words (English = Turkish meaning): ${words.map((w) => `${w.en} = ${w.tr}`).join(", ")}.`,
    `Language: ${b.language}. Length: ${b.length}.`,
    b.theme ? `Theme / scene: ${b.theme}.` : "",
    b.mascots && names ? `The two friends in the app may appear by name: ${names.learner} (a bunny) and ${names.friend} (an otter).` : "",
    b.extra ? `Also: ${b.extra}` : "",
  ].filter(Boolean).join("\n");
}

/** a JSON object out of a model's answer (fenced or not) */
function parseLyrics(text: string): { title: string; lyrics: string; style: string } {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) throw new Upstream(502, "Yapay zekâ beklenen biçimde (JSON) cevap vermedi.");
  let j: { title?: unknown; lyrics?: unknown; style?: unknown };
  try { j = JSON.parse(m[0]); } catch { throw new Upstream(502, "Yapay zekânın cevabı okunamadı (JSON bozuk)."); }
  const lyrics = typeof j.lyrics === "string" ? j.lyrics.trim() : "";
  if (!lyrics) throw new Upstream(502, "Yapay zekâ söz yazmadı.");
  return { title: String(j.title ?? "").trim().slice(0, 80), lyrics: lyrics.slice(0, 6000), style: String(j.style ?? "").trim().slice(0, 400) };
}

/** how long a writer may take */
const TEXT_MS = 120_000;

async function writeLyrics(provider: LyricsProvider, model: string, user: string): Promise<string> {
  if (provider === "anthropic") {
    const r = await check(await call("Claude", "https://api.anthropic.com/v1/messages", {
      method: "POST", headers: anthropicHeaders(await key("anthropic")),
      body: JSON.stringify({ model, max_tokens: 4000, system: SYSTEM, messages: [{ role: "user", content: user }] }),
    }, TEXT_MS), "Claude");
    const j = await r.json() as { content?: { type: string; text?: string }[] };
    return (j.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
  }
  if (provider === "openai") {
    const r = await check(await call("OpenAI", "https://api.openai.com/v1/chat/completions", {
      method: "POST", headers: { Authorization: `Bearer ${await key("openai")}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, response_format: { type: "json_object" },
                             messages: [{ role: "system", content: SYSTEM }, { role: "user", content: user }] }),
    }, TEXT_MS), "OpenAI");
    const j = await r.json() as { choices?: { message?: { content?: string } }[] };
    return j.choices?.[0]?.message?.content ?? "";
  }
  const r = await check(await call("Gemini", `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: "POST", headers: { "x-goog-api-key": await key("gemini"), "Content-Type": "application/json" },
    body: JSON.stringify({ systemInstruction: { parts: [{ text: SYSTEM }] }, contents: [{ role: "user", parts: [{ text: user }] }],
                           generationConfig: { responseMimeType: "application/json" } }),
  }, TEXT_MS), "Gemini");
  const j = await r.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  return (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
}

/** the text models a provider offers, newest first where it says so */
async function textModels(p: LyricsProvider): Promise<string[]> {
  if (p === "anthropic") {
    const r = await check(await call("Claude", "https://api.anthropic.com/v1/models?limit=100", { headers: anthropicHeaders(await key("anthropic")) }, 20_000), "Claude");
    const j = await r.json() as { data?: { id: string }[] };
    return (j.data ?? []).map((m) => m.id);
  }
  if (p === "openai") {
    const r = await check(await call("OpenAI", "https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${await key("openai")}` } }, 20_000), "OpenAI");
    const j = await r.json() as { data?: { id: string; created?: number }[] };
    return (j.data ?? []).filter((m) => /^(gpt|o\d|chatgpt)/.test(m.id) && !/(image|audio|realtime|tts|transcribe|search|embedding)/.test(m.id))
      .sort((a, b) => (b.created ?? 0) - (a.created ?? 0)).map((m) => m.id);
  }
  const r = await check(await call("Gemini", "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": await key("gemini") } }, 20_000), "Gemini");
  const j = await r.json() as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
  return (j.models ?? []).filter((m) => m.supportedGenerationMethods?.includes("generateContent") && /gemini/.test(m.name)
    && !/(image|tts|embedding|vision)/.test(m.name)).map((m) => m.name.replace(/^models\//, ""));
}

/* ── routes ───────────────────────────────────────────────────────────────── */

const BriefIn = z.object({
  language: z.enum(["en", "en-tr"]), words: z.array(z.string().max(60)).max(20), theme: z.string().max(300),
  mascots: z.boolean(), length: z.enum(["short", "normal"]), extra: z.string().max(600),
});
const StyleIn = z.object({
  voice: z.enum(["female", "male", "kids", "duet", "instrumental"]), genre: z.string().max(80),
  tempo: z.enum(["slow", "medium", "fast"]), bpm: z.number().int().min(50).max(200).nullable(),
  mood: z.string().max(120), instruments: z.array(z.string().max(40)).max(12), text: z.string().max(1000), exclude: z.string().max(400),
});
const TakeIn = z.object({ asset: z.string().max(80), source: z.enum(["suno-web", "suno-api", "upload"]),
                          durationMs: z.number().int().min(0).max(30 * 60_000).nullable(), note: z.string().max(300), at: z.number() });
const LicenseIn = z.object({ plan: z.enum(["free", "pro", "premier", "other"]).nullable(), owner: z.string().max(120),
                             madeAt: z.string().max(40), confirmed: z.boolean(), note: z.string().max(600) });
const Patch = z.object({
  title: z.string().trim().min(1).max(80).optional(), stop: z.string().max(80).optional(),
  brief: BriefIn.optional(), lyrics: z.string().max(8000).optional(), style: StyleIn.optional(),
  takes: z.array(TakeIn).max(40).optional(), chosen: z.string().max(80).nullable().optional(),
  license: LicenseIn.optional(), status: z.enum(["live", "draft", "hidden"]).optional(), note: z.string().max(600).optional(),
});

export async function songRoutes(app: FastifyInstance) {
  app.get("/songs", async () => ({ stops: await musicStops(), songs: await songsOut() }));

  app.post("/songs", (req, reply) => tx(async () => {
    const b = z.object({ title: z.string().trim().min(1).max(80), stop: z.string().max(80),
                         /* the panel's operation id: the same request twice makes ONE song */
                         op: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/, "işlem kimliği").optional() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "Ad ve durak gerekli" });
    if (b.data.op) {
      const had = await one<{ id: string }>("SELECT id FROM songs WHERE op = ?", b.data.op);
      if (had) return (await songsOut()).find((s) => s.id === had.id);
    }
    const stop = (await musicStops()).find((s) => s.id === b.data.stop);
    if (!stop) return reply.code(400).send({ error: "Böyle bir müzik durağı yok" });
    let id = slug(b.data.title);
    for (let n = 2; await row(id); n++) id = `${slug(b.data.title)}-${n}`;
    const now = Date.now();
    /* the brief starts from the stop's row: its words, sung in English */
    const brief: Brief = { ...DEF_BRIEF, words: stop.words.slice(0, 12) };
    await run(`INSERT INTO songs(id, title, stop, brief, style, license, created_at, updated_at, op) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, b.data.title, stop.id, JSON.stringify(brief), JSON.stringify(DEF_STYLE), JSON.stringify(DEF_LICENSE), now, now, b.data.op ?? null);
    reply.code(201);
    return (await songsOut()).find((s) => s.id === id);
  }));

  app.patch("/songs/:id", (req, reply) => tx(async () => {
    const sid = (req.params as { id: string }).id;
    const r = await row(sid);
    if (!r) return reply.code(404).send({ error: "Şarkı yok" });
    const b = Patch.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: b.error.issues[0]?.message ?? "Geçersiz istek" });
    if (staleFor(req, r.updated_at)) return reply.code(409).send({ code: "STALE", error: "Bu şarkı başka bir yerde değişti." });
    const d = b.data, cur = asSong(r);
    for (const t of d.takes ?? []) if ((await getAsset(t.asset))?.kind !== "audio") return reply.code(400).send({ error: `"${t.asset}" bir ses dosyası değil.` });
    const next: Song = {
      ...cur, title: d.title ?? cur.title, stop: d.stop ?? cur.stop, brief: d.brief ?? cur.brief, lyrics: d.lyrics ?? cur.lyrics,
      style: d.style ?? cur.style, takes: d.takes ?? cur.takes, chosen: d.chosen !== undefined ? d.chosen : cur.chosen,
      license: d.license ?? cur.license, status: d.status ?? cur.status, note: d.note ?? cur.note,
    };
    if (next.chosen && !next.takes.some((t) => t.asset === next.chosen)) next.chosen = null;
    if (next.status === "live") {
      const issues = checkSong(next, await songFacts());
      if (issues.some((i) => i.level === "error")) return reply.code(400).send({ error: "Hatası olan şarkı uygulamaya konamaz.", issues });
    }
    /* one song per stop in the app: this one takes the stop -- the other
       steps down FIRST, since the database holds the rule too (migration 3:
       a second live song at a stop is refused, even for an instant) */
    if (next.status === "live")
      for (const o of await all<{ id: string; updated_at: number }>("SELECT id, updated_at FROM songs WHERE stop = ? AND status = 'live' AND id != ?", next.stop, sid))
        await run("UPDATE songs SET status = 'draft', updated_at = ? WHERE id = ?", nextStamp(o.updated_at), o.id);
    await run(`UPDATE songs SET title = ?, stop = ?, brief = ?, lyrics = ?, style = ?, takes = ?, chosen = ?, license = ?, status = ?, note = ?,
           updated_at = ? WHERE id = ?`, next.title, next.stop, JSON.stringify(next.brief), next.lyrics, JSON.stringify(next.style),
        JSON.stringify(next.takes), next.chosen, JSON.stringify(next.license), next.status, next.note, nextStamp(r.updated_at), sid);
    return (await songsOut()).find((s) => s.id === sid);
  }));

  app.delete("/songs/:id", (req, reply) => tx(async () => {
    const sid = (req.params as { id: string }).id;
    if (!(await row(sid))) return reply.code(404).send({ error: "Şarkı yok" });
    await run("DELETE FROM songs WHERE id = ?", sid);
    return { ok: true };
  }));

  /* lyrics from an AI: a paid job, its every draft kept on the song */
  app.post("/songs/:id/lyrics", async (req, reply) => {
    const sid = (req.params as { id: string }).id;
    const r = await row(sid);
    if (!r) return reply.code(404).send({ error: "Şarkı yok" });
    const b = z.object({ jobId: z.string(), provider: z.enum(["anthropic", "openai", "gemini"]), model: z.string().min(1).max(100),
                         brief: BriefIn }).safeParse(req.body);
    if (!b.success || !jobIdOk(b.data.jobId)) return reply.code(400).send({ error: "Geçersiz istek" });
    const { jobId, provider, model, brief } = b.data;
    const opened = await openJob(jobId, "lyrics", { song: sid, provider, model, brief });
    if (!opened.fresh) {
      const had = asSong((await row(sid))!).drafts.find((x) => x.jobId === jobId);
      return had ? { draft: had, job: opened.job } : reply.code(409).send({ code: "JOB_RUNNING", error: "Bu iş zaten çalışıyor ya da sonucu belirsiz.", job: opened.job });
    }
    const words: { en: string; tr: string }[] = [];
    for (const id of brief.words) words.push((await one<{ en: string; tr: string }>("SELECT en, tr FROM words WHERE id = ?", id)) ?? { en: id, tr: "" });
    const inv = latestInventory();
    const names = inv?.mascots ? { learner: inv.mascots.builtin.find((x) => x.role === "learner")?.name ?? "Lili",
                                   friend: inv.mascots.builtin.find((x) => x.role === "friend")?.name ?? "Kuki" } : null;
    try {
      const text = await writeLyrics(provider, model, userPrompt(brief, words, names));
      const got = parseLyrics(text);
      const draft: Draft = { jobId, provider, model, ...got, at: Date.now() };
      /* kept on the song the moment it is paid for */
      await tx(async () => {
        const now = (await row(sid))!;
        await run("UPDATE songs SET drafts = ?, updated_at = ? WHERE id = ?",
                  JSON.stringify([draft, ...asSong(now).drafts].slice(0, 30)), nextStamp(now.updated_at), sid);
      });
      const job = await endJob(jobId, []);
      return { draft, job };
    } catch (e) {
      /* uncertain only when the request may have arrived and no answer came
         back: a refusal, or an answer that was not usable, is known */
      const lost = !(e instanceof Upstream) || e.code === "PROVIDER_TIMEOUT" || e.code === "PROVIDER_UNREACHABLE";
      const job = await endJob(jobId, [(e as Error).message], lost);
      return failReply(reply, e, job);
    }
  });

  /* Suno's official API: not public yet (see the top of this file) */
  app.post("/songs/:id/suno", async (_req, reply) => {
    try { await key("suno"); } catch (e) { return failReply(reply, e); }
    return reply.code(501).send({ code: "NOT_AVAILABLE",
      error: "Suno'nun herkese açık resmi API'si henüz yok. Şarkıyı suno.com'da (Pro/Premier) üretip buraya yükleyin; resmi API açıldığında bu düğme doğrudan üretecek." });
  });

  app.get("/ai/text-models/:provider", async (req, reply) => {
    const p = (req.params as { provider: string }).provider;
    if (p !== "anthropic" && p !== "openai" && p !== "gemini") return reply.code(404).send({ error: "Bilinmeyen sağlayıcı" });
    try { return { models: await textModels(p) }; } catch (e) { return failReply(reply, e); }
  });
}
