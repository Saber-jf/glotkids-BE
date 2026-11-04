/**
 * WILL IT PLAY ON A PHONE? One set of checks for games and categories, against
 * what the app said it can play (`inventory.ts`) and the house rules.
 *
 *   error  it would break on a phone: nothing with an error is published
 *   warn   it plays, but against a rule (5-7 words, a description, a picture)
 *
 * `requires` is the build a phone needs to play it: the newest `since` of any
 * engine or scene it uses. A release sends it only to phones that have it.
 */
import type { InventoryDoc } from "./inventory.js";
import { getAsset, type AssetRow } from "../storage/files.js";
import { setById, wordsById, type WordOut } from "./vocab.js";

/** `area`: which part of a category it is about -- the panel's wizard shows
 *  each where it can be fixed (card, words, flow) */
export interface Issue { level: "error" | "warn"; text: string; step?: string; area?: "card" | "words" | "flow" }

export type Step =
  /** `fit`: "cover" fills the screen and crops what does not fit (rule 16, the
   *  default); "contain" shows the whole film with bands -- for a film that
   *  was not shot for the phone's frame and has something at its edge */
  | { id: string; kind: "video"; video: string | null; note: string; fit?: "cover" | "contain" }
  | { id: string; kind: "scene"; scene: string; note: string }
  /** `teach`: introduce each word with a card before asking for it */
  | { id: string; kind: "game"; game: string | null; teach: boolean }
  | { id: string; kind: "finish" };

export interface GameLike {
  id: string; template: string; builtin: boolean; name: string; status: string; set: string | null;
}

export function templateOf(inv: InventoryDoc | null, id: string) {
  return inv?.templates.find((t) => t.id === id) ?? null;
}

/** the words of a set, in order, or [] */
export async function setWords(set: string | null): Promise<WordOut[]> {
  if (!set) return [];
  const s = await setById(set);
  return s ? wordsById(s.words) : [];
}

function wordChecks(words: WordOut[], needsIcon: boolean, out: Issue[]) {
  const err = (text: string) => out.push({ level: "error", text });
  const warn = (text: string) => out.push({ level: "warn", text });
  if (words.length < 2) err("En az iki kelime gerekli: her turda bir alternatif olmalı (kural 10b).");
  else if (words.length < 5 || words.length > 7) warn(`${words.length} kelime var; bir seri 5–7 kelime kullanır (kural 11).`);
  const noIcon = words.filter((w) => !w.icon).map((w) => w.id);
  if (noIcon.length && needsIcon) err(`Resmi olmayan kelime: ${noIcon.join(", ")}. Bu oyun kelimeyi resmiyle gösteriyor.`);
  else if (noIcon.length) warn(`${noIcon.length} kelimenin resmi yok; okumayı bilmeyen çocuk resimden seçer.`);
  const noAbout = words.filter((w) => !w.about.trim()).length;
  if (noAbout) warn(`${noAbout} kelimenin açıklama cümlesi yok (kural 10).`);
  const noEn = words.filter((w) => !w.audio.en).length;
  if (noEn) warn(`${noEn} kelimenin İngilizce kaydı yok; telefon cihaz sesiyle okur.`);
}

/** a server game (built from an open engine with words of its own) */
export async function checkGame(g: GameLike, inv: InventoryDoc | null): Promise<Issue[]> {
  if (g.builtin) return [];
  const out: Issue[] = [];
  const t = templateOf(inv, g.template);
  if (!inv) out.push({ level: "error", text: "Uygulama envanteri yok: hangi oyunların oynanabildiği bilinmiyor." });
  else if (!t) out.push({ level: "error", text: `"${g.template}" motoru uygulamada yok.` });
  else if (!t.open) out.push({ level: "error", text: `"${t.name}" yeni kelimelerle oynayamıyor; bunun için uygulamada değişiklik gerekir.` });
  /* decision 2: an engine that does not introduce its words is practice, not
     a first meeting -- and with no record of what a child has learned, it is
     not assumed that they "know them anyway". Such a game is played inside a
     category, after a step that introduced the same words. */
  if (t && t.open && !t.teach)
    out.push({ level: "error", text: `"${t.name}" kelimeleri tanıtmaz: tek başına yayınlanamaz. Bir kategoride, aynı kelimeleri kartla tanıtan bir adımdan sonra kullanın.` });
  if (!g.name.trim()) out.push({ level: "error", text: "Adı yok." });
  if (!g.set) out.push({ level: "error", text: "Kelime seti seçilmedi." });
  else wordChecks(await setWords(g.set), t?.needs.icon ?? true, out);
  return out;
}

/** a film larger than this is listed: every phone downloads it before the category opens */
export const VIDEO_WARN_BYTES = 40 * 1024 * 1024;

export interface CategoryLike {
  id: string; builtin: boolean; title: string; set: string | null; steps: Step[];
}

