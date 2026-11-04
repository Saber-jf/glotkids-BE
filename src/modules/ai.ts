/**
 * The AI gateways. The panel says WHAT to make; this server adds the key,
 * calls the provider, stores each result as an asset the moment it arrives
 * (a paid result is never lost on the way back, nor by a later failure in the
 * same batch) and answers with its metadata.
 *
 * Every generation is a JOB with the panel's id (`jobs.ts`): asked again with
 * the same id it answers from what was stored and never calls the provider
 * twice. Every provider call has a time limit (`LIMIT_MS`): a provider that
 * never answers ends the job, it does not hold it open.
 *
 * Errors carry a `code` (S09): `PROVIDER_AUTH_FAILED` for a provider's own
 * 401/403 (a wrong key -- answered as 502, never as 401, which is the panel's
 * own login), `PROVIDER_KEY_MISSING`, `PROVIDER_RATE_LIMIT`,
 * `PROVIDER_TIMEOUT`, `PROVIDER_ERROR`, `JOB_RUNNING`, `PROVIDER_BLOCKED` (the
 * provider refused the content -- its safety rules -- with the key in order).
 *
 *   ElevenLabs  voices, models, credits, text-to-speech (as scripts/gen-voice.mjs
 *               calls it, plus a pronunciation dictionary), voice design
 *               (paid previews, then saving one to the account), and the
 *               pronunciation dictionary itself (IPA rules for English words
 *               said inside another language's sentence)
 *   OpenAI      gpt-image-1: generations, or edits when style examples are sent
 *   Gemini      generateContent with image output, examples as inline parts
 */
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { FileTypeError, findAsset, getSecret, mimeFor, readAsset, type SecretName } from "../storage/files.js";
import { newId, storeBuffer } from "./assets.js";
import { endJob, jobAsset, jobIdOk, jobRoutes, openJob, type Job } from "./jobs.js";

class Upstream extends Error { constructor(public status: number, msg: string, public code = "PROVIDER_ERROR") { super(msg); } }

/** how long one provider call may take */
export const LIMIT_MS = { list: 20_000, tts: 120_000, image: 180_000 };

async function key(n: SecretName): Promise<string> {
  const s = await getSecret(n);
  if (!s) throw new Upstream(412, `${n} anahtarı ayarlı değil (panel → Ayarlar ya da sunucunun .env dosyası).`, "PROVIDER_KEY_MISSING");
  return s.value;
}

/** a provider call with a time limit */
async function call(who: string, url: string, init: RequestInit, ms: number): Promise<Response> {
  try { return await fetch(url, { ...init, signal: AbortSignal.timeout(ms) }); }
  catch (e) {
    const name = (e as Error).name;
    if (name === "TimeoutError" || name === "AbortError")
      throw new Upstream(504, `${who}: ${Math.round(ms / 1000)} sn içinde cevap vermedi`, "PROVIDER_TIMEOUT");
    throw new Upstream(502, `${who}: bağlantı koptu (${(e as Error).message})`, "PROVIDER_UNREACHABLE");
  }
}

async function check(r: Response, who: string): Promise<Response> {
  if (r.ok) return r;
  let msg = `${r.status}`;
  try {
    const j = await r.json() as { detail?: { message?: string } | string; error?: { message?: string } };
    msg += ` — ${typeof j.detail === "object" ? j.detail?.message : j.detail ?? j.error?.message ?? ""}`;
  } catch { /* not json */ }
  /* a refusal of the CONTENT is not a refusal of the key: ElevenLabs answers
     403 with "doesn't follow our safety guidelines" (a child's voice
     described, 2026-10-16) -- told as a key problem it sent the person to
     the settings for a key that worked */
  if (/safety|guideline|moderat|blocked|policy/i.test(msg))
    throw new Upstream(422, `${who} bu isteği içerik kuralları nedeniyle engelledi (ücret alınmaz): ${msg}`, "PROVIDER_BLOCKED");
  if (r.status === 401 || r.status === 403)
    throw new Upstream(502, `${who} anahtarı reddetti: ${msg}`, "PROVIDER_AUTH_FAILED");
  if (r.status === 429) throw new Upstream(429, `${who}: istek sınırı — ${msg}`, "PROVIDER_RATE_LIMIT");
  throw new Upstream(502, `${who}: ${msg}`);
}

