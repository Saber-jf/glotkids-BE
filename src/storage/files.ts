/**
 * Files and secrets. The rows are in the database (`sql.ts`: Postgres --
 * content, releases, documents); everything else the server keeps is under
 * `DATA_DIR`:
 *
 *   pgdata/            the embedded database, when there is no DATABASE_URL
 *   blobs/<sha>.<ext>  the bytes of every asset, once per content hash
 *   secrets.json       API keys entered from the panel
 *
 * CONTENT-ADDRESSED. An asset id is a NAME for some bytes; the bytes live
 * under their own SHA-256. So the same picture uploaded twice is stored once,
 * a release can point at bytes that never change (`/cdn/<sha>.<ext>` is
 * cacheable forever, by a CDN and by the phone), and deleting an asset never
 * pulls the bytes out from under a release that was published with them --
 * blobs are only collected when nothing at all refers to them (`gc`).
 *
 * Object storage later (S3/R2): `putBlob` / `blobPath` are the seam.
 */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { config } from "../config.js";
import { all, one, run } from "./sql.js";
import { studioDoc, studioRefs } from "./studio-refs.js";

const D = config.dataDir;
export const P = {
  blobs: path.join(D, "blobs"),
  secrets: path.join(D, "secrets.json"),
  /* the JSON-file storage this replaced; read once by `migrate-json.ts` */
  legacyAssets: path.join(D, "assets"),
};

export async function ensureDirs() {
  await mkdir(P.blobs, { recursive: true });
}

/** write through a temporary file and rename: a crash never leaves half a file */
export async function writeAtomic(file: string, data: string | Buffer) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, file);
}

/* ── types and names ──────────────────────────────────────────────────────── */

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml",   /* svg: only to serve old files safely */
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav",
  mp4: "video/mp4", mov: "video/quicktime",
  /* a mascot's animation (Lottie): data the phone's player reads, never a page */
  json: "application/json",
  /* the panel's fonts ("Yazı tipi", 2026-10-23): TrueType or OpenType only --
     what iOS and Android load from a file */
  ttf: "font/ttf", otf: "font/otf",
};
/* the first extension listed for a type is its name (image/jpeg → jpg, not jpeg) */
const EXT_OF: Record<string, string> = Object.fromEntries(Object.entries(MIME).reverse().map(([e, m]) => [m, e]));

export const extFor = (name: string, mime: string) => {
  const fromName = path.extname(name).slice(1).toLowerCase();
  return MIME[fromName] ? fromName : EXT_OF[mime] ?? "bin";
};
export const mimeFor = (ext: string) => MIME[ext] ?? "application/octet-stream";

export type AssetKind = "image" | "audio" | "video" | "animation" | "font";
const FONT_MIMES = ["font/ttf", "font/otf", "font/sfnt", "application/x-font-ttf", "application/x-font-otf",
                    "application/font-sfnt", "application/vnd.ms-opentype", "application/x-font-truetype"];
export const kindOf = (mime: string): AssetKind | null =>
  mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : mime.startsWith("video/") ? "video"
  : mime === "application/json" || mime === "application/lottie+json" ? "animation"
  : FONT_MIMES.includes(mime) ? "font" : null;
const KIND_NAME: Record<AssetKind, string> = { image: "resim", audio: "ses", video: "video", animation: "animasyon (Lottie)", font: "yazı tipi" };

/** ids are made here or by the panel; never a path */
export const safeId = (id: string) => /^[a-zA-Z0-9_-]{1,80}$/.test(id);
export const safeSha = (s: string) => /^[a-f0-9]{64}$/.test(s);

export const blobPath = (sha: string, ext: string) => path.join(P.blobs, `${sha}.${ext}`);
/** the address a phone downloads it from: immutable, cacheable forever. With
 *  CDN_BASE (a media origin of its own, decision 4) it is absolute */
export const cdnUrl = (sha: string, ext: string) => `${config.cdnBase}/cdn/${sha}.${ext}`;

/* ── blobs ────────────────────────────────────────────────────────────────── */

