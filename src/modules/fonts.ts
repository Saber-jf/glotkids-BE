/**
 * FONTS (the panel's "Yazı tipi", 2026-10-23): the app's type, as content.
 *
 * The app draws every text in one of four ROLES (`loplop/src/content/
 * typography.ts`): `title` (Fredoka TR 600: titles, tabs, buttons, the big
 * words), `strong` (700: a short strong emphasis), `body` (Nunito 400:
 * descriptions, forms, the parents' screens) and `bodyStrong` (600). A FONT
 * here fills one role with a TTF/OTF file; at most one is in play per role,
 * and a release carries the ones in play (`releases.ts` → `typography`).
 *
 * THE FILE IS READ, NOT TRUSTED. When a file is chosen it is parsed and its
 * report kept: its names, its weight, whether it is a variable font, every
 * required letter it lacks (the app's own list, from its inventory: Turkish,
 * English and the studio's planned languages), and the shortest line that
 * clips none of them -- measured the same way the app measures its own
 * (`loplop/tools/fonts/build.py` → `min_line`). A font that lacks a letter
 * is never put in play: the phone would draw that letter in the system font,
 * one word in two typefaces -- exactly what Fredoka did before "Fredoka TR".
 *
 *   admin   GET /fonts · POST /fonts · PATCH/DELETE /fonts/:id
 */
import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import opentype from "opentype.js";
import { z } from "zod";
import { all, one, run, tx } from "../storage/sql.js";
import { assetMap, blobPath, getAsset } from "../storage/files.js";
import { appAsset } from "../storage/builtin.js";
import { latestInventory, FONT_ROLES, type FontRole, type TypographyInventory } from "./inventory.js";
import { slug } from "./games.js";
import type { Issue } from "./checks.js";
import { nextStamp, staleFor } from "./vocab.js";

export interface FontReport {
  /** read from the file */
  family: string; style: string; postScript: string; weight: number; variable: boolean;
  glyphs: number; unitsPerEm: number;
  /** required letters the file does not have */
  missing: string[];
  /** the shortest line (em) that clips none of the required letters */
  minLine: number;
  /** the file could not be read as a font at all */
  error?: string;
}

interface FontRow {
  id: string; role: FontRole; name: string; note: string; license: string; asset: string | null;
  report: string; status: "live" | "draft" | "hidden"; created_at: number; updated_at: number;
}
export interface Font {
  id: string; role: FontRole; name: string; note: string; license: string; asset: string | null;
  report: FontReport | null; status: FontRow["status"]; createdAt: number; updatedAt: number;
}

const row = (id: string) => one<FontRow>("SELECT * FROM fonts WHERE id = ?", id);
const asFont = (r: FontRow): Font => {
  const rep = JSON.parse(r.report || "{}") as Partial<FontReport>;
  return { id: r.id, role: r.role, name: r.name, note: r.note, license: r.license, asset: r.asset,
           report: rep.family !== undefined || rep.error ? rep as FontReport : null,
           status: r.status, createdAt: r.created_at, updatedAt: r.updated_at };
};
export const loadFonts = async (): Promise<Font[]> =>
  (await all<FontRow>(`SELECT * FROM fonts ORDER BY role, created_at, id COLLATE "C"`)).map(asFont);
export const liveFonts = async (): Promise<Font[]> => (await loadFonts()).filter((f) => f.status === "live");

/* ── reading a file ───────────────────────────────────────────────────────── */

const reports = new Map<string, FontReport>();

/** what a font file is, by its bytes (cached by content hash) */
export async function readFont(asset: string | null | undefined, required: string): Promise<FontReport | null> {
  const a = asset ? await getAsset(asset) : undefined;
  if (!a) return null;
  const key = `${a.sha256}:${required}`;
  const hit = reports.get(key);
  if (hit) return hit;
  let rep: FontReport;
  if (a.kind !== "font") rep = blank("Bu dosya bir yazı tipi değil.");
  else {
    try {
      const buf = await readFile(blobPath(a.sha256, a.ext));
      rep = measure(opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)), required);
    } catch (e) { rep = blank(`Yazı tipi okunamadı: ${e instanceof Error ? e.message : String(e)}`); }
  }
  reports.set(key, rep);
  return rep;
}

const blank = (error: string): FontReport =>
  ({ family: "", style: "", postScript: "", weight: 0, variable: false, glyphs: 0, unitsPerEm: 0, missing: [], minLine: 0, error });

const nameOf = (n: Record<string, string> | undefined) => (n ? n.en ?? Object.values(n)[0] ?? "" : "");