function fail(reply: FastifyReply, e: unknown, job?: Job) {
  if (e instanceof FileTypeError) return reply.code(502).send({ error: `Sağlayıcı kabul edilmeyen bir dosya döndü: ${e.message}`, code: "PROVIDER_ERROR", ...(job ? { job } : {}) });
  if (e instanceof Upstream) return reply.code(e.status).send({ error: e.message, code: e.code, ...(job ? { job } : {}) });
  if (e instanceof z.ZodError) return reply.code(400).send({ error: "Geçersiz istek", detail: e.issues.slice(0, 5) });
  throw e;
}

/** the request may have reached the provider: the job's cost is unknown (decision 3) */
const unsure = (e: unknown) => e instanceof Upstream && (e.code === "PROVIDER_TIMEOUT" || e.code === "PROVIDER_UNREACHABLE");

const JobId = z.string().refine(jobIdOk, "iş kimliği 8–80 karakter: harf, rakam, - ve _").optional();

/* ── ElevenLabs ───────────────────────────────────────────────────────────── */

const EL = "https://api.elevenlabs.io";
const Tts = z.object({
  voiceId: z.string().min(1), text: z.string().min(1).max(5000), model_id: z.string(),
  language_code: z.string().optional(), seed: z.number().int().optional(),
  voice_settings: z.object({ stability: z.number(), similarity_boost: z.number(), style: z.number(),
                             use_speaker_boost: z.boolean(), speed: z.number() }),
  /* ElevenLabs' own answer to a word of one language inside a sentence of
     another: a pronunciation dictionary of IPA rules, applied in order (at
     most 3). Eleven v4 reads IPA in /slashes/ in the text instead. */
  pronunciation_dictionary_locators: z.array(z.object({
    pronunciation_dictionary_id: z.string().min(1).max(80), version_id: z.string().max(80).optional(),
  })).max(3).optional(),
  name: z.string().max(120), jobId: JobId,
});

/** voice design: a description (and optionally what the previews say) */
const Design = z.object({
  description: z.string().trim().min(20).max(1000),
  text: z.string().trim().min(100).max(1000).optional(),
  jobId: JobId,
});
const DesignSave = z.object({
  name: z.string().trim().min(1).max(100), description: z.string().trim().min(20).max(1000),
  generatedVoiceId: z.string().min(1).max(120),
});
/** an English word and how it is said, in IPA */
const PronRules = z.object({
  name: z.string().trim().min(1).max(100),
  rules: z.array(z.object({ word: z.string().trim().min(1).max(60), ipa: z.string().trim().min(1).max(120) })).min(1).max(1000),
});
/** a design preview is stored under a name that keeps its generated voice id */
const DESIGN_PREFIX = "voice-design__";
export const designIdOf = (name: string) =>
  name.startsWith(DESIGN_PREFIX) ? name.slice(DESIGN_PREFIX.length).replace(/\.[a-z0-9]+$/, "") : null;

/* ── images ───────────────────────────────────────────────────────────────── */

const Ref = z.object({ id: z.string().optional(), b64: z.string().optional(), mime: z.string().optional() });
const Images = z.object({
  provider: z.enum(["openai", "gemini"]), model: z.string().min(1), kind: z.enum(["icon", "background"]),
  prompt: z.string().min(1).max(8000), n: z.number().int().min(1).max(4),
  quality: z.enum(["low", "medium", "high"]), refs: z.array(Ref).max(6), name: z.string().max(120),
  jobId: JobId,
});

/** a style example: a stored asset, or bytes the panel sent along */
async function refBytes(r: z.infer<typeof Ref>): Promise<{ buf: Buffer; mime: string } | null> {
  if (r.id) {
    const a = await findAsset(r.id);
    return a ? { buf: await readAsset(a.file), mime: mimeFor(a.ext) } : null;
  }
  return r.b64 ? { buf: Buffer.from(r.b64, "base64"), mime: r.mime ?? "image/png" } : null;
}

