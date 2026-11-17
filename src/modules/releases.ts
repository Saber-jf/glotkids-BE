/**
 * RELEASES: what phones receive, frozen.
 *
 * The panel edits a DRAFT -- the rows in the database, changing all day. A
 * phone never reads the draft. Publishing takes everything that is marked
 * live and passes its checks, freezes it into one manifest (JSON: words, sets,
 * games, categories, recordings, and every file they use by content hash),
 * and stores it as release N. A CHANNEL points at the release its phones get:
 *
 *   test        what the team's own phones and the simulator read
 *               (`EXPO_PUBLIC_CONTENT_CHANNEL=test`) -- publish here first
 *   production  what everyone else reads -- promote a release once it has
 *               been seen on a phone
 *
 * Rolling back is pointing a channel at an older release: one click, no
 * re-publishing, and the files are still there (blobs outlive their names,
 * `files.ts` → `gc`).
 *
 * A phone asks with its build (`/api/app/manifest?build=N`) and is sent only
 * what that build can play (`requires`, from `app-inventory.json`): a
 * category that needs an engine from build 3 does not reach a phone on
 * build 2 -- it appears there once that phone updates.
 *
 *   admin   GET /releases · GET /releases/draft · POST /releases
 *           GET /releases/:id · GET /channels · PUT /channels/:name
 *   app     GET /api/app/manifest · GET /cdn/<sha>.<ext>
 */
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { all, one, run, tx } from "../storage/sql.js";
import { assetMap, cdnUrl, md5Of } from "../storage/files.js";
import { inventoryFor, latestInventory } from "./inventory.js";
import { allSets, clipOf, isWordClip, wordsById, type Slot } from "./vocab.js";
import { asLike, loadGames } from "./games.js";
import { asCat, loadCategories } from "./categories.js";
import { checkCategory, checkGame, requires, type Issue, type Step } from "./checks.js";
import { readDocument } from "./content.js";
import { slidesOut } from "./roadmap.js";
import { loadPacks, packsOut } from "./packs.js";
import { clipsOfWord } from "./vocab.js";
import { checkMascot, liveMascots, saysName, travel } from "./mascots.js";
import { checkPalette, livePalette } from "./palettes.js";
import { PaletteColors } from "./inventory.js";
import { checkFont, liveFonts, readFont } from "./fonts.js";
import { checkSong, songFacts } from "./songs.js";
import { checkSongVideo, loadSongVideos, videoFacts } from "./songvideos.js";

export const CHANNELS = ["test", "production"] as const;
export type Channel = (typeof CHANNELS)[number];
/** the manifest shape this server writes; a phone that reads another ignores it */
export const SCHEMA = 1;

/** `md5`: a second fingerprint of the same bytes, which a phone can compute natively (M08) */
export interface ManifestAsset { sha256: string; md5?: string; ext: string; size: number; kind: string; url: string }
export interface Manifest {
  schema: number;
  /** how a phone checks each file: "md5" -- every asset carries one and it
   *  is required. A manifest without this field is an older release: size
   *  only (decision 1, 2026-10-16). Not a cryptographic guarantee: what the
   *  manifest says is trusted because it came over HTTPS. */
  integrity?: "md5";
  release: number;
  createdAt: number;
  note: string;
  assets: Record<string, ManifestAsset>;
  words: { id: string; en: string; tr: string; about: string; kind: string; color: string; icon: string | null }[];
  sets: { id: string; name: string; words: string[] }[];
  /** the menu's new games (live, standalone). A category's step does NOT
   *  need its game here: the step carries its engine (S02/S03) */
  games: { id: string; template: string; name: string; subtitle: string; icon: string | null; set: string;
           config: Record<string, unknown>; requires: number }[];
  categories: { id: string; title: string; subtitle: string; icon: string | null; set: string; steps: ManifestStep[];
                requires: number; templates: string[]; scenes: string[];
                /** it travels in this download pack: a phone shows it only once the pack is downloaded */
                pack?: string }[];
  /** recordings, by the app's clip id: they replace the bundled take of the
   *  same id, or give a server word its voice */
  clips: Record<string, string>;
  /** a sentence with a gap for the word (the app's frames, 2026-10-23): where
   *  the pause is in its recording, [end of part 1, start of part 2] in
   *  seconds, as the panel measured it. A phone without one plays the old way. */
  cuts?: Record<string, [number, number]>;
  /** rows of the drawn map to lay after the app's own, in order -- a phone of a build
   *  before `since` does not get them (`forBuild`) */
  roadmap?: { since: number; slides: ManifestSlide[] };
  /** DOWNLOAD PACKS: lands and everything they need, NOT downloaded with the
   *  rest -- a phone offers each when the child reaches `offerAt` and fetches
   *  its `assets` only after a grown-up's yes. Every other asset is the base:
   *  downloaded by every phone, as before. */
  packs?: ManifestPack[];
  /** THE MASCOTS (the panel's "Maskotlar"): at most one per role, its files
   *  as asset ids, and how the two get about. Absent: the app's own two, as
   *  they walk in the build. A phone of a build before `since` does not get it */
  mascots?: ManifestMascots;
  /** SONGS (the panel's "Müzik") for the app's OWN music stops; a land's
   *  music stop carries its song in its slide. Absent: the build's own */
  songs?: { since: number; list: { stop: string; id: string; title: string; asset: string }[] };
  /** FONTS (the panel's "Yazı tipi"): at most one per role, the file as an
   *  asset id and the shortest safe line measured on it. Absent: the app's
   *  own four faces. A phone of a build before `since` does not get it */
  typography?: ManifestTypography;
  /** THE COLOUR PALETTE (the panel's "Renk paleti"): the one in play, colours
   *  by role. Absent: the app's own. A phone of a build before `since` does not get it */
  palette?: ManifestPalette;
  /** THE SONG FILMS (the panel's "Şarkı videoları", the app's "Şarkılar"
   *  tab), in order. Their POSTERS are downloaded with the release; their
   *  FILMS (`lazy`) are not -- a phone streams one the first time it is
   *  watched and keeps it. A phone of a build before `since` does not get it */
  songVideos?: ManifestSongVideos;
}

