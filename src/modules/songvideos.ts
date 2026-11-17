/**
 * ŞARKILAR (the panel's "Şarkı videoları", 2026-11-17): the films of the
 * app's "Şarkılar" tab.
 *
 * The app has a bar at the bottom: the map in the middle, the parent's area on
 * one side and SONGS on the other -- animated films with a children's song on
 * them, one or more per category. A film is made and edited outside (the song
 * already mixed into it) and uploaded here as a finished MP4, with a poster
 * picture for its card. Nothing is made here.
 *
 *   video     the film: an MP4 (H.264 + AAC plays on every phone; a MOV is
 *             refused, Android does not always play it)
 *   poster    the card's picture (PNG/JPG/WEBP), the child picks by it
 *   category  the map row that opens it: the film is locked on the phone
 *             until the child reaches that row's first stop. Empty: always
 *             open. A category not on the phone's map opens it too
 *   position  the order on the tab
 *   rights    a person confirmed the film AND its song may be used (a song
 *             from Suno's free plan may not)
 *
 * A release carries the live, whole ones (`releases.ts` → `songVideos`). The
 * phone downloads the POSTERS with the release and the films LATER: a film is
 * tens of MB, and it must never hold back a release of new recordings. It is
 * streamed the first time it is watched and kept on the phone after.
 *
 *   admin   GET /song-videos · POST /song-videos · PATCH/DELETE /song-videos/:id
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { all, one, run, tx } from "../storage/sql.js";
import { getAsset, type AssetRow } from "../storage/files.js";
import { latestInventory } from "./inventory.js";
import { loadCategories } from "./categories.js";
import type { Issue } from "./checks.js";
import { slug } from "./games.js";
import { nextStamp, staleFor } from "./vocab.js";

interface Rights { confirmed: boolean; owner: string; note: string }
interface Row {
  id: string; title: string; video: string | null; poster: string | null; category: string | null; position: number;
  status: "live" | "draft" | "hidden"; note: string; rights: string; duration_ms: number | null; fit: "cover" | "contain";
  created_at: number; updated_at: number;
}
export interface SongVideo {
  id: string; title: string; video: string | null; poster: string | null; category: string | null; position: number;
  status: Row["status"]; note: string; rights: Rights; durationMs: number | null;
  /** the app fills the screen and crops what does not fit (rule 16); `contain`
   *  keeps the whole film with bands, for one not framed for a phone */
  fit: "cover" | "contain";
  createdAt: number; updatedAt: number;
}

const DEF_RIGHTS: Rights = { confirmed: false, owner: "", note: "" };
const row = (id: string) => one<Row>("SELECT * FROM song_videos WHERE id = ?", id);
const asVideo = (r: Row): SongVideo => ({
  id: r.id, title: r.title, video: r.video, poster: r.poster, category: r.category, position: r.position,
  status: r.status, note: r.note, rights: { ...DEF_RIGHTS, ...JSON.parse(r.rights || "{}") },
  durationMs: r.duration_ms === null ? null : Number(r.duration_ms), fit: r.fit === "contain" ? "contain" : "cover", createdAt: Number(r.created_at), updatedAt: Number(r.updated_at),
});
export const loadSongVideos = async (): Promise<SongVideo[]> =>
  (await all<Row>(`SELECT * FROM song_videos ORDER BY position, created_at, id COLLATE "C"`)).map(asVideo);

/** the categories a film may be opened by: the app's own (by its id) and the panel's (`server:<id>`) */
export interface VideoCategory { id: string; title: string; kind: "app" | "panel" }
export async function videoCategories(): Promise<VideoCategory[]> {
  const own = (latestInventory()?.categories ?? []).map((c) => ({ id: c.id, title: c.title, kind: "app" as const }));
  const panel = (await loadCategories()).map((c) => ({ id: `server:${c.id}`, title: c.title, kind: "panel" as const }));
  return [...own, ...panel];
}