/** the same measure as the app's own build (`tools/fonts/build.py` → min_line) */
export function measure(f: opentype.Font, required: string): FontReport {
  const t = f.tables as { os2?: { usWeightClass?: number }; hhea?: { ascender: number; descender: number }; fvar?: unknown };
  const upm = f.unitsPerEm || 1000;
  const chars = [...new Set([...required].filter((c) => c.trim()))];
  /* by the glyph index itself: opentype.js's `hasChar` counts a character the
     cmap does not list as present (its lookup answers undefined, not null) --
     the very Ğ/Ş this check exists for */
  const has = (c: string) => (f.charToGlyphIndex(c) ?? 0) > 0;
  const missing = chars.filter((c) => !has(c));
  let top = 0, bot = 0;
  for (const c of chars) {
    if (!has(c)) continue;
    const b = f.charToGlyph(c).getBoundingBox();
    if (!Number.isFinite(b.y1) || !Number.isFinite(b.y2) || (b.y1 === 0 && b.y2 === 0)) continue;
    top = Math.max(top, b.y2); bot = Math.min(bot, b.y1);
  }
  const asc = (t.hhea?.ascender ?? f.ascender) / upm, desc = -(t.hhea?.descender ?? f.descender) / upm;
  const natural = asc + desc;
  const even = natural - 2 * Math.min(asc - top / upm, desc + bot / upm);
  const minLine = Math.round((Math.max(top / upm + desc, even) + 0.02) * 100) / 100;
  const names = f.names as unknown as Record<string, Record<string, string>>;
  return {
    family: nameOf(names.preferredFamily) || nameOf(names.fontFamily),
    style: nameOf(names.preferredSubfamily) || nameOf(names.fontSubfamily),
    postScript: nameOf(names.postScriptName), weight: t.os2?.usWeightClass ?? 400, variable: !!t.fvar,
    glyphs: f.numGlyphs, unitsPerEm: upm, missing, minLine,
  };
}

/* ── the checks ───────────────────────────────────────────────────────────── */

/** what is wrong with a font, error by error -- a font with an error never plays */
export async function checkFont(x: Font, inv: TypographyInventory | undefined = latestInventory()?.typography): Promise<Issue[]> {
  const out: Issue[] = [];
  const err = (text: string) => out.push({ level: "error", text });
  const warn = (text: string) => out.push({ level: "warn", text });
  if (!inv) { err("Uygulamanın envanterinde yazı tipi sözleşmesi yok: önce uygulamanın yeni envanterini alın (npm run inventory)."); return out; }
  const role = inv.roles.find((r) => r.role === x.role);
  if (!role) { err(`"${x.role}" uygulamanın bir yazı rolü değil.`); return out; }
  if (!x.name.trim()) err("Bir ad verin (panelde ne olduğu anlaşılsın).");
  if (!x.asset) { err("Dosya yüklenmedi (TTF ya da OTF)."); return out; }
  const rep = await readFont(x.asset, inv.required);
  if (!rep) { err("Dosya bulunamadı."); return out; }
  if (rep.error) { err(rep.error); return out; }
  if (rep.missing.length)
    err(`${rep.missing.length} harf yok: ${rep.missing.slice(0, 30).join(" ")}${rep.missing.length > 30 ? " …" : ""}. `
      + "Eksik harfi telefon sistem fontuyla çizer, aynı kelimede iki font görünür: bu dosya kullanılamaz.");
  if (rep.variable)
    err("Değişken (variable) font: telefon ağırlığı güvenle seçemez. Bu rolün ağırlığındaki statik dosyayı yükleyin.");
  if (Math.abs(rep.weight - role.weight) > 100)
    err(`Dosyanın ağırlığı ${rep.weight}, bu rol ${role.weight} ister. Telefon kalınlığı taklit etmez: doğru ağırlığın dosyasını yükleyin.`);
  else if (rep.weight !== role.weight)
    warn(`Dosyanın ağırlığı ${rep.weight}; bu rol ${role.weight} ile çizilir. Fark küçük, kullanılabilir.`);
  if (rep.minLine > 1.6)
    warn(`Harfleri çok taşkın (en az satır ${rep.minLine} em): satırlar uygulamanın fontuna göre belirgin uzar, sıkışık düğmelerde yazı büyük görünür.`);
  if (!x.license.trim())
    err("Lisansı yazılmadı (ör. \"SIL OFL 1.1\" ya da satın alma bilgisi): lisansı bilinmeyen font uygulamaya konamaz.");
  return out;
}

/* ── what the panel reads ─────────────────────────────────────────────────── */