export interface ManifestSongVideos {
  since: number;
  list: { id: string; title: string; video: string; poster: string; category: string | null; fit?: "contain" }[];
  /** the asset ids a phone does not wait for (the films) */
  lazy: string[];
}

export interface ManifestPalette { since: number; id: string; name: string; colors: PaletteColors }

export interface ManifestTypography {
  since: number;
  faces: { role: "title" | "strong" | "body" | "bodyStrong"; id: string; name: string; asset: string; minLine: number }[];
}

export interface ManifestMascots {
  since: number;
  travel: { map: "walk" | "stroll"; scene: "walk" | "stroll" };
  list: { role: "learner" | "friend"; id: string; name: string; base: string; look: string | null;
          sets: { id: string; label: string; asset: string }[];
          map: Record<string, { set: string; marker: string }[]>;
          walkSet: string | null; strollSet: string | null; foot: { x: number; y: number; top: number } | null;
          voice: "keep" | "own" }[];
}

export interface ManifestPack {
  id: string; title: string; subtitle: string;
  /** offer it once the child has reached this stop (null: at once) */
  offerAt: string | null;
  lands: string[]; categories: string[];
  /** the files only this pack needs: what agreeing to it downloads */
  assets: string[]; bytes: number;
}

/**
 * A ROW of the drawn map (the app's `docs/YOL-HARITASI-CIZILI.md`): one
 * category, its game stops 1, 2, 3 and an optional music stop, laid after the
 * app's own rows. No picture and no places: the phone draws it.
 */
export interface ManifestSlide {
  id: string; title: string; category: string;
  /** the category's picture: the row's sign. Absent: the phone draws its own */
  icon?: string;
  stops: { id: string; kind: string; category: string; steps: string[]; song?: string;
           /** the picture of the game this stop plays. Absent: the phone draws its own */
           icon?: string }[];
  /** the download pack it travels in */
  pack?: string;
}

export interface DraftIssue extends Issue { item: string; kind: "game" | "category" | "clip" | "asset" | "roadmap" | "pack" | "mascot" | "song" | "font" | "palette" | "songvideo" }

/** a category step as a phone gets it: a game step names its engine and title
 *  itself, so it plays whether its game is on the menu, hidden, or one of the
 *  app's own (S02) */
export type ManifestStep = Step | { id: string; kind: "game"; game: string | null; teach: boolean; template: string; name: string };

/* ── recordings and the text they say ─────────────────────────────────────── */

interface StudioDoc {
  lines?: { clip: string; text: string; approved?: string; approvedText?: string }[];
  takes?: { clip: string; asset: string; text: string; cut?: unknown }[];
}

/** a frame whose blank has text on both sides: its recording needs a cut */
export const midBlank = (text: string): boolean => {
  const [a = "", b] = text.split("___");
  return b !== undefined && a.trim() !== "" && b.trim() !== "";
};

/** what a word's slot says on a phone; null for a sound with no words (`call`) */
export function expectedText(w: { en: string; tr: string; about: string }, slot: Slot, parts: string[]): string | null {
  switch (slot) {
    case "en": case "otter": return w.en;
    case "tr": return `Türkçesi, ${w.tr}.`;
    case "about": return w.about;
    case "about1": case "about2": case "about3": return parts[Number(slot.slice(5)) - 1] ?? "";
    default: return null;
  }
}

/** a word line longer than this is listed in the draft (M09): the phone plays
 *  it to its end, but a child waits through it */
export const LONG_CLIP_MS = 20_000;

/** two texts are the same line if they read the same: Unicode form and spacing do not count */
export const normText = (t: string) => t.normalize("NFC").replace(/\s+/g, " ").trim();
export const sameText = (a: string, b: string) => normText(a) === normText(b);

/* ── building the draft ───────────────────────────────────────────────────── */