/* ── checks ───────────────────────────────────────────────────────────────── */

export interface VideoFacts { categories: VideoCategory[]; asset: (id: string) => AssetRow | undefined }
export async function videoFacts(): Promise<VideoFacts> {
  const [categories, assets] = await Promise.all([
    videoCategories(), all<AssetRow>("SELECT * FROM assets WHERE kind IN ('video', 'image')")]);
  const a = new Map(assets.map((x) => [x.id, x]));
  return { categories, asset: (id) => a.get(id) };
}

/** a film bigger than this is refused: a phone streams it, then keeps it */
export const VIDEO_MAX_BYTES = 250 * 1024 * 1024;
const MB = (n: number) => Math.round(n / 1048576);

export function checkSongVideo(v: SongVideo, f: VideoFacts): Issue[] {
  const out: Issue[] = [];
  const err = (text: string) => out.push({ level: "error", text });
  const warn = (text: string) => out.push({ level: "warn", text });
  if (!v.title.trim()) err("Adı yok.");
  const vid = v.video ? f.asset(v.video) : undefined;
  if (!v.video) err("Video yüklenmedi.");
  else if (!vid || vid.kind !== "video") err("Seçilen dosya bir video değil ya da silinmiş.");
  else {
    if (vid.ext !== "mp4") err("Video MP4 (H.264 + AAC) olmalı: MOV her Android telefonda oynamaz.");
    if (vid.size > VIDEO_MAX_BYTES) err(`Video ${MB(vid.size)} MB: en çok ${MB(VIDEO_MAX_BYTES)} MB.`);
    else if (vid.size > 80 * 1048576) warn(`Video ${MB(vid.size)} MB: telefon onu ilk izlemede indirir; 720p ve ~2 Mbps ile çoğu şarkı 30 MB'ın altında kalır.`);
  }
  const pic = v.poster ? f.asset(v.poster) : undefined;
  if (!v.poster) err("Kapak resmi yok: çocuk videoyu resminden seçer.");
  else if (!pic || pic.kind !== "image") err("Kapak bir resim değil ya da silinmiş.");
  if (v.category && !f.categories.some((c) => c.id === v.category))
    err(`"${v.category}" kategorisi yok: haritada ilerledikçe açılması için var olan bir kategori seçin ya da "Hep açık" yapın.`);
  if (!v.rights.confirmed) err("Videonun ve içindeki şarkının kullanım hakkı onaylanmadı (Suno'nun ücretsiz planıyla yapılan şarkı ticari kullanılamaz).");
  if (v.durationMs !== null) {
    const sec = v.durationMs / 1000;
    if (sec < 15) warn(`Video ${Math.round(sec)} sn: çok kısa.`);
    else if (sec > 300) warn(`Video ${Math.round(sec / 60)} dk: 4–8 yaş için 1–3 dakika önerilir.`);
  }
  return out;
}

export async function songVideosOut() {
  const f = await videoFacts();
  return { categories: f.categories, list: (await loadSongVideos()).map((v) => ({ ...v, issues: checkSongVideo(v, f) })) };
}

/* ── routes ───────────────────────────────────────────────────────────────── */

const RightsIn = z.object({ confirmed: z.boolean(), owner: z.string().max(120), note: z.string().max(600) });
/* every field optional and WITHOUT a default: `.partial()` of a schema with
   defaults fills them in, and an edit of the title alone would clear the rest */
const Patch = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  video: z.string().max(80).nullable().optional(),
  poster: z.string().max(80).nullable().optional(),
  category: z.string().max(100).nullable().optional(),
  position: z.number().int().min(0).max(100000).optional(),
  status: z.enum(["live", "draft", "hidden"]).optional(),
  note: z.string().max(600).optional(),
  rights: RightsIn.optional(),
  durationMs: z.number().int().min(0).max(60 * 60_000).nullable().optional(),
  fit: z.enum(["cover", "contain"]).optional(),
});