export async function fontsOut() {
  const inv = latestInventory()?.typography;
  const assets = await assetMap();
  const list = await Promise.all((await loadFonts()).map(async (x) => ({
    ...x, report: inv ? await readFont(x.asset, inv.required) : x.report, issues: await checkFont(x, inv),
  })));
  return {
    contract: inv ? { since: inv.since, required: inv.required } : null,
    roles: (inv?.roles ?? []).map((r) => ({
      role: r.role, weight: r.weight, label: r.label, use: r.use,
      builtin: { ...r.builtin, asset: assets.has(appAsset(`font-${r.role}`)) ? appAsset(`font-${r.role}`) : null },
    })),
    list,
  };
}

/* ── routes ───────────────────────────────────────────────────────────────── */

const Patch = z.object({
  name: z.string().trim().max(60).optional(), note: z.string().max(600).optional(),
  license: z.string().max(300).optional(),
  asset: z.string().max(80).nullable().optional(),
  status: z.enum(["live", "draft", "hidden"]).optional(),
});

export async function fontRoutes(app: FastifyInstance) {
  app.get("/fonts", async () => fontsOut());

  app.post("/fonts", (req, reply) => tx(async () => {
    const b = z.object({ role: z.enum(FONT_ROLES), name: z.string().trim().min(1).max(60),
                         asset: z.string().max(80).nullable().default(null) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "Rol ve ad gerekli" });
    if (b.data.asset && (await getAsset(b.data.asset))?.kind !== "font")
      return reply.code(400).send({ error: `"${b.data.asset}" bir yazı tipi dosyası değil.` });
    let id = slug(b.data.name) || "font";
    for (let n = 2; await row(id); n++) id = `${slug(b.data.name) || "font"}-${n}`;
    const now = Date.now();
    const inv = latestInventory()?.typography;
    const rep = inv && b.data.asset ? await readFont(b.data.asset, inv.required) : null;
    await run(`INSERT INTO fonts(id, role, name, asset, report, status, created_at, updated_at) VALUES(?, ?, ?, ?, ?, 'draft', ?, ?)`,
        id, b.data.role, b.data.name, b.data.asset, JSON.stringify(rep ?? {}), now, now);
    reply.code(201);
    return (await fontsOut()).list.find((x) => x.id === id);
  }));

  app.patch("/fonts/:id", (req, reply) => tx(async () => {
    const fid = (req.params as { id: string }).id;
    const r = await row(fid);
    if (!r) return reply.code(404).send({ error: "Yazı tipi yok" });
    const b = Patch.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: b.error.issues[0]?.message ?? "Geçersiz istek" });
    if (staleFor(req, r.updated_at)) return reply.code(409).send({ code: "STALE", error: "Bu yazı tipi başka bir yerde değişti." });
    const d = b.data;
    if (d.asset && (await getAsset(d.asset))?.kind !== "font")
      return reply.code(400).send({ error: `"${d.asset}" bir yazı tipi dosyası değil.` });
    const cur = asFont(r);
    const next: Font = { ...cur, name: d.name ?? cur.name, note: d.note ?? cur.note, license: d.license ?? cur.license,
                         asset: d.asset !== undefined ? d.asset : cur.asset, status: d.status ?? cur.status };
    if (next.status === "live") {
      const issues = await checkFont(next);
      if (issues.some((i) => i.level === "error"))
        return reply.code(400).send({ error: "Hatası olan yazı tipi uygulamaya konamaz.", issues });
    }
    const inv = latestInventory()?.typography;
    const rep = inv ? await readFont(next.asset, inv.required) : null;
    /* one font per role in play: putting this one in takes the other out --
       first, since the database holds the rule too (migration 5) */
    if (next.status === "live")
      for (const o of await all<{ id: string; updated_at: number }>("SELECT id, updated_at FROM fonts WHERE role = ? AND status = 'live' AND id != ?", r.role, fid))
        await run("UPDATE fonts SET status = 'draft', updated_at = ? WHERE id = ?", nextStamp(o.updated_at), o.id);
    await run(`UPDATE fonts SET name = ?, note = ?, license = ?, asset = ?, report = ?, status = ?, updated_at = ? WHERE id = ?`,
        next.name, next.note, next.license, next.asset, JSON.stringify(rep ?? {}), next.status, nextStamp(r.updated_at), fid);
    return (await fontsOut()).list.find((x) => x.id === fid);
  }));

  app.delete("/fonts/:id", (req, reply) => tx(async () => {
    const fid = (req.params as { id: string }).id;
    if (!(await row(fid))) return reply.code(404).send({ error: "Yazı tipi yok" });
    await run("DELETE FROM fonts WHERE id = ?", fid);
    return { ok: true };
  }));
}