export async function buildDraft(): Promise<{ manifest: Manifest; issues: DraftIssue[] }> {
  const inv = latestInventory();
  const issues: DraftIssue[] = [];
  const games = await loadGames();
  const gamesLike = games.map(asLike);

  const liveGames = games.filter((g) => !g.builtin && g.status === "live");
  const okGames: typeof liveGames = [];
  for (const g of liveGames) {
    const xs = await checkGame(asLike(g), inv);
    xs.forEach((i) => issues.push({ ...i, item: g.id, kind: "game" }));
    if (!xs.some((i) => i.level === "error")) okGames.push(g);
  }

  const liveCats = (await loadCategories()).filter((c) => !c.builtin && c.status === "live");
  const okCats: typeof liveCats = [];
  for (const c of liveCats) {
    const xs = await checkCategory(asCat(c), inv, gamesLike);
    xs.forEach((i) => issues.push({ ...i, item: c.id, kind: "category" }));
    if (!xs.some((i) => i.level === "error")) okCats.push(c);
  }

  /* every file, read once; an older row's MD5 is worked out (and kept) first */
  const rows = await assetMap();
  for (const a of rows.values()) if (!a.md5) await md5Of(a);
  const assets: Record<string, ManifestAsset> = {};
  const use = (id: string | null | undefined): string | null => {
    if (!id) return null;
    const a = rows.get(id);
    if (!a) return null;
    const md5 = a.md5;
    /* a file whose bytes are not on disk cannot be fingerprinted -- nor downloaded */
    if (!md5) { issues.push({ level: "error", kind: "asset", item: id, text: `"${id}" dosyasının baytları sunucuda yok; yayına girerse telefon indiremez.` }); return null; }
    assets[id] = { sha256: a.sha256, md5, ext: a.ext, size: a.size, kind: a.kind, url: cdnUrl(a.sha256, a.ext) };
    return id;
  };

  /* the songs of the music stops ("Müzik"): one live, whole song per stop */
  const facts = await songFacts();
  const songOf = new Map<string, { id: string; title: string; asset: string }>();
  for (const sg of facts.songs.filter((x) => x.status === "live")) {
    const xs = checkSong(sg, facts);
    xs.forEach((i) => issues.push({ ...i, item: sg.id, kind: "song" }));
    if (xs.some((i) => i.level === "error") || songOf.has(sg.stop) || !sg.chosen) continue;
    songOf.set(sg.stop, { id: sg.id, title: sg.title, asset: sg.chosen });
  }
  const ownStops = new Set((inv?.songs?.stops ?? []).map((x) => x.id));
  const songList = [...songOf.entries()].filter(([stop]) => ownStops.has(stop))
    .flatMap(([stop, x]) => { const a = use(x.asset); return a ? [{ stop, id: x.id, title: x.title, asset: a }] : []; });

  /*
   * THE ROADMAP AND WHO OWNS WHAT (F03). A category on a land of a download
   * pack belongs to that pack -- whatever the state of the land or the pack.
   * Ownership is worked out from EVERY land, not from the ones this release
   * carries: worked out from the published ones only, a category whose pack
   * is still a draft had no owner, fell into the base and reached every phone
   * (its words and pictures with it). Now such a category waits with its pack,
   * and the release says so. A category on no pack's land is base content.
   */
  const allSlides = await slidesOut();
  const allPacks = await loadPacks();
  const livePacks = new Set(allPacks.filter((p) => p.status === "live").map((p) => p.id));
  const packTitle = (id: string) => allPacks.find((p) => p.id === id)?.title ?? id;
  const owner = new Map<string, string>();
  for (const sl of allSlides) if (sl.pack) for (const st of sl.stops)
    if (st.kind !== "music" && st.category && !owner.has(st.category)) owner.set(st.category, sl.pack);
  const travels = new Set<string>();
  for (const c of okCats) {
    const p = owner.get(c.id);
    if (p && !livePacks.has(p))
      issues.push({ level: "warn", kind: "category", item: c.id,
                    text: `"${c.title}" "${packTitle(p)}" paketinin bir sırasında; paket uygulamada olmadığı için kategori de bu yayına girmiyor (herkese inen temel içeriğe düşmez).` });
    else travels.add(c.id);
  }

  /* the roadmap's rows: the live ones in order, while the chain holds --
     every stop's category must travel in this same release */
  const slides: ManifestSlide[] = [];
  /* why the chain stopped, so the lands after it are listed and not silently missing (UX02) */
  let stop: { at: number; why: string } | null = null;
  for (const [i, sl] of allSlides.entries()) {
    if (sl.status !== "live") { stop = { at: i, why: `"${sl.title}" sırası uygulamada değil` }; break; }
    /* a land of a pack that is not live waits with it, and so does every land after it */
    if (sl.pack && !livePacks.has(sl.pack)) { stop = { at: i, why: `"${sl.title}" sırası "${packTitle(sl.pack)}" paketinde ve paket uygulamada değil` }; break; }
    const xs = [...sl.issues];
    for (const st of sl.stops)
      if (st.kind !== "music" && !travels.has(st.category))
        xs.push({ level: "error", text: `"${st.id}" durağının kategorisi bu yayına girmiyor.` });
    xs.forEach((i) => issues.push({ ...i, item: sl.id, kind: "roadmap" }));
    if (xs.some((i) => i.level === "error")) { stop = { at: i, why: `"${sl.title}" sırasında hata var` }; break; }
    /* the row's sign is its category's picture; a stop's, the picture of the
       game it plays (its game step's game). Either may be missing: the phone
       then draws its own -- a row without a picture no longer stops the chain */
    const category = sl.category ?? "";
    const cat = okCats.find((c) => c.id === category);
    const catSteps = cat ? (JSON.parse(cat.steps) as Step[]) : [];
    const gameIcon = (steps: string[]) => {
      const gs = catSteps.filter((s): s is Extract<Step, { kind: "game" }> => s.kind === "game" && steps.includes(s.id));
      return use(games.find((g) => g.id === gs[gs.length - 1]?.game)?.icon);
    };
    const rowIcon = use(cat?.icon);
    slides.push({ id: sl.id, title: sl.title, category, ...(rowIcon ? { icon: rowIcon } : {}),
                  ...(sl.pack ? { pack: sl.pack } : {}),
                  stops: sl.stops.map((x) => {
                    if (x.kind === "music") {
                      const song = use(songOf.get(x.id)?.asset ?? x.song);
                      return { id: x.id, kind: x.kind, category, steps: [], ...(song ? { song } : {}) };
                    }
                    const icon = gameIcon(x.steps);
                    return { id: x.id, kind: x.kind, category: x.category, steps: x.steps, ...(icon ? { icon } : {}) };
                  }) });
  }

  if (stop) for (const sl of allSlides.slice(stop.at))
    if (sl.status === "live") issues.push({ level: "warn", kind: "roadmap", item: sl.id,
                                           text: `"${sl.title}" bu yayına girmiyor: ${stop.why}; harita orada biter.` });
  /* a live pack's category must be opened by one of the pack's lands that
     really travel -- otherwise its files would ship with nobody to show them */
  for (const id of [...travels]) {
    const p = owner.get(id);
    if (p && !slides.some((sl) => sl.pack === p && sl.stops.some((x) => x.category === id))) {
      travels.delete(id);
      const c = okCats.find((x) => x.id === id)!;
      issues.push({ level: "warn", kind: "category", item: id,
                    text: `"${c.title}" "${packTitle(p)}" paketinde ama paketin bu yayına giren hiçbir sırası onu açmıyor; yayına girmiyor.` });
    }
  }

  const setIds = new Set<string>();
  const outGames: Manifest["games"] = okGames.map((g) => {
    setIds.add(g.set_id!);
    return { id: g.id, template: g.template, name: g.name, subtitle: g.subtitle, icon: use(g.icon), set: g.set_id!,
             config: JSON.parse(g.config || "{}"), requires: requires(inv, [g.template], []) };
  });
  const outCats: Manifest["categories"] = okCats.filter((c) => travels.has(c.id)).map((c) => {
    setIds.add(c.set_id!);
    const steps = JSON.parse(c.steps) as Step[];
    const templates: string[] = [], scenes: string[] = [];
    const st = steps.map((s): ManifestStep => {
      if (s.kind === "video") return { ...s, video: use(s.video) };
      if (s.kind === "scene") { scenes.push(s.scene); return s; }
      if (s.kind === "game") {
        const g = games.find((x) => x.id === s.game)!;   /* checkCategory: the game exists */
        templates.push(g.template);
        return { ...s, template: g.template, name: g.name };
      }
      return s;
    });
    /* a category's game steps name catalog games; the app needs their engine */
    return { id: c.id, title: c.title, subtitle: c.subtitle, icon: use(c.icon), set: c.set_id!, steps: st,
             requires: requires(inv, templates, scenes), templates, scenes };
  });
  /* a category's games do NOT travel as menu games: a hidden or draft game
     a category uses, or one of the app's own, stays off the menu (S03) --
     the step carries its engine */
  const sets = (await allSets()).filter((s) => setIds.has(s.id)).map((s) => ({ id: s.id, name: s.name, words: s.words }));
  const wordIds = new Set(sets.flatMap((s) => s.words));
  const words = (await wordsById([...wordIds])).map((w) => ({
    id: w.id, en: w.en, tr: w.tr, about: w.about, kind: w.kind, color: w.color, icon: use(w.icon),
  }));

  /* recordings: every word that travels, AND every app word that has a take
     on the server (it replaces the bundled one), AND the fixed lines the
     voice studio approved. A recording travels only if it was made for the
     text the phone now shows (A08): one made from an older text is left out
     -- the phone falls back to its bundled take or the device voice, which at
     least say the right thing -- and listed, until it is re-recorded or
     explicitly approved for the new text. */
  const clips: Record<string, string> = {};
  const cuts: Record<string, [number, number]> = {};
  const clipIssue = (clip: string, text: string) => issues.push({ level: "warn", text, item: clip, kind: "clip" });
  const parts = (id: string) => inv?.words.find((x) => x.id === id)?.aboutParts ?? [];
  const builtinWords = (await all<{ id: string }>("SELECT id FROM words WHERE builtin = 1")).map((r) => r.id);
  const wordClips = new Set<string>();
  for (const w of await wordsById([...new Set([...wordIds, ...builtinWords])]))
    for (const [slot, a] of Object.entries(w.audio)) {
      const clip = clipOf(w.id, slot as Slot);
      wordClips.add(clip);
      if (!a || !rows.has(a.asset)) continue;
      const want = expectedText(w, slot as Slot, parts(w.id));
      /* a sentence-by-sentence take of a word the app says whole: nothing
         plays it, so it does not travel and is not a warning (2026-10-21) */
      if (want === "" && /^about\d$/.test(slot)) continue;
      if (want !== null && !a.text.trim()) clipIssue(clip, "Kaydın hangi metinden yapıldığı bilinmiyor; yayına giriyor, dinleyip kontrol edin.");
      else if (want !== null && !sameText(a.text, want)) {
        clipIssue(clip, `Kayıt eski metinden ("${a.text}"); şimdiki metin "${want}". Yayına girmez: yeniden kaydedin ya da bu metin için onaylayın.`);
        continue;
      }
      if (a.durationMs && a.durationMs > LONG_CLIP_MS)
        clipIssue(clip, `Kayıt ${Math.round(a.durationMs / 1000)} sn: bir kelime satırı için uzun (en çok ${LONG_CLIP_MS / 1000} sn önerilir); çocuk beklerken sıkılır.`);
      use(a.asset);
      clips[clip] = a.asset;
    }
  /* the mascots in play: one per role, only a whole one (`checkMascot`) */
  const mascotList: ManifestMascots["list"] = [];
  const minv = inv?.mascots;
  for (const m of await liveMascots()) {
    const xs = await checkMascot(m, minv);
    xs.forEach((i) => issues.push({ ...i, item: m.id, kind: "mascot" }));
    if (xs.some((i) => i.level === "error") || mascotList.some((x) => x.role === m.role)) continue;
    const base = use(m.base);
    const sets = m.sets.map((x) => ({ id: x.id, label: x.label, asset: use(x.asset) }));
    if (!base || sets.some((x) => !x.asset)) continue;
    mascotList.push({ role: m.role, id: m.id, name: m.name.trim(), base, look: m.role === "learner" ? use(m.look) : null,
                      sets: sets as { id: string; label: string; asset: string }[], map: m.map,
                      walkSet: m.walkSet, strollSet: m.strollSet, foot: m.foot, voice: m.voice });
  }
  const way = await travel(minv);
  const mascots: ManifestMascots | null = minv && (mascotList.length || way.map !== minv.travel.map || way.scene !== minv.travel.scene)
    ? { since: minv.since, travel: way, list: mascotList } : null;
  /* the fonts in play: one per role, only a whole one (`checkFont`) -- the
     letters, the weight, the licence checked on the file itself */
  const tinv = inv?.typography;
  const faceList: ManifestTypography["faces"] = [];
  for (const x of await liveFonts()) {
    const xs = await checkFont(x, tinv);
    xs.forEach((i) => issues.push({ ...i, item: x.id, kind: "font" }));
    if (!tinv || xs.some((i) => i.level === "error") || faceList.some((f) => f.role === x.role)) continue;
    const rep = await readFont(x.asset, tinv.required);
    const asset = use(x.asset);
    if (!asset || !rep || rep.error) continue;
    faceList.push({ role: x.role, id: x.id, name: x.name.trim(), asset, minLine: rep.minLine });
  }
  const typography: ManifestTypography | null = tinv && faceList.length ? { since: tinv.since, faces: faceList } : null;
  /* the palette in play, only a whole and readable one (`checkPalette`) */
  const pinv = inv?.palette;
  let palette: ManifestPalette | null = null;
  const lp = await livePalette();
  if (lp) {
    const xs = checkPalette(lp, pinv);
    xs.forEach((i) => issues.push({ ...i, item: lp.id, kind: "palette" }));
    const c = PaletteColors.safeParse(lp.colors);
    if (pinv && c.success && !xs.some((i) => i.level === "error")) palette = { since: pinv.since, id: lp.id, name: lp.name.trim(), colors: c.data };
  }
  /* the song films in play, in order, only whole ones (`checkSongVideo`) */
  const vinv = inv?.songVideos;
  const vfacts = await videoFacts();
  const filmList: ManifestSongVideos["list"] = [];
  for (const v of (await loadSongVideos()).filter((x) => x.status === "live")) {
    const xs = checkSongVideo(v, vfacts);
    xs.forEach((i) => issues.push({ ...i, item: v.id, kind: "songvideo" }));
    if (!vinv || xs.some((i) => i.level === "error")) continue;
    const video = use(v.video), poster = use(v.poster);
    if (!video || !poster) continue;
    filmList.push({ id: v.id, title: v.title.trim(), video, poster, category: v.category, ...(v.fit === "contain" ? { fit: "contain" as const } : {}) });
  }
  const songVideos: ManifestSongVideos | null = vinv && filmList.length
    ? { since: vinv.since, list: filmList, lazy: [...new Set(filmList.map((x) => x.video))] } : null;
  /* the app's own names that a mascot in play replaced */
  const renamed = (minv?.builtin ?? []).filter((b) => mascotList.some((x) => x.role === b.role && x.name !== b.name)).map((b) => b.name);

  const studio = (await readDocument("studio"))?.data as StudioDoc | undefined;
  const takes = Array.isArray(studio?.takes) ? studio!.takes : [];
  for (const l of Array.isArray(studio?.lines) ? studio!.lines : []) {
    if (!l.approved || !rows.has(l.approved)) continue;
    /* a word's clip belongs to the word (A09): a fixed line never shadows it */
    if (wordClips.has(l.clip) || await isWordClip(l.clip)) {
      clipIssue(l.clip, "Bu sabit cümlenin kimliği bir kelimenin kaydıyla çakışıyor; kelimenin kaydı kullanılır. Satırın kimliğini değiştirin.");
      continue;
    }
    /* a take that says a mascot's old name is not played while another
       mascot has that role -- it would call the new bear "Lili" */
    const oldName = renamed.find((n) => saysName(l.text, n));
    if (oldName) {
      clipIssue(l.clip, `Satır eski maskot adını söylüyor ("${oldName}"); yeni maskot yayındayken yayına girmez. Metni yeni adla güncelleyip yeniden kaydedin.`);
      continue;
    }
    const madeFrom = l.approvedText ?? takes.find((t) => t.clip === l.clip && t.asset === l.approved)?.text;
    if (madeFrom === undefined) clipIssue(l.clip, "Onaylı kaydın hangi metinden yapıldığı bilinmiyor; yayına giriyor.");
    else if (!sameText(madeFrom, l.text)) {
      clipIssue(l.clip, `Kayıt eski metinden ("${madeFrom}"); şimdiki metin "${l.text}". Yayına girmez.`);
      continue;
    }
    use(l.approved);
    clips[l.clip] = l.approved;
    /* a frame with its blank in the middle is played in two parts, cut at
       its pause -- measured by the panel when the take came in */
    const take = takes.find((t) => t.clip === l.clip && t.asset === l.approved);
    const cut = take?.cut;
    if (Array.isArray(cut) && cut.length === 2 && cut.every((x) => typeof x === "number" && Number.isFinite(x))
        && cut[0] > 0 && cut[1] > cut[0]) cuts[l.clip] = [cut[0], cut[1]];
    else if (midBlank(l.text))
      clipIssue(l.clip, "Boşluklu cümlenin kaydında boşluk ölçülmemiş (sessizlik bulunamadı); telefon bu cümlenin yerine eski kalıbı çalar. Panelde yeniden üretin.");
  }

  /*
   * THE PACKS. A category a pack's land opens travels in that pack: a phone
   * shows it only once the pack is downloaded. The files every phone gets
   * anyway (the BASE: the menu's games, the categories and lands outside
   * packs, the app's words' recordings, the fixed lines) are never counted
   * in a pack; what is left is what agreeing to the pack downloads.
   */
  const catPack = new Map<string, string>();
  for (const sl of slides) for (const st of sl.stops) {
    if (st.kind === "music" || !st.category) continue;
    const had = catPack.get(st.category);
    if (sl.pack && had && had !== sl.pack)
      issues.push({ level: "error", kind: "pack", item: sl.pack, text: `"${st.category}" kategorisi iki pakette birden; bir kategori tek pakette olur.` });
    if (sl.pack) catPack.set(st.category, sl.pack);
  }
  for (const sl of slides) if (!sl.pack) for (const st of sl.stops)
    if (catPack.has(st.category))
      issues.push({ level: "error", kind: "roadmap", item: sl.id, text: `"${st.category}" kategorisi bir pakette; paketsiz bir sıra onu açamaz.` });
  for (const c of outCats) if (catPack.has(c.id)) c.pack = catPack.get(c.id);
  const packOuts = (await packsOut()).filter((p) => livePacks.has(p.id) && slides.some((sl) => sl.pack === p.id));
  for (const p of packOuts) p.issues.filter((i) => i.level === "error").forEach((i) => issues.push({ ...i, kind: "pack", item: p.id }));

  const setOf = (id: string) => sets.find((x) => x.id === id)?.words ?? [];
  const base = new Set<string>();
  const baseWords = new Set<string>(builtinWords);
  const b = (id: string | null | undefined) => { if (id) base.add(id); };
  for (const g of outGames) { b(g.icon); setOf(g.set).forEach((w) => baseWords.add(w)); }
  for (const c of outCats) if (!c.pack) {
    b(c.icon);
    c.steps.forEach((x) => x.kind === "video" && b(x.video));
    setOf(c.set).forEach((w) => baseWords.add(w));
  }
  for (const sl of slides) if (!sl.pack) { b(sl.icon); sl.stops.forEach((x) => { b(x.song); b(x.icon); }); }
  for (const m of mascotList) { b(m.base); b(m.look); m.sets.forEach((x) => b(x.asset)); }
  for (const x of songList) b(x.asset);
  for (const f of faceList) b(f.asset);
  const packOnlyWords = new Set(words.filter((w) => !baseWords.has(w.id)).map((w) => w.id));
  const packClips = new Set([...packOnlyWords].flatMap(clipsOfWord));
  for (const w of words) if (!packOnlyWords.has(w.id)) b(w.icon);
  for (const [clip, a] of Object.entries(clips)) if (!packClips.has(clip)) b(a);
  const packs: ManifestPack[] = packOuts.map((p) => {
    const lands = slides.filter((sl) => sl.pack === p.id);
    const mine = new Set<string>();
    const m = (id: string | null | undefined) => { if (id && assets[id] && !base.has(id)) mine.add(id); };
    /* a packed row's pictures are the pack's (unless every phone has them anyway) */
    lands.forEach((sl) => { m(sl.icon); sl.stops.forEach((x) => { m(x.song); m(x.icon); }); });
    const cats = outCats.filter((c) => c.pack === p.id);
    for (const c of cats) {
      m(c.icon);
      c.steps.forEach((x) => x.kind === "video" && m(x.video));
      for (const wid of setOf(c.set)) {
        if (!packOnlyWords.has(wid)) continue;
        m(words.find((w) => w.id === wid)?.icon);
        clipsOfWord(wid).forEach((clip) => m(clips[clip]));
      }
    }
    return { id: p.id, title: p.title, subtitle: p.subtitle, offerAt: p.offerAt, lands: lands.map((l) => l.id),
             categories: cats.map((c) => c.id), assets: [...mine], bytes: [...mine].reduce((n, id) => n + assets[id]!.size, 0) };
  });

  return {
    manifest: { schema: SCHEMA, integrity: "md5", release: 0, createdAt: Date.now(), note: "", assets, words, sets,
                games: outGames, categories: outCats, clips,
                ...(Object.keys(cuts).length ? { cuts } : {}),
                ...(slides.length ? { roadmap: { since: inv?.roadmap?.since ?? 1, slides } } : {}),
                ...(packs.length ? { packs } : {}),
                ...(mascots ? { mascots } : {}),
                ...(typography ? { typography } : {}),
                ...(palette ? { palette } : {}),
                ...(songVideos ? { songVideos } : {}),
                ...(songList.length && inv?.songs ? { songs: { since: inv.songs.since, list: songList } } : {}) },
    issues,
  };
}