export async function songVideoRoutes(app: FastifyInstance) {
  app.get("/song-videos", async () => songVideosOut());

  app.post("/song-videos", (req, reply) => tx(async () => {
    const b = z.object({ title: z.string().trim().min(1).max(80),
                         category: z.string().max(100).nullable().optional(),
                         /* the panel's operation id: the same request twice makes ONE film */
                         op: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/, "işlem kimliği").optional() }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "Ad gerekli" });
    if (b.data.op) {
      const had = await one<{ id: string }>("SELECT id FROM song_videos WHERE op = ?", b.data.op);
      if (had) return (await songVideosOut()).list.find((s) => s.id === had.id);
    }
    const cat = b.data.category ?? null;
    if (cat && !(await videoCategories()).some((c) => c.id === cat)) return reply.code(400).send({ error: "Böyle bir kategori yok" });
    const base = slug(b.data.title) || "sarki";
    let id = base;
    for (let n = 2; await row(id); n++) id = `${base}-${n}`;
    const last = await one<{ p: number | null }>("SELECT MAX(position) AS p FROM song_videos");
    const now = Date.now();
    await run(`INSERT INTO song_videos(id, title, category, position, rights, created_at, updated_at, op) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
              id, b.data.title, cat, Number(last?.p ?? -1) + 1,
              JSON.stringify(DEF_RIGHTS), now, now, b.data.op ?? null);
    reply.code(201);
    return (await songVideosOut()).list.find((s) => s.id === id);
  }));

  app.patch("/song-videos/:id", (req, reply) => tx(async () => {
    const vid = (req.params as { id: string }).id;
    const r = await row(vid);
    if (!r) return reply.code(404).send({ error: "Video yok" });
    const b = Patch.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: b.error.issues[0]?.message ?? "Geçersiz istek" });
    if (staleFor(req, Number(r.updated_at))) return reply.code(409).send({ code: "STALE", error: "Bu video başka bir yerde değişti." });
    const d = b.data, cur = asVideo(r);
    if (d.video && (await getAsset(d.video))?.kind !== "video") return reply.code(400).send({ error: `"${d.video}" bir video değil.` });
    if (d.poster && (await getAsset(d.poster))?.kind !== "image") return reply.code(400).send({ error: `"${d.poster}" bir resim değil.` });
    const next: SongVideo = {
      ...cur, title: d.title ?? cur.title, video: d.video !== undefined ? d.video : cur.video,
      poster: d.poster !== undefined ? d.poster : cur.poster, category: d.category !== undefined ? d.category || null : cur.category,
      position: d.position ?? cur.position, status: d.status ?? cur.status, note: d.note ?? cur.note,
      rights: d.rights ?? cur.rights, durationMs: d.durationMs !== undefined ? d.durationMs : cur.durationMs,
      fit: d.fit ?? cur.fit,
    };
    if (next.status === "live") {
      const issues = checkSongVideo(next, await videoFacts());
      if (issues.some((i) => i.level === "error")) return reply.code(400).send({ error: "Hatası olan video uygulamaya konamaz.", issues });
    }
    await run(`UPDATE song_videos SET title = ?, video = ?, poster = ?, category = ?, position = ?, status = ?, note = ?, rights = ?,
               duration_ms = ?, fit = ?, updated_at = ? WHERE id = ?`,
              next.title, next.video, next.poster, next.category, next.position, next.status, next.note, JSON.stringify(next.rights),
              next.durationMs, next.fit, nextStamp(Number(r.updated_at)), vid);
    return (await songVideosOut()).list.find((s) => s.id === vid);
  }));

  app.delete("/song-videos/:id", (req, reply) => tx(async () => {
    const vid = (req.params as { id: string }).id;
    if (!(await row(vid))) return reply.code(404).send({ error: "Video yok" });
    await run("DELETE FROM song_videos WHERE id = ?", vid);
    return { ok: true };
  }));
}