export async function checkCategory(c: CategoryLike, inv: InventoryDoc | null, games: GameLike[]): Promise<Issue[]> {
  const out: Issue[] = [];
  const err = (text: string, step?: string) => out.push({ level: "error", text, step, area: "flow" });
  const warn = (text: string, step?: string) => out.push({ level: "warn", text, step, area: "flow" });
  if (!c.title.trim()) out.push({ level: "error", text: "Başlık yok.", area: "card" });
  if (!inv) err("Uygulama envanteri yok: hangi oyun ve sahnelerin oynanabildiği bilinmiyor.");
  if (!c.set) out.push({ level: "error", text: "Kelime seti seçilmedi.", area: "words" });
  else if (!c.builtin) {
    const words: Issue[] = [];
    wordChecks(await setWords(c.set), true, words);
    out.push(...words.map((i) => ({ ...i, area: "words" as const })));
  }

  const videos = new Map<string, AssetRow | undefined>();
  for (const s of c.steps) if (s.kind === "video" && s.video) videos.set(s.video, await getAsset(s.video));
  const seen = new Set<string>();
  c.steps.forEach((s, i) => {
    const at = `${i + 1}. adım`;
    if (!s.id) err(`${at}: kimliği yok.`, s.id);
    else if (seen.has(s.id)) err(`${at}: "${s.id}" kimliği iki kez kullanılmış.`, s.id);
    seen.add(s.id);
    if (s.kind === "video" && !s.video) warn(`${at}: video yüklenmedi; uygulama notu gösteren bir yer tutucu açar.`, s.id);
    if (s.kind === "video" && s.video) {
      const a = videos.get(s.video);
      /* QuickTime plays on an iPhone, not reliably on Android */
      if (a?.ext === "mov") warn(`${at}: video MOV; Android telefonlar oynatamayabilir. MP4 (H.264) olarak yükleyin.`, s.id);
      if (a && a.size > VIDEO_WARN_BYTES)
        warn(`${at}: video ${Math.round(a.size / 1048576)} MB; telefon bunu indirmeden kategoriyi açamaz. ${VIDEO_WARN_BYTES / 1048576} MB'ın altı önerilir.`, s.id);
    }
    if (s.kind === "scene") {
      const sc = inv?.scenes.find((x) => x.id === s.scene);
      if (!sc) err(`${at}: sahne seçilmedi ya da uygulamada yok.`, s.id);
      else if (sc.for && sc.for !== c.id)
        warn(`${at}: "${sc.name}" başka bir serinin hikâyesi için yazıldı; kendi yerini ve kelimelerini gösterir.`, s.id);
    }
    if (s.kind === "game") {
      if (!s.game) { err(`${at}: oyun seçilmedi.`, s.id); return; }
      const g = games.find((x) => x.id === s.game);
      if (!g) { err(`${at}: "${s.game}" diye bir oyun yok.`, s.id); return; }
      const t = templateOf(inv, g.template);
      if (!t) { err(`${at}: "${g.name}" motoru uygulamada yok.`, s.id); return; }
      /* the app's own categories play the app's own words: a step needs only
         an engine that takes content from a category (`accepts`). A new
         category brings words the app has never seen: only an open engine
         can draw them. */
      if (c.builtin) { if (!t.accepts) err(`${at}: "${g.name}" bir kategoriden içerik almıyor.`, s.id); }
      else if (!t.open) err(`${at}: "${g.name}" yeni kelimelerle oynayamıyor.`, s.id);
      if (g.status === "hidden") warn(`${at}: "${g.name}" gizli bir oyun; kategoride oynar, menüde görünmez.`, s.id);
      if (s.teach && t.open && !t.teach)
        warn(`${at}: "${g.name}" kelimeleri kartla tanıtmıyor; "önce kartla tanıtsın" bu adımda etkisiz.`, s.id);
      /* decision 2: before it, a step that really introduced the words */
      if (!c.builtin && t.open && !t.teach && !introduced(c.steps.slice(0, i), games, inv))
        err(`${at}: "${g.name}" kelimeleri tanıtmaz; daha önceki bir adımda aynı kelimeler kartla tanıtılmalı (ör. “Lili'ye ver”, “önce kartla tanıtsın” açık).`, s.id);
    }
  });
  const last = c.steps[c.steps.length - 1];
  if (!last || last.kind !== "finish") err("Son adım “Bitiş” olmalı.");
  if (c.steps.filter((s) => s.kind === "finish").length > 1) err("Yalnızca bir “Bitiş” adımı olabilir.");
  const plays = c.steps.filter((s) => s.kind === "game").length;
  if (plays === 0) err("Akışta hiç oyun yok.");
  else if (plays !== 3) warn(`Akışta ${plays} oyun var; bir seri üç oyundan oluşur (öğret, alıştır, ölç).`);
  return out;
}

/** did one of these steps introduce the category's words with cards? */
function introduced(steps: Step[], games: GameLike[], inv: InventoryDoc | null): boolean {
  return steps.some((s) => {
    if (s.kind !== "game" || !s.teach || !s.game) return false;
    const g = games.find((x) => x.id === s.game);
    return !!g && !!templateOf(inv, g.template)?.teach;
  });
}

/** the build a phone needs for these engines and scenes */
export function requires(inv: InventoryDoc | null, templates: string[], scenes: string[]): number {
  let b = 1;
  for (const id of templates) b = Math.max(b, templateOf(inv, id)?.since ?? 1);
  for (const id of scenes) b = Math.max(b, inv?.scenes.find((s) => s.id === id)?.since ?? 1);
  return b;
}

export const hasError = (xs: Issue[]) => xs.some((i) => i.level === "error");