/* ── comparing two manifests ──────────────────────────────────────────────── */

export interface Diff { added: string[]; changed: string[]; removed: string[]; newBytes: number }

export function diff(a: Manifest | null, b: Manifest): Diff {
  const d: Diff = { added: [], changed: [], removed: [], newBytes: 0 };
  /* an asset reference is compared by the bytes it names (S04): the same id
     with a new picture is a change, a return to old bytes too */
  const fp = (m: Manifest, id: string | null | undefined) => (id ? m.assets[id]?.sha256 ?? `?${id}` : null);
  const groups: [string, (m: Manifest) => Map<string, unknown>][] = [
    ["oyun", (m) => new Map(m.games.map((x) => [x.id, { ...x, icon: fp(m, x.icon) }]))],
    ["kategori", (m) => new Map(m.categories.map((x) => [x.id, { ...x, icon: fp(m, x.icon),
      steps: x.steps.map((s) => (s.kind === "video" ? { ...s, video: fp(m, s.video) } : s)) }]))],
    ["kelime", (m) => new Map(m.words.map((x) => [x.id, { ...x, icon: fp(m, x.icon) }]))],
    ["set", (m) => new Map(m.sets.map((x) => [x.id, x]))],
    ["kayıt", (m) => new Map(Object.entries(m.clips).map(([k, v]) => [k, fp(m, v)]))],
    ["kayıt boşluğu", (m) => new Map(Object.entries(m.cuts ?? {}))],
    ["harita sırası", (m) => new Map((m.roadmap?.slides ?? []).map((x) => [x.id, { ...x, icon: fp(m, x.icon),
      stops: x.stops.map((s) => ({ ...s, icon: fp(m, s.icon), song: fp(m, s.song) })) }]))],
    ["indirme paketi", (m) => new Map((m.packs ?? []).map((x) => [x.id, { ...x, assets: x.assets.map((a) => fp(m, a)).sort() }]))],
    ["maskot", (m) => new Map((m.mascots?.list ?? []).map((x) => [x.role, { ...x, base: fp(m, x.base), look: fp(m, x.look),
      sets: x.sets.map((y) => ({ ...y, asset: fp(m, y.asset) })) }]))],
    ["yürüyüş", (m) => new Map(m.mascots ? [["harita ve sahneler", m.mascots.travel]] : [])],
    ["şarkı", (m) => new Map((m.songs?.list ?? []).map((x) => [x.stop, { ...x, asset: fp(m, x.asset) }]))],
    ["yazı tipi", (m) => new Map((m.typography?.faces ?? []).map((x) => [x.role, { ...x, asset: fp(m, x.asset) }]))],
    ["renk paleti", (m) => new Map(m.palette ? [[m.palette.name || m.palette.id, m.palette.colors]] : [])],
    ["şarkı videosu", (m) => new Map((m.songVideos?.list ?? []).map((x, i) => [x.id, { ...x, video: fp(m, x.video), poster: fp(m, x.poster), at: i }]))],
  ];
  for (const [label, of] of groups) {
    const x = a ? of(a) : new Map(), y = of(b);
    for (const [k, v] of y) {
      if (!x.has(k)) d.added.push(`${label}: ${k}`);
      else if (JSON.stringify(x.get(k)) !== JSON.stringify(v)) d.changed.push(`${label}: ${k}`);
    }
    for (const k of x.keys()) if (!y.has(k)) d.removed.push(`${label}: ${k}`);
  }
  /* the order is what the menu shows: a new order alone is a change */
  if (a) {
    const order = (xs: { id: string }[], keep: Set<string>) => xs.map((x) => x.id).filter((id) => keep.has(id)).join();
    for (const [label, xa, xb] of [["oyunlar", a.games, b.games], ["kategoriler", a.categories, b.categories]] as const) {
      const both = new Set(xa.map((x) => x.id).filter((id) => xb.some((y) => y.id === id)));
      if (order(xa, both) !== order(xb, both)) d.changed.push(`sıra: ${label}`);
    }
  }
  const had = new Set(Object.values(a?.assets ?? {}).map((x) => x.sha256));
  for (const x of Object.values(b.assets)) if (!had.has(x.sha256)) d.newBytes += x.size;
  return d;
}