/**
 * ONE LOCK between a file becoming referenced and the collector (S05). An
 * upload streams to `.incoming-*` without it (that can take minutes); only
 * its last step -- putting the bytes in place and writing the asset row --
 * runs inside, and `gc` runs entirely inside. So the collector never sees a
 * blob that is in place but not yet named, and never deletes bytes a name
 * was given while it was looking. Publishing needs no part of it: a release
 * only freezes bytes that already have a name.
 *
 * Within one process that is the whole story. For anything outside it (a
 * second server on the same folder, a copy restored by hand), the collector
 * also leaves alone any blob touched in the last `GC_GRACE_MS` -- and a new
 * name for bytes that were already there touches them.
 */
let chain: Promise<unknown> = Promise.resolve();
export function withBlobLock<T>(f: () => Promise<T> | T): Promise<T> {
  const next = chain.then(f, f);
  chain = next.catch(() => {});
  return next;
}
export const GC_GRACE_MS = 10 * 60 * 1000;
/** an upload that has not written a byte for this long is dead */
export const INCOMING_STALE_MS = 60 * 60 * 1000;

/* ── what a file really is (decision 8, 2026-10-16) ────────────────────────
   The name and the declared type are the uploader's word; the first bytes
   are the file's. Only these are taken: PNG, JPEG, WebP; MP3, AAC (ADTS),
   WAV, M4A; MP4, MOV. SVG is refused whatever it is called: a picture that
   is a program is not shown to anyone. (The app's own SVG art is code in its
   repository, never an upload.) */
export class FileTypeError extends Error {}