type Made = { buf: Buffer; mime: string };

/** one OpenAI call makes all `n` pictures; each is handed on as soon as it is decoded */
async function openaiImages(q: z.infer<typeof Images>, refs: Made[], each: (m: Made) => Promise<void>) {
  const k = await key("openai");
  const size = q.kind === "icon" ? "1024x1024" : "1536x1024";
  const background = q.kind === "icon" ? "transparent" : "opaque";
  let r: Response;
  if (refs.length) {
    const f = new FormData();
    f.append("model", q.model); f.append("prompt", q.prompt); f.append("n", String(q.n));
    f.append("size", size); f.append("quality", q.quality); f.append("background", background);
    refs.forEach((x, i) => f.append("image[]", new Blob([new Uint8Array(x.buf)], { type: x.mime }), `ref-${i}.png`));
    r = await call("OpenAI", "https://api.openai.com/v1/images/edits", { method: "POST", headers: { Authorization: `Bearer ${k}` }, body: f }, LIMIT_MS.image);
  } else {
    r = await call("OpenAI", "https://api.openai.com/v1/images/generations", {
      method: "POST", headers: { Authorization: `Bearer ${k}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: q.model, prompt: q.prompt, n: q.n, size, quality: q.quality, background, output_format: "png" }),
    }, LIMIT_MS.image);
  }
  const j = await (await check(r, "OpenAI")).json() as { data?: { b64_json?: string }[] };
  const imgs = (j.data ?? []).filter((d) => d.b64_json);
  if (!imgs.length) throw new Upstream(502, "OpenAI: görsel dönmedi");
  for (const d of imgs) await each({ buf: Buffer.from(d.b64_json!, "base64"), mime: "image/png" });
}

/** Gemini makes one picture per call: each is handed on (and stored) before the next call */
async function geminiImages(q: z.infer<typeof Images>, refs: Made[], each: (m: Made) => Promise<void>) {
  const k = await key("gemini");
  const parts = [...refs.map((x) => ({ inlineData: { mimeType: x.mime, data: x.buf.toString("base64") } })), { text: q.prompt }];
  for (let i = 0; i < q.n; i++) {
    const r = await call("Gemini", `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(q.model)}:generateContent`, {
      method: "POST", headers: { "x-goog-api-key": k, "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ role: "user", parts }],
        generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio: q.kind === "icon" ? "1:1" : "16:9" } } }),
    }, LIMIT_MS.image);
    const j = await (await check(r, "Gemini")).json() as {
      candidates?: { content?: { parts?: { inlineData?: { data: string; mimeType?: string }; text?: string }[] } }[] };
    const ps = j.candidates?.[0]?.content?.parts ?? [];
    const img = ps.find((p) => p.inlineData?.data);
    if (!img?.inlineData) throw new Upstream(502, `Gemini: ${i + 1}. görsel dönmedi${ps[0]?.text ? ` — ${ps[0].text}` : ""}`);
    await each({ buf: Buffer.from(img.inlineData.data, "base64"), mime: img.inlineData.mimeType ?? "image/png" });
  }
}

export async function aiRoutes(app: FastifyInstance) {
  await app.register(jobRoutes);

  app.get("/ai/eleven/voices", async (_req, reply) => {
    try {
      const r = await check(await call("ElevenLabs", `${EL}/v1/voices`, { headers: { "xi-api-key": await key("elevenlabs") } }, LIMIT_MS.list), "ElevenLabs");
      const j = await r.json() as { voices?: { voice_id: string; name: string; labels?: Record<string, string>; preview_url?: string;
                                               category?: string; description?: string | null }[] };
      /* how the voice was made (premade, generated, cloned, professional) and
         its own description: what a new voice can be designed after */
      return (j.voices ?? []).map(({ voice_id, name, labels, preview_url, category, description }) =>
        ({ voice_id, name, labels, preview_url, category, description: description ?? null }));
    } catch (e) { return fail(reply, e); }
  });

  /** the account's text-to-speech models, with the languages each speaks */
  app.get("/ai/eleven/models", async (_req, reply) => {
    try {
      const r = await check(await call("ElevenLabs", `${EL}/v1/models`, { headers: { "xi-api-key": await key("elevenlabs") } }, LIMIT_MS.list), "ElevenLabs");
      const j = await r.json() as { model_id: string; name: string; can_do_text_to_speech?: boolean;
                                    languages?: { language_id: string; name: string }[] }[];
      return (Array.isArray(j) ? j : []).filter((m) => m.can_do_text_to_speech)
        .map((m) => ({ model_id: m.model_id, name: m.name, languages: (m.languages ?? []).map((l) => l.language_id) }));
    } catch (e) { return fail(reply, e); }
  });

  app.get("/ai/eleven/credits", async (_req, reply) => {
    try {
      const r = await check(await call("ElevenLabs", `${EL}/v1/user/subscription`, { headers: { "xi-api-key": await key("elevenlabs") } }, LIMIT_MS.list), "ElevenLabs");
      const j = await r.json() as { character_count?: number; character_limit?: number };
      return { used: j.character_count ?? 0, limit: j.character_limit ?? 0 };
    } catch (e) { return fail(reply, e); }
  });

  /* one line, one job: the same jobId again answers with the stored take */
  app.post("/ai/eleven/tts", async (req, reply) => {
    let q: z.infer<typeof Tts>;
    try { q = Tts.parse(req.body); } catch (e) { return fail(reply, e); }
    const id = q.jobId ?? newId("job");
    const { fresh, job } = await openJob(id, "tts", { ...q, jobId: undefined });
    if (!fresh) {
      if (job.status === "running") return reply.code(409).send({ error: "Bu iş hâlâ sürüyor.", code: "JOB_RUNNING", job });
      if (job.status === "uncertain") return reply.code(409).send({ error: job.errors.join(" "), code: "JOB_UNCERTAIN", job });
      if (job.assets[0]) return { ...job.assets[0], jobId: id };
      return reply.code(502).send({ error: job.errors.join("; ") || "İş başarısız oldu", code: "PROVIDER_ERROR", job });
    }
    try {
      const r = await check(await call("ElevenLabs", `${EL}/v1/text-to-speech/${encodeURIComponent(q.voiceId)}?output_format=mp3_44100_128`, {
        method: "POST", headers: { "xi-api-key": await key("elevenlabs"), "Content-Type": "application/json" },
        body: JSON.stringify({ text: q.text, model_id: q.model_id, language_code: q.language_code,
                               seed: q.seed, voice_settings: q.voice_settings,
                               pronunciation_dictionary_locators: q.pronunciation_dictionary_locators }),
      }, LIMIT_MS.tts), "ElevenLabs");
      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length) throw new Upstream(502, "ElevenLabs: boş ses döndü");
      const a = await storeBuffer(buf, `${q.name}.mp3`, r.headers.get("content-type")?.split(";")[0] || "audio/mpeg");
      await jobAsset(id, a);
      await endJob(id, []);
      return { ...a, jobId: id };
    } catch (e) {
      const done = await endJob(id, [(e as Error).message], unsure(e));
      return fail(reply, e, done);
    }
  });

  /*
   * VOICE DESIGN, a paid job: ElevenLabs makes a few previews of a described
   * voice; each is stored the moment it arrives (its generated voice id kept
   * in its name), so asked again under the same job id the server answers
   * from what it stored and never pays twice. Nothing is added to the
   * account until a person picks one (`design-save`).
   */
  app.post("/ai/eleven/design", async (req, reply) => {
    let q: z.infer<typeof Design>;
    try { q = Design.parse(req.body); } catch (e) { return fail(reply, e); }
    const id = q.jobId ?? newId("job");
    const answer = (j: Job) => ({ job: j, previews: j.assets.map((a) => ({ ...a, generatedVoiceId: designIdOf(a.name) })) });
    const { fresh, job } = await openJob(id, "voice-design", { ...q, jobId: undefined });
    if (!fresh) {
      if (job.status === "running") return reply.code(409).send({ error: "Bu iş hâlâ sürüyor.", code: "JOB_RUNNING", job });
      if (job.status === "uncertain") return reply.code(409).send({ error: job.errors.join(" "), code: "JOB_UNCERTAIN", job });
      return answer(job);
    }
    try {
      const r = await check(await call("ElevenLabs", `${EL}/v1/text-to-voice/design?output_format=mp3_44100_128`, {
        method: "POST", headers: { "xi-api-key": await key("elevenlabs"), "Content-Type": "application/json" },
        body: JSON.stringify({ voice_description: q.description, model_id: "eleven_ttv_v3",
                               auto_generate_text: !q.text, ...(q.text ? { text: q.text } : {}) }),
      }, LIMIT_MS.tts), "ElevenLabs");
      const j = await r.json() as { previews?: { audio_base_64?: string; generated_voice_id?: string; media_type?: string }[] };
      const previews = (j.previews ?? []).filter((p) => p.audio_base_64 && p.generated_voice_id);
      if (!previews.length) throw new Upstream(502, "ElevenLabs: ses örneği dönmedi");
      for (const p of previews)
        await jobAsset(id, await storeBuffer(Buffer.from(p.audio_base_64!, "base64"), `${DESIGN_PREFIX}${p.generated_voice_id}.mp3`, p.media_type ?? "audio/mpeg"));
      return answer(await endJob(id, []));
    } catch (e) {
      const done = await endJob(id, [(e as Error).message], unsure(e));
      if (done.status === "partial") return reply.code(200).send({ ...answer(done), code: e instanceof Upstream ? e.code : "PROVIDER_ERROR" });
      return fail(reply, e, done);
    }
  });

  /** keep one designed voice in the account (no credits; it takes a voice slot) */
  app.post("/ai/eleven/design-save", async (req, reply) => {
    let q: z.infer<typeof DesignSave>;
    try { q = DesignSave.parse(req.body); } catch (e) { return fail(reply, e); }
    try {
      const r = await check(await call("ElevenLabs", `${EL}/v1/text-to-voice`, {
        method: "POST", headers: { "xi-api-key": await key("elevenlabs"), "Content-Type": "application/json" },
        body: JSON.stringify({ voice_name: q.name, voice_description: q.description, generated_voice_id: q.generatedVoiceId }),
      }, LIMIT_MS.list), "ElevenLabs");
      const j = await r.json() as { voice_id?: string; name?: string };
      if (!j.voice_id) throw new Upstream(502, "ElevenLabs: ses kaydedilemedi");
      return { voice_id: j.voice_id, name: j.name ?? q.name };
    } catch (e) { return fail(reply, e); }
  });

  /*
   * THE PRONUNCIATION DICTIONARY (no credits): every English word with its
   * IPA, as phoneme rules. A dictionary's version is fixed, so a changed list
   * is a new dictionary; the panel keeps the one it uses and sends it with
   * each line for models that read dictionaries (Eleven v4 reads IPA in the
   * text itself).
   */
  app.post("/ai/eleven/pronunciation", async (req, reply) => {
    let q: z.infer<typeof PronRules>;
    try { q = PronRules.parse(req.body); } catch (e) { return fail(reply, e); }
    try {
      const rules = q.rules.map((x) => ({ type: "phoneme", string_to_replace: x.word, phoneme: x.ipa.replace(/^\/|\/$/g, ""),
                                          alphabet: "ipa", case_sensitive: false, word_boundaries: true }));
      const r = await check(await call("ElevenLabs", `${EL}/v1/pronunciation-dictionaries/add-from-rules`, {
        method: "POST", headers: { "xi-api-key": await key("elevenlabs"), "Content-Type": "application/json" },
        body: JSON.stringify({ name: q.name, rules }),
      }, LIMIT_MS.list), "ElevenLabs");
      const j = await r.json() as { id?: string; version_id?: string };
      if (!j.id) throw new Upstream(502, "ElevenLabs: sözlük oluşturulamadı");
      return { id: j.id, version_id: j.version_id ?? null, rules: rules.length };
    } catch (e) { return fail(reply, e); }
  });

  /*
   * pictures, one job: each stored as it arrives. The answer is the job --
   * `done`, `partial` (some made, then a failure: the made ones are kept and
   * listed) or `failed` (nothing made; may be run again under the same id).
   */
  app.post("/ai/images", async (req, reply) => {
    let q: z.infer<typeof Images>;
    try { q = Images.parse(req.body); } catch (e) { return fail(reply, e); }
    const id = q.jobId ?? newId("job");
    const { fresh, job } = await openJob(id, "images", { ...q, refs: q.refs.map((r) => r.id ?? "(gömülü)"), jobId: undefined });
    if (!fresh) {
      if (job.status === "running") return reply.code(409).send({ error: "Bu iş hâlâ sürüyor.", code: "JOB_RUNNING", job });
      if (job.status === "uncertain") return reply.code(409).send({ error: job.errors.join(" "), code: "JOB_UNCERTAIN", job });
      return job;
    }
    let i = 0;
    const each = async (m: Made) => {
      if (!m.buf.length) throw new Upstream(502, "Sağlayıcı boş görsel döndü");
      await jobAsset(id, await storeBuffer(m.buf, `${q.name}-${i++}`, m.mime));
    };
    try {
      const refs = (await Promise.all(q.refs.map(refBytes))).filter((x): x is Made => !!x);
      if (q.provider === "openai") await openaiImages(q, refs, each); else await geminiImages(q, refs, each);
      return await endJob(id, []);
    } catch (e) {
      const done = await endJob(id, [(e as Error).message], unsure(e));
      /* something was made: the job is the answer, with what failed */
      if (done.status === "partial") return reply.code(200).send({ ...done, code: e instanceof Upstream ? e.code : "PROVIDER_ERROR" });
      return fail(reply, e, done);
    }
  });

  /** a free request that proves a key works */
  app.get("/ai/test/:provider", async (req, reply) => {
    const p = (req.params as { provider: string }).provider;
    try {
      if (p === "elevenlabs") {
        const r = await check(await call("ElevenLabs", `${EL}/v1/user/subscription`, { headers: { "xi-api-key": await key("elevenlabs") } }, LIMIT_MS.list), "ElevenLabs");
        const j = await r.json() as { character_count?: number; character_limit?: number };
        return { ok: true, text: `Bağlandı. Bu ay ${j.character_count ?? 0} / ${j.character_limit ?? 0} kredi kullanıldı.` };
      }
      if (p === "openai") {
        const r = await check(await call("OpenAI", "https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${await key("openai")}` } }, LIMIT_MS.list), "OpenAI");
        const j = await r.json() as { data?: unknown[] };
        return { ok: true, text: `Bağlandı (${j.data?.length ?? 0} model).` };
      }
      if (p === "gemini") {
        const r = await check(await call("Gemini", "https://generativelanguage.googleapis.com/v1beta/models", { headers: { "x-goog-api-key": await key("gemini") } }, LIMIT_MS.list), "Gemini");
        const j = await r.json() as { models?: unknown[] };
        return { ok: true, text: `Bağlandı (${j.models?.length ?? 0} model).` };
      }
      if (p === "anthropic") {
        const r = await check(await call("Claude", "https://api.anthropic.com/v1/models", { headers: anthropicHeaders(await key("anthropic")) }, LIMIT_MS.list), "Claude");
        const j = await r.json() as { data?: unknown[] };
        return { ok: true, text: `Bağlandı (${j.data?.length ?? 0} model).` };
      }
      if (p === "suno") {
        await key("suno");
        return { ok: true, text: "Anahtar saklandı. Suno'nun herkese açık resmi API'si henüz yok: erişim açıldığında bu anahtarla bağlanılacak; o zamana kadar şarkılar suno.com'da üretilip yüklenir." };
      }
      return reply.code(404).send({ error: "Bilinmeyen sağlayıcı" });
    } catch (e) { return fail(reply, e); }
  });
}

export const anthropicHeaders = (k: string) => ({ "x-api-key": k, "anthropic-version": "2023-06-01", "content-type": "application/json" });

/* the shared pieces the song module calls providers with */
export { Upstream, call, check, key, fail as failReply };