/**
 * The draft's fingerprint (A03): everything a phone would get, without the
 * stamp of when it was built. The panel shows a draft and publishes THAT
 * draft -- a draft that changed in between is refused, not published blind.
 */
export function fingerprint(m: Manifest): string {
  const { createdAt: _c, release: _r, note: _n, ...rest } = m;
  return createHash("sha256").update(JSON.stringify(rest)).digest("hex").slice(0, 16);
}

/* ── stored releases ──────────────────────────────────────────────────────── */

/* a release never changes once made: read once, kept */
const manifests = new Map<number, Manifest>();
export async function releaseManifest(id: number): Promise<Manifest | null> {
  if (!Number.isSafeInteger(id)) return null;
  const hit = manifests.get(id);
  if (hit) return hit;
  const r = await one<{ manifest: string }>("SELECT manifest FROM releases WHERE id = ?", id);
  if (!r) return null;
  const m = JSON.parse(r.manifest) as Manifest;
  /* written in two steps inside its transaction: '{}' is never seen outside it */
  if (m.release === id) manifests.set(id, m);
  return m;
}

export const channelHead = async (name: string): Promise<number | null> =>
  (await one<{ release_id: number | null }>("SELECT release_id FROM channels WHERE name = ?", name))?.release_id ?? null;