export function sniff(h: Buffer): { kind: AssetKind; ext: string; mime: string } | null {
  const at = (i: number, s: string) => h.subarray(i, i + s.length).toString("latin1") === s;
  if (h[0] === 0x89 && at(1, "PNG")) return { kind: "image", ext: "png", mime: "image/png" };
  if (h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return { kind: "image", ext: "jpg", mime: "image/jpeg" };
  if (at(0, "RIFF") && at(8, "WEBP")) return { kind: "image", ext: "webp", mime: "image/webp" };
  if (at(0, "RIFF") && at(8, "WAVE")) return { kind: "audio", ext: "wav", mime: "audio/wav" };
  /* a font: TrueType (00 01 00 00, or Apple's "true") or OpenType/CFF ("OTTO") */
  if ((h[0] === 0 && h[1] === 1 && h[2] === 0 && h[3] === 0) || at(0, "true")) return { kind: "font", ext: "ttf", mime: "font/ttf" };
  if (at(0, "OTTO")) return { kind: "font", ext: "otf", mime: "font/otf" };
  if (at(0, "ID3")) return { kind: "audio", ext: "mp3", mime: "audio/mpeg" };
  if (h[0] === 0xff && (h[1]! & 0xf6) === 0xf0) return { kind: "audio", ext: "aac", mime: "audio/aac" };   /* ADTS */
  if (h[0] === 0xff && (h[1]! & 0xe0) === 0xe0) return { kind: "audio", ext: "mp3", mime: "audio/mpeg" };  /* MPEG frame */
  /* a Lottie document: JSON whose first key is one Lottie writes first.
     What it says inside is checked whole after it arrives (`lottieProblem`) */
  if (/^\s*\{\s*"(v|fr|ip|op|w|h|nm|ddd|assets|layers|markers|meta)"\s*:/.test(h.toString("utf8")))
    return { kind: "animation", ext: "json", mime: "application/json" };
  if (at(4, "ftyp")) {
    const brand = h.subarray(8, 12).toString("latin1");
    if (/^M4[AB] /.test(brand)) return { kind: "audio", ext: "m4a", mime: "audio/mp4" };
    if (brand === "qt  ") return { kind: "video", ext: "mov", mime: "video/quicktime" };
    return { kind: "video", ext: "mp4", mime: "video/mp4" };
  }
  return null;
}

const at4 = (h: Buffer, s: string) => h.subarray(0, 4).toString("latin1") === s;
/** the largest font taken: the app's own are 40–70 KB; a whole CJK font is not for this app */
export const FONT_MAX_BYTES = 4 * 1024 * 1024;

/** the largest animation taken: the app's own two are ~1.5 MB each */
export const LOTTIE_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Is this a Lottie document a phone may play, whole? The phone's player is
 * native (no script engine), the panel's preview is lottie-web (which HAS
 * one): an expression is a program, so a file with one is refused, and so is
 * a picture inside it that is fetched from somewhere rather than carried.
 */
export function lottieProblem(doc: unknown): string | null {
  const d = doc as { w?: unknown; h?: unknown; fr?: unknown; op?: unknown; layers?: unknown; assets?: unknown };
  if (!d || typeof d !== "object" || Array.isArray(d)) return "Lottie dosyası değil.";
  if (!Array.isArray(d.layers)) return "Lottie dosyası değil: katman listesi yok.";
  for (const k of ["w", "h", "fr", "op"] as const)
    if (typeof d[k] !== "number" || !Number.isFinite(d[k] as number)) return `Lottie dosyası değil: "${k}" yok.`;
  let bad: string | null = null;
  const walk = (x: unknown, depth: number): void => {
    if (bad || depth > 200 || !x || typeof x !== "object") return;
    if (Array.isArray(x)) { for (const y of x) walk(y, depth + 1); return; }
    const o = x as Record<string, unknown>;
    /* lottie-ios draws NOTHING of a file whose path flag is not true/false
       (lottie-web forgives it): refused here, not found on a phone */
    if ("v" in o && "c" in o && typeof o.c !== "boolean") { bad = "Bir şeklin kapalılık bayrağı (c) true/false değil (ör. 1.0): iOS'taki Lottie bu dosyayı hiç çizmez. Dosyayı yeniden dışa aktarın."; return; }
    if (typeof o.x === "string") { bad = "Dosyada ifade (expression) var: telefon onu oynatamaz ve önizleme onu çalıştırırdı. İfadesiz dışa aktarın."; return; }
    if (typeof o.p === "string" && "id" in o && !/^data:image\/(png|jpeg|webp);base64,/.test(o.p) && o.p !== "")
      { bad = "Dosyadaki bir resim dışarıdan geliyor: resimler dosyanın içine gömülü (PNG/JPEG/WebP) olmalı."; return; }
    for (const v of Object.values(o)) walk(v, depth + 1);
  };
  walk(d.assets, 0);
  walk(d.layers, 0);
  return bad;
}

/** stream bytes to a temporary file, hashing them on the way */
async function receive(data: Readable | Buffer): Promise<{ tmp: string; sha: string; md5: string; size: number; head: Buffer }> {
  const hash = createHash("sha256");
  const md5 = createHash("md5");
  let size = 0;
  let head = Buffer.alloc(0);
  const tmp = path.join(P.blobs, `.incoming-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (head.length < 64) head = Buffer.concat([head, chunk.subarray(0, 64 - head.length)]);
      hash.update(chunk); md5.update(chunk); size += chunk.length; cb(null, chunk);
    },
  });
  const src = Buffer.isBuffer(data) ? Readable.from([data]) : data;
  try { await pipeline(src, tap, createWriteStream(tmp)); }
  catch (e) { await rm(tmp, { force: true }); throw e; }
  return { tmp, sha: hash.digest("hex"), md5: md5.digest("hex"), size, head };
}

/** put received bytes in place (call inside the lock) */
async function settle(tmp: string, sha: string, ext: string) {
  const final = blobPath(sha, ext);
  if (existsSync(final)) {
    await rm(tmp, { force: true });
    /* the bytes were already here, maybe unnamed and old: fresh again, so a
       collector in another process leaves them alone */
    const now = new Date();
    await utimes(final, now, now).catch(() => {});
  } else await rename(tmp, final);
}

/** store bytes under their hash; returns the hash and the size */
export async function putBlob(data: Readable | Buffer, ext: string): Promise<{ sha: string; size: number }> {
  const { tmp, sha, size } = await receive(data);
  await withBlobLock(() => settle(tmp, sha, ext));
  return { sha, size };
}

/* ── assets ───────────────────────────────────────────────────────────────── */

export interface AssetRow {
  id: string; sha256: string; kind: AssetKind; mime: string; ext: string; size: number; name: string; created_at: number;
  md5: string | null;
}

/** an asset's MD5 (what a phone checks a download against), computed once for older rows */
export async function md5Of(a: AssetRow): Promise<string | null> {
  if (a.md5) return a.md5;
  const file = blobPath(a.sha256, a.ext);
  if (!existsSync(file)) return null;
  const h = createHash("md5").update(await readFile(file)).digest("hex");
  await run("UPDATE assets SET md5 = ? WHERE sha256 = ?", h, a.sha256);
  a.md5 = h;
  return h;
}

export interface AssetMeta {
  id: string; kind: AssetKind; name: string; mime: string; size: number; createdAt: number;
  /** where the panel shows it from */
  url: string;
  sha256: string;
}

/* the url names the bytes too: new bytes under the same name are a new
   address, so no browser shows an old picture as the new one */
export const metaOf = (r: AssetRow): AssetMeta => ({
  id: r.id, kind: r.kind, name: r.name, mime: r.mime, size: r.size, createdAt: r.created_at,
  url: `/api/assets/${r.id}?v=${r.sha256.slice(0, 12)}`, sha256: r.sha256,
});

/** store bytes as asset `id` (a new name, or new bytes for an existing one) */
export async function saveAsset(id: string, ext: string, data: Readable | Buffer, name = "",
                                mime = mimeFor(ext)): Promise<AssetMeta> {
  ext = ext.toLowerCase();
  const declared = kindOf(mime);
  if (!declared) throw new FileTypeError(`Desteklenmeyen tür: ${mime}`);
  const { tmp, sha, md5, size, head } = await receive(data);
  /* the bytes decide (decision 8): what they are, and that it is what was said */
  const real = sniff(head);
  const refuse = (m: string) => rm(tmp, { force: true }).then(() => { throw new FileTypeError(m); });
  if (/<svg|<\?xml/i.test(head.toString("utf8")) || ext === "svg") await refuse("SVG kabul edilmiyor: resimler PNG, JPEG ya da WebP olmalı.");
  if (at4(head, "wOFF") || at4(head, "wOF2")) await refuse("WOFF/WOFF2 web içindir, telefon açamaz: aynı fontun TTF ya da OTF dosyasını yükleyin.");
  if (at4(head, "ttcf")) await refuse("Font koleksiyonu (TTC) kabul edilmiyor: tek bir ağırlığın TTF ya da OTF dosyasını yükleyin.");
  if (!real) await refuse("Dosya türü tanınmadı: PNG, JPEG, WebP; MP3, M4A, AAC, WAV; MP4, MOV; Lottie (JSON); TTF, OTF kabul edilir.");
  if (real!.kind !== declared) await refuse(`Dosyanın içi bir ${KIND_NAME[real!.kind]}, ama ${mime} olarak gönderildi.`);
  const kind = real!.kind;
  if (kind === "font" && size > FONT_MAX_BYTES) await refuse(`Font ${Math.round(size / 1024)} KB: en çok ${FONT_MAX_BYTES / 1048576} MB.`);
  if (kind === "animation") {
    if (size > LOTTIE_MAX_BYTES) await refuse(`Animasyon ${Math.round(size / 1048576)} MB: en çok ${LOTTIE_MAX_BYTES / 1048576} MB.`);
    let doc: unknown = null;
    try { doc = JSON.parse(await readFile(tmp, "utf8")); } catch { await refuse("Lottie dosyası okunamadı: geçerli bir JSON değil."); }
    const p = lottieProblem(doc);
    if (p) await refuse(p);
  }
  /* the name follows the bytes; an MP4-family file keeps the extension it came with if that fits */
  ext = real!.ext === "mp4" && ["mp4", "m4a", "mov"].includes(ext) ? ext : real!.ext;
  /* the bytes in place and their name written, with nothing in between */
  await withBlobLock(async () => {
    await settle(tmp, sha, ext);
    await run(`INSERT INTO assets(id, sha256, kind, mime, ext, size, name, created_at, md5) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET sha256 = excluded.sha256, kind = excluded.kind, mime = excluded.mime,
           ext = excluded.ext, size = excluded.size, name = excluded.name, md5 = excluded.md5`,
        id, sha, kind, mimeFor(ext), ext, size, name, Date.now(), md5);
  });
  return metaOf((await getAsset(id))!);
}

export const getAsset = async (id: string): Promise<AssetRow | undefined> =>
  safeId(id) ? one<AssetRow>("SELECT * FROM assets WHERE id = ?", id) : undefined;

export const listAssets = (): Promise<AssetRow[]> => all<AssetRow>("SELECT * FROM assets ORDER BY created_at DESC, id COLLATE \"C\"");

/** every asset by id, read once: for work that looks up many (a release, a list) */
export async function assetMap(): Promise<Map<string, AssetRow>> {
  return new Map((await all<AssetRow>("SELECT * FROM assets")).map((a) => [a.id, a]));
}

export async function findAsset(id: string): Promise<{ file: string; ext: string; size: number; sha: string } | null> {
  const a = await getAsset(id);
  if (!a) return null;
  const file = blobPath(a.sha256, a.ext);
  return existsSync(file) ? { file, ext: a.ext, size: a.size, sha: a.sha256 } : null;
}

/** a stored file's bytes, all of them or `start`..`end` (inclusive) */
export const openAsset = (file: string, start?: number, end?: number) =>
  start === undefined ? createReadStream(file) : createReadStream(file, { start, end });
export const readAsset = (file: string) => readFile(file);

/** forget the name; the bytes stay until nothing refers to them (`gc`) */
export async function removeAsset(id: string) {
  await run("DELETE FROM assets WHERE id = ?", id);
}

/**
 * Collect blobs nothing refers to: no asset row, no release that was ever
 * published (a rollback must find its files), and not touched in the last
 * `GC_GRACE_MS`. Uploads that died half way (`.incoming-*` untouched for an
 * hour) go too. Runs inside the blob lock (see `withBlobLock`): two
 * collectors, or a collector and an upload, never interleave.
 */
export function gc(now = Date.now()): Promise<{ removed: number; bytes: number; held?: boolean }> {
  return withBlobLock(async () => {
    /* a backup is copying the files a database snapshot names: nothing is
       deleted until it is done (`tools/backup.ts`, decision 4) */
    if (gcHeld(now)) return { removed: 0, bytes: 0, held: true };
    const keep = new Set((await all<{ sha256: string }>("SELECT DISTINCT sha256 FROM assets")).map((r) => r.sha256));
    for (const r of await all<{ manifest: string }>("SELECT manifest FROM releases")) {
      const m = JSON.parse(r.manifest) as { assets?: Record<string, { sha256: string }> };
      for (const a of Object.values(m.assets ?? {})) keep.add(a.sha256);
    }
    let removed = 0, bytes = 0;
    for (const f of await readdir(P.blobs)) {
      const file = path.join(P.blobs, f);
      const st = await stat(file).catch(() => null);
      if (!st) continue;
      if (f.startsWith(".")) {
        if (f.startsWith(".incoming-") && now - st.mtimeMs > INCOMING_STALE_MS) {
          await rm(file, { force: true }); removed++; bytes += st.size;
        }
        continue;
      }
      if (keep.has(f.split(".")[0]!)) continue;
      if (now - st.mtimeMs < GC_GRACE_MS) continue;
      await rm(file, { force: true });
      removed++; bytes += st.size;
    }
    return { removed, bytes };
  });
}

/** the hold a backup puts on the collector: `DATA_DIR/.gc-hold` = an expiry time (ms) */
export const GC_HOLD = () => path.join(config.dataDir, ".gc-hold");
export function gcHeld(now = Date.now()): boolean {
  try { return Number(readFileSync(GC_HOLD(), "utf8")) > now; } catch { return false; }
}

/* ── what refers to a file (S06) ──────────────────────────────────────────── */

export interface Use { kind: string; ref: string; text: string; archive?: boolean }

/**
 * Every draft reference to an asset, in one place: a word's picture or
 * recording, a game's or category's card, a category film, a fixed line's
 * approved take -- and, as ARCHIVE, the studio's takes and generated
 * pictures (kept so a paid result is never lost). Releases are not listed:
 * their bytes outlive any name (`gc`).
 */
export async function assetUsage(id: string): Promise<Use[]> {
  return (await usageIndex()).get(id) ?? [];
}

/**
 * Every reference, for every asset, read in one go: the tables once and the
 * studio document once -- not once per file (the panel's file list asks for
 * all of them at once).
 */
export async function usageIndex(): Promise<Map<string, Use[]>> {
  const out = new Map<string, Use[]>();
  const add = (id: string | null | undefined, u: Use) => { if (id) out.set(id, [...(out.get(id) ?? []), u]); };
  const [words, audio, games, cats, slides, mascots, songs, fonts, studio] = await Promise.all([
    all<{ id: string; en: string; icon: string | null }>("SELECT id, en, icon FROM words WHERE icon IS NOT NULL"),
    all<{ word_id: string; slot: string; asset: string }>("SELECT word_id, slot, asset FROM word_audio"),
    all<{ id: string; name: string; icon: string | null }>("SELECT id, name, icon FROM games WHERE icon IS NOT NULL"),
    all<{ id: string; title: string; icon: string | null; steps: string }>("SELECT id, title, icon, steps FROM categories"),
    /* a row's painted-map picture (its `image` column) is no longer used by anything (drawn map, 2026-11-03) */
    all<{ id: string; title: string; stops: string }>("SELECT id, title, stops FROM road_slides"),
    all<{ id: string; name: string; base: string | null; look: string | null; sets: string }>("SELECT id, name, base, look, sets FROM mascots"),
    all<{ id: string; title: string; takes: string; chosen: string | null }>("SELECT id, title, takes, chosen FROM songs"),
    all<{ id: string; name: string; role: string; asset: string | null }>("SELECT id, name, role, asset FROM fonts"),
    studioDoc(),
  ]);
  for (const r of words) add(r.icon, { kind: "word-icon", ref: r.id, text: `${r.en} resmi` });
  for (const r of audio) add(r.asset, { kind: "word-audio", ref: `${r.word_id}/${r.slot}`, text: `${r.word_id} · ${r.slot} kaydı` });
  for (const r of games) add(r.icon, { kind: "game-icon", ref: r.id, text: `${r.name} kartı` });
  for (const r of cats) {
    add(r.icon, { kind: "category-icon", ref: r.id, text: `${r.title} kartı` });
    for (const st of JSON.parse(r.steps) as { id: string; kind: string; video?: string | null }[])
      if (st.kind === "video") add(st.video, { kind: "category-video", ref: `${r.id}/${st.id}`, text: `${r.title} · ${st.id} videosu` });
  }
  for (const r of slides) {
    for (const st of JSON.parse(r.stops) as { id: string; song?: string | null }[])
      add(st.song, { kind: "road-song", ref: `${r.id}/${st.id}`, text: `Yol haritası · ${r.title} · ${st.id} şarkısı` });
  }
  for (const r of mascots) {
    add(r.base, { kind: "mascot-base", ref: r.id, text: `Maskot · ${r.name} ana dosyası` });
    add(r.look, { kind: "mascot-look", ref: r.id, text: `Maskot · ${r.name} bakış dosyası` });
    for (const s of JSON.parse(r.sets) as { id: string; label: string; asset: string | null }[])
      add(s.asset, { kind: "mascot-set", ref: `${r.id}/${s.id}`, text: `Maskot · ${r.name} · ${s.label || s.id} seti` });
  }
  for (const r of songs) {
    add(r.chosen, { kind: "song", ref: r.id, text: `Müzik · ${r.title} (seçili)` });
    for (const a of new Set((JSON.parse(r.takes) as { asset: string }[]).map((t) => t.asset)))
      if (a !== r.chosen) add(a, { kind: "song-take", ref: r.id, text: `Müzik · ${r.title} denemesi`, archive: true });
  }
  for (const r of fonts) add(r.asset, { kind: "font", ref: r.id, text: `Yazı tipi · ${r.name || r.id} (${r.role})` });
  for (const [id, uses] of studioRefs(studio)) for (const u of uses) add(id, u);
  return out;
}

/* ── secrets ──────────────────────────────────────────────────────────────── */

export type SecretName = "elevenlabs" | "openai" | "gemini" | "anthropic" | "suno";
const ENV: Record<SecretName, string> = {
  elevenlabs: "ELEVENLABS_API_KEY", openai: "OPENAI_API_KEY", gemini: "GEMINI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY", suno: "SUNO_API_KEY",
};

async function readSecrets(): Promise<Partial<Record<SecretName, string>>> {
  if (!existsSync(P.secrets)) return {};
  return JSON.parse(await readFile(P.secrets, "utf8"));
}

/** a key entered from the panel wins over the environment */
export async function getSecret(n: SecretName): Promise<{ value: string; source: "panel" | "env" } | null> {
  const s = (await readSecrets())[n];
  if (s) return { value: s, source: "panel" };
  const e = process.env[ENV[n]];
  return e ? { value: e, source: "env" } : null;
}

export async function setSecret(n: SecretName, value: string | null) {
  const s = await readSecrets();
  if (value) s[n] = value; else delete s[n];
  await writeAtomic(P.secrets, JSON.stringify(s, null, 2));
}