/** every channel and the release it points at */
export const channelsOut = async () => {
  const heads = new Map((await all<{ name: string; release_id: number | null }>("SELECT name, release_id FROM channels")).map((r) => [r.name, r.release_id]));
  return CHANNELS.map((name) => ({ name, release: heads.get(name) ?? null }));
};

export async function listReleases() {
  const heads = await all<{ name: string; release_id: number }>("SELECT name, release_id FROM channels");
  return (await all<{ id: number; note: string; assets: number; bytes: number; created_at: number }>(
    "SELECT id, note, assets, bytes, created_at FROM releases ORDER BY id DESC")).map((r) => ({
    id: r.id, note: r.note, assets: r.assets, bytes: r.bytes, createdAt: r.created_at,
    channels: heads.filter((h) => h.release_id === r.id).map((h) => h.name),
  }));
}

export async function publish(note: string, channels: readonly string[], built?: Manifest): Promise<{ id: number }> {
  return tx(async () => {
    const manifest = built ?? (await buildDraft()).manifest;
    const created = Date.now();
    const bytes = Object.values(manifest.assets).reduce((n, a) => n + a.size, 0);
    const r = await run("INSERT INTO releases(note, manifest, assets, bytes, created_at) VALUES(?, '{}', ?, ?, ?) RETURNING id",
                        note, Object.keys(manifest.assets).length, bytes, created);
    const id = Number(r.rows[0]!.id);
    const frozen: Manifest = { ...manifest, release: id, createdAt: created, note };
    await run("UPDATE releases SET manifest = ? WHERE id = ?", JSON.stringify(frozen), id);
    for (const ch of channels) await point(ch, id);
    return { id };
  });
}

async function point(channel: string, release: number) {
  await run(`INSERT INTO channels(name, release_id, updated_at) VALUES(?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET release_id = excluded.release_id, updated_at = excluded.updated_at`,
      channel, release, Date.now());
}

/* ── what one phone gets ──────────────────────────────────────────────────── */

/**
 * The release, cut to what a phone of `build` can play: games and categories
 * whose engines and scenes that build has, and only the words, sets and files
 * those still use (plus the recordings).
 */
export function forBuild(m: Manifest, build: number): Manifest {
  const inv = inventoryFor(build);
  const hasT = (t: string) => !!inv?.templates.some((x) => x.id === t && x.since <= build);
  const hasS = (s: string) => !!inv?.scenes.some((x) => x.id === s && x.since <= build);
  const games = m.games.filter((g) => g.requires <= build && hasT(g.template));
  /* a category plays if this build has every engine its steps name (the
     step carries it -- the app's own drag/pop included, S02) and every scene */
  const categories = m.categories.filter((c) => c.requires <= build && c.templates.every(hasT) && c.scenes.every(hasS)
    && c.steps.every((s) => s.kind !== "game" || ("template" in s ? hasT(s.template) : games.some((g) => g.id === s.game))));
  const setIds = new Set([...games.map((g) => g.set), ...categories.map((c) => c.set)]);
  const sets = m.sets.filter((s) => setIds.has(s.id));
  const wordIds = new Set(sets.flatMap((s) => s.words));
  const words = m.words.filter((w) => wordIds.has(w.id));
  const used = new Set<string>();
  const keep = (id: string | null | undefined) => { if (id) used.add(id); };
  games.forEach((g) => keep(g.icon));
  categories.forEach((c) => { keep(c.icon); c.steps.forEach((s) => s.kind === "video" && keep(s.video)); });
  words.forEach((w) => keep(w.icon));
  Object.values(m.clips).forEach(keep);
  /* the lands, if this build lays lands -- and only while each one's
     categories reached this build (the chain: no island) */
  const slides: ManifestSlide[] = [];
  if (m.roadmap && build >= m.roadmap.since)
    for (const sl of m.roadmap.slides) {
      if (!sl.stops.every((st) => st.kind === "music" || categories.some((c) => c.id === st.category))) break;
      slides.push(sl);
      keep(sl.icon);
    }
  slides.forEach((sl) => sl.stops.forEach((st) => { keep(st.song); keep(st.icon); }));
  const assets = Object.fromEntries(Object.entries(m.assets).filter(([id]) => used.has(id)));
  /* a pack reaches a build only with all of its lands */
  const packs = (m.packs ?? []).filter((p) => p.lands.every((id) => slides.some((sl) => sl.id === id)))
    .map((p) => ({ ...p, assets: p.assets.filter((id) => !!assets[id]) }));
  const cats = categories.filter((c) => !c.pack || packs.some((p) => p.id === c.pack));
  const { roadmap: _r, packs: _p, mascots: _m, songs: _s, typography: _t, palette: _c, songVideos: _v, ...rest } = m;
  /* the palette, if this build draws one (an older one keeps its own colours) */
  const palette = m.palette && build >= m.palette.since && inv?.palette ? m.palette : null;
  /* the songs of the app's own music stops, if this build plays them */
  const songs = m.songs && build >= m.songs.since && inv?.songs ? m.songs : null;
  if (songs) songs.list.forEach((x) => used.add(x.asset));
  /* the mascots, if this build plays them (an older one keeps its own) */
  const mascots = m.mascots && build >= m.mascots.since && inv?.mascots ? m.mascots : null;
  if (mascots) for (const x of mascots.list) { used.add(x.base); if (x.look) used.add(x.look); x.sets.forEach((y) => used.add(y.asset)); }
  /* the fonts, if this build draws them (an older one keeps its own faces) */
  const typography = m.typography && build >= m.typography.since && inv?.typography ? m.typography : null;
  if (typography) typography.faces.forEach((x) => used.add(x.asset));
  /* the song films, if this build has the tab (an older one has nowhere to show them) */
  const songVideos = m.songVideos && build >= m.songVideos.since && inv?.songVideos ? m.songVideos : null;
  if (songVideos) songVideos.list.forEach((x) => { used.add(x.video); used.add(x.poster); });
  return { ...rest, games, categories: cats, sets, words,
           assets: mascots || songs || typography || songVideos ? Object.fromEntries(Object.entries(m.assets).filter(([id]) => used.has(id))) : assets,
           ...(slides.length ? { roadmap: { since: m.roadmap!.since, slides } } : {}),
           ...(packs.length ? { packs } : {}),
           ...(mascots ? { mascots } : {}),
           ...(typography ? { typography } : {}),
           ...(palette ? { palette } : {}),
           ...(songVideos ? { songVideos } : {}),
           ...(songs ? { songs } : {}) };
}

/* ── routes ───────────────────────────────────────────────────────────────── */

const Publish = z.object({ note: z.string().max(500).default(""), channels: z.array(z.enum(CHANNELS)).min(1).default(["test"]),
                           /** the draft fingerprint the panel showed: refused if the draft is no longer that */
                           expect: z.string().max(64).optional() });

export async function releaseRoutes(app: FastifyInstance) {
  app.get("/releases", async () => ({ releases: await listReleases(), channels: await channelsOut() }));

  /* what publishing now would send: the manifest, what stops it, what changed */
  app.get("/releases/draft", async () => {
    const { manifest, issues } = await buildDraft();
    const heads: Record<string, Diff> = {};
    for (const c of await channelsOut()) heads[c.name] = diff(c.release ? await releaseManifest(c.release) : null, manifest);
    return {
      manifest, issues, fingerprint: fingerprint(manifest),
      blocked: issues.filter((i) => i.level === "error").length > 0,
      diff: heads,
      counts: { games: manifest.games.length, categories: manifest.categories.length, words: manifest.words.length,
                clips: Object.keys(manifest.clips).length, assets: Object.keys(manifest.assets).length,
                /* songs of music stops: the app's own and the lands' */
                songs: (manifest.songs?.list.length ?? 0) + (manifest.roadmap?.slides ?? []).reduce((n, sl) => n + sl.stops.filter((x) => x.kind === "music" && x.song).length, 0),
                mascots: manifest.mascots?.list.length ?? 0,
                fonts: manifest.typography?.faces.length ?? 0,
                palette: manifest.palette?.name ?? "",
                songVideos: manifest.songVideos?.list.length ?? 0,
                /* what every phone downloads before it switches: the films come later */
                lazyBytes: (manifest.songVideos?.lazy ?? []).reduce((n, id) => n + (manifest.assets[id]?.size ?? 0), 0),
                bytes: Object.values(manifest.assets).reduce((n, a) => n + a.size, 0) },
    };
  });

  /* one transaction: the draft checked and fingerprinted is the draft frozen */
  app.post("/releases", (req, reply) => tx(async () => {
    const b = Publish.safeParse(req.body ?? {});
    if (!b.success) return reply.code(400).send({ error: "Geçersiz istek" });
    const { manifest, issues } = await buildDraft();
    const errors = issues.filter((i) => i.level === "error");
    if (errors.length)
      return reply.code(400).send({ error: "Hatası olan içerik var; düzeltin ya da taslağa alın.", issues: errors });
    if (b.data.expect && b.data.expect !== fingerprint(manifest))
      return reply.code(409).send({ code: "DRAFT_CHANGED", error: "Taslak, gösterildikten sonra değişti. Yeni hâlini gözden geçirip yeniden yayınlayın.",
                                    fingerprint: fingerprint(manifest) });
    const made = await publish(b.data.note, b.data.channels, manifest);
    reply.code(201);
    return made;
  }));

  app.get("/releases/:id", async (req, reply) =>
    (await releaseManifest(Number((req.params as { id: string }).id))) ?? reply.code(404).send({ error: "Yayın yok" }));

  app.get("/channels", async () => channelsOut());

  /* promote a release to a channel, or roll a channel back to an older one */
  app.put("/channels/:name", (req, reply) => tx(async () => {
    const name = (req.params as { name: string }).name;
    if (!(CHANNELS as readonly string[]).includes(name)) return reply.code(404).send({ error: "Kanal yok" });
    const b = z.object({ release: z.number().int() }).safeParse(req.body);
    if (!b.success || !(await releaseManifest(b.data.release))) return reply.code(400).send({ error: "Böyle bir yayın yok" });
    await point(name, b.data.release);
    return channelsOut();
  }));
}
