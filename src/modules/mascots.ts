/**
 * MASCOTS (the panel's "Maskotlar", 2026-10-17): who the child plays with,
 * as content.
 *
 * The app has two ROLES -- the `learner` (the one the child helps: the bunny
 * Lili, hungry, never speaks in a lesson) and the `friend` (the peer who
 * repeats the word and acts the verbs: the otter Kuki). A MASCOT fills a
 * role: a name, a BASE Lottie file with every behaviour the role plays under
 * its marker, and SETS -- more files of the same mascot (an emotions set:
 * "sevinme", "üzülme", "ağlama"; a walk set) whose markers are MAPPED onto
 * the behaviours, each with variants. A new bear is a new mascot; a new
 * cheer for Lili is a set and one line of the map. No app update either way.
 *
 * THE CONTRACT comes from the app (`app-inventory.json` → `mascots`, read off
 * its own files): a 512 box at 30 fps; every state the role plays; the walks
 * at their exact lengths; the scenes and the verbs at their exact frames (the
 * scene beats are frame numbers). The phone checks the same contract again
 * and keeps its own mascot for a file that fails -- never half of each.
 *
 * HOW THEY GET ABOUT -- on the map and in the scenes, `walk` (the hop) or
 * `stroll` (a walk, the feet in turn) -- is one setting, whoever they are.
 *
 *   admin   GET /mascots · POST /mascots · PATCH/DELETE /mascots/:id
 *           PUT /mascots/travel
 */
import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { all, meta, one, run, tx } from "../storage/sql.js";
import { assetMap, blobPath, getAsset } from "../storage/files.js";
import { appAsset } from "../storage/builtin.js";
import { latestInventory, type MascotInventory } from "./inventory.js";
import { readDocument } from "./content.js";
import { slug } from "./games.js";
import type { Issue } from "./checks.js";
import { nextStamp, staleFor } from "./vocab.js";

export type Role = "learner" | "friend";
export type Way = "walk" | "stroll";
export interface MascotSet { id: string; label: string; kind: string; asset: string | null }
export interface ClipRef { set: string; marker: string }
export interface Foot { x: number; y: number; top: number }

export interface MascotRow {
  id: string; role: Role; name: string; note: string; base: string | null; look: string | null;
  sets: string; map: string; walk_set: string | null; stroll_set: string | null; foot: string | null;
  report: string; status: "live" | "draft" | "hidden"; created_at: number; updated_at: number;
  voice: "keep" | "own";
}
export interface Mascot {
  id: string; role: Role; name: string; note: string; base: string | null; look: string | null;
  sets: MascotSet[]; map: Record<string, ClipRef[]>; walkSet: string | null; strollSet: string | null;
  foot: Foot | null; report: Record<string, unknown>; status: MascotRow["status"]; createdAt: number; updatedAt: number;
  /** "own": its own voice, so the app's bundled takes of its speaker are not played */
  voice: "keep" | "own";
}

const row = (id: string) => one<MascotRow>("SELECT * FROM mascots WHERE id = ?", id);
export const loadMascots = async (): Promise<Mascot[]> =>
  (await all<MascotRow>(`SELECT * FROM mascots ORDER BY role, created_at, id COLLATE "C"`)).map(asMascot);
const asMascot = (r: MascotRow): Mascot => ({
  id: r.id, role: r.role, name: r.name, note: r.note, base: r.base, look: r.look,
  sets: JSON.parse(r.sets), map: JSON.parse(r.map), walkSet: r.walk_set, strollSet: r.stroll_set,
  foot: r.foot ? JSON.parse(r.foot) : null, report: JSON.parse(r.report || "{}"), status: r.status,
  createdAt: r.created_at, updatedAt: r.updated_at, voice: r.voice === "own" ? "own" : "keep",
});

/* ── travel: one setting for the two of them ──────────────────────────────── */

const TRAVEL_KEY = "mascot-travel";
export async function travel(inv: MascotInventory | undefined = latestInventory()?.mascots): Promise<{ map: Way; scene: Way }> {
  const def = inv?.travel ?? { map: "stroll" as Way, scene: "walk" as Way };
  try { return { ...def, ...(JSON.parse((await meta.get(TRAVEL_KEY)) ?? "{}") as Partial<{ map: Way; scene: Way }>) }; }
  catch { return def; }
}

/* ── reading a Lottie on disk (by its bytes, so a changed name is re-read) ── */

type Doc = { w?: number; h?: number; fr?: number; ip?: number; op?: number; layers?: unknown;
             markers?: { cm: string; tm: number; dr: number }[] };
const docs = new Map<string, Doc | null>();
export async function docOf(asset: string | null | undefined): Promise<Doc | null> {
  const a = asset ? await getAsset(asset) : undefined;
  if (!a || a.kind !== "animation") return null;
  if (!docs.has(a.sha256)) {
    try { docs.set(a.sha256, JSON.parse(await readFile(blobPath(a.sha256, a.ext), "utf8")) as Doc); }
    catch { docs.set(a.sha256, null); }
  }
  return docs.get(a.sha256) ?? null;
}
/** `*` is a set file's whole timeline (a single animation needs no marker) */
export const WHOLE = "*";
const markersOf = (d: Doc | null) => {
  const out = new Map((d?.markers ?? []).map((m) => [m.cm, m]));
  const ip = typeof (d as { ip?: number } | null)?.ip === "number" ? (d as { ip: number }).ip : 0;
  if (d && typeof d.op === "number" && d.op > ip) out.set(WHOLE, { cm: WHOLE, tm: ip, dr: d.op - ip });
  return out;
};
/** a set's markers, for the panel's mapping lists */
export const markerList = (d: Doc | null) => [...markersOf(d).values()].map((m) => ({ name: m.cm, from: m.tm, to: m.tm + m.dr }));

/* ── the checks ───────────────────────────────────────────────────────────── */

const WALKS = ["walk_in_r", "walk_r", "walk_out_r", "walk_in_l", "walk_l", "walk_out_l"];
const STROLLS = WALKS.map((k) => k.replace("walk", "stroll"));
/** a name the lines can bend: letters (Turkish too), a space or a hyphen */
const NAME = /^[\p{L}][\p{L} -]{0,23}$/u;

/** what is wrong with a mascot, error by error -- the same contract the phone checks */
export async function checkMascot(m: Mascot, inv: MascotInventory | undefined = latestInventory()?.mascots): Promise<Issue[]> {
  const out: Issue[] = [];
  const err = (text: string) => out.push({ level: "error", text });
  const warn = (text: string) => out.push({ level: "warn", text });
  if (!inv) { err("Uygulamanın envanterinde maskot sözleşmesi yok: önce uygulamanın yeni envanterini alın (npm run inventory)."); return out; }
  const role = inv.roles.find((r) => r.role === m.role)!;
  const own = inv.builtin.find((b) => b.role === m.role);
  if (!NAME.test(m.name.trim())) err("Adı 1–24 harf olmalı (boşluk ve tire olabilir; kesme işareti uygulama ekler).");

  const lottie = (d: Doc | null, what: string): boolean => {
    if (!d) { err(`${what}: Lottie dosyası yok ya da okunamıyor.`); return false; }
    if (d.w !== inv.canvas || d.h !== inv.canvas) { err(`${what}: tuval ${d.w}×${d.h}, ${inv.canvas}×${inv.canvas} olmalı.`); return false; }
    if (d.fr !== inv.fr) { err(`${what}: kare hızı ${d.fr}, ${inv.fr} olmalı.`); return false; }
    return true;
  };
  const base = m.base ? await docOf(m.base) : null;
  if (!m.base) err("Ana dosya yüklenmedi.");
  else if (lottie(base, "Ana dosya")) {
    const ms = markersOf(base);
    const missing: string[] = [];
    for (const [k, r] of Object.entries(role.markers)) {
      const x = ms.get(k);
      if (!x) { missing.push(k); continue; }
      if (x.dr < 2) err(`Ana dosya: "${k}" çok kısa (${x.dr} kare).`);
      if (r.hold === "length" && x.dr !== r.to - r.from) err(`Ana dosya: "${k}" ${x.dr} kare, ${r.to - r.from} olmalı (yürüyüşün zamanlaması).`);
      if (r.hold === "frames" && (x.tm !== r.from || x.tm + x.dr !== r.to))
        err(`Ana dosya: "${k}" ${x.tm}–${x.tm + x.dr}, ${r.from}–${r.to} olmalı (sahne vuruşları bu karelere bağlı).`);
    }
    const need = role.minOp ?? 0;
    if ((base?.op ?? 0) < need) err(`Ana dosya ${base?.op} kare, en az ${need} olmalı: sahnelerin sessiz ikizleri (konuşma bitince kapalı ağız) ${need}. kareye kadar dosyanın sonunda.`);
    if (missing.length) err(`Ana dosyada ${missing.length} işaretçi yok: ${missing.slice(0, 12).join(", ")}${missing.length > 12 ? "…" : ""}.`);
  }
  const lookDoc = m.role === "learner" && m.look ? await docOf(m.look) : null;
  if (m.role === "learner" && m.look && lottie(lookDoc, "Bakış dosyası")) {
    const lop = lookDoc?.op ?? 0;
    if (inv.lookOp && lop < inv.lookOp) err(`Bakış dosyası ${lop} kare, en az ${inv.lookOp} olmalı (kare = bakış açısı).`);
  }
  if (m.role === "learner" && !m.look) warn("Bakış dosyası yok: derste Lili'nin merakla baktığı anlarda bu maskot nefes alarak bekler.");

  /* the sets and the map */
  const setDocs = new Map<string, Doc | null>();
  const ids = new Set<string>();
  for (const s of m.sets) {
    if (!s.id || s.id === "base" || ids.has(s.id)) err(`Set kimliği "${s.id}" geçersiz ya da tekrar ediyor.`);
    ids.add(s.id);
    const d = s.asset ? await docOf(s.asset) : null;
    if (!s.asset) err(`"${s.label || s.id}" setinin dosyası yok.`);
    else if (lottie(d, `"${s.label || s.id}" seti`)) setDocs.set(s.id, d);
  }
  const docFor = (set: string) => (set === "base" ? base : setDocs.get(set) ?? null);
  const labelOf = (set: string) => (set === "base" ? "ana dosya" : `"${m.sets.find((s) => s.id === set)?.label || set}" seti`);
  for (const [key, refs] of Object.entries(m.map)) {
    const b = role.behaviours.find((x) => x.key === key);
    if (!b) { err(`"${key}" bu rolün bir davranışı değil.`); continue; }
    if (!b.mappable) { err(`"${b.label}" başka bir sete eşlenemez (kareleri sözleşmede sabit).`); continue; }
    if (!refs.length) continue;
    for (const r of refs) {
      if (r.set !== "base" && !ids.has(r.set)) { err(`"${b.label}": "${r.set}" seti yok.`); continue; }
      const d = docFor(r.set);
      if (d && !markersOf(d).has(r.marker)) err(`"${b.label}": ${labelOf(r.set)} içinde "${r.marker}" işaretçisi yok.`);
    }
  }
  for (const [set, names, what] of [[m.walkSet, WALKS, "Sekme"], [m.strollSet, STROLLS, "Yürüme"]] as const) {
    if (!set) continue;
    if (!ids.has(set)) { err(`${what} seti "${set}" yok.`); continue; }
    const ms = markersOf(docFor(set));
    for (const k of names) {
      const x = ms.get(k), r = role.markers[k];
      if (!x) err(`${what} seti: "${k}" işaretçisi yok.`);
      else if (r && x.dr !== r.to - r.from) err(`${what} seti: "${k}" ${x.dr} kare, ${r.to - r.from} olmalı.`);
    }
  }

  /* where it stands, and how much the screens will notice it is new */
  const f = m.foot;
  const unit = (v: number) => Number.isFinite(v) && v > 0 && v < 1;
  if (!f) warn("Ayakları ölçülmedi: haritada uygulamanın kendi maskotunun ölçüsüyle durur. Panelde \"Ölç\" ile ölçün.");
  else if (!unit(f.x) || !unit(f.y) || !unit(f.top) || f.top >= f.y) err("Ayak ölçüsü geçersiz.");
  else if (own && (Math.abs(f.y - own.foot.y) > 0.06 || Math.abs((f.y - f.top) - (own.foot.y - own.foot.top)) > 0.12))
    warn(`Duruşu uygulamanınkinden çok farklı (ayak ${(f.y * 512).toFixed(0)} px, boy ${((f.y - f.top) * 512).toFixed(0)} px; `
      + `${own.name}: ${(own.foot.y * 512).toFixed(0)} / ${((own.foot.y - own.foot.top) * 512).toFixed(0)}). `
      + "Sahneler ve oyunlar maskotun yerini kendi ölçüleriyle ayırdı: aynı 512 kutuda, aynı zemin çizgisinde çizin.");

  if (m.voice === "own")
    warn(`Kendi sesi: uygulamadaki ${own?.name ?? "maskotun"} sesiyle yapılmış bütün kayıtlar bu maskotla çalınmaz; Ses stüdyosunda bu maskotun sesiyle yeniden kaydedilip yayınlanana kadar cihaz sesi okur.`);

  /* the name: every line that says it */
  if (own && m.name.trim() && m.name.trim() !== own.name) {
    const lines = inv.namedLines.filter((l) => l.roles.includes(m.role));
    warn(`Adı "${own.name}" değil "${m.name.trim()}": uygulamada ${lines.length} satır bu adı söylüyor. `
      + `Uygulamadaki "${own.name}" diyen kayıtlar bu maskotla çalınmaz: bu cümleler cihaz sesiyle yeni adla okunur `
      + "ya da Ses stüdyosunda yeni adla kaydedilip yayınlanır.");
    const studio = (await readDocument("studio"))?.data as { lines?: { clip: string; text: string }[] } | undefined;
    const old = (studio?.lines ?? []).filter((l) => saysName(l.text, own.name));
    if (old.length) warn(`Ses stüdyosunda ${old.length} sabit satır hâlâ "${own.name}" diyor (${old.slice(0, 4).map((l) => l.clip).join(", ")}${old.length > 4 ? "…" : ""}). `
      + "Bunlar bu maskot yayındayken yayına girmez; panelde \"Satırlardaki adı değiştir\" ile güncelleyin.");
  }
  return out;
}

/** does this text say this name (as a word, with or without a suffix) */
export const saysName = (text: string, name: string) =>
  new RegExp(`(^|[^\\p{L}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}('|[^\\p{L}]|$)`, "u").test(text);

/** the live mascot of each role (at most one), with its checks */
export const liveMascots = async (): Promise<Mascot[]> => (await loadMascots()).filter((m) => m.status === "live");

export async function mascotsOut() {
  const inv = latestInventory()?.mascots;
  const assets = await assetMap();
  const has = (id: string) => assets.has(id);
  const list = await Promise.all((await loadMascots()).map(async (m) => {
    const files: Record<string, ReturnType<typeof markerList>> = {};
    for (const [k, a] of [["base", m.base], ...m.sets.map((s) => [s.id, s.asset] as const)] as const) files[k] = markerList(await docOf(a));
    return { ...m, issues: await checkMascot(m, inv), files };
  }));
  return {
    contract: inv ? { canvas: inv.canvas, fr: inv.fr, since: inv.since, lookOp: inv.lookOp ?? null } : null,
    travel: await travel(inv),
    roles: (inv?.roles ?? []).map((r) => {
      const own = inv!.builtin.find((b) => b.role === r.role);
      return {
        role: r.role, slot: r.slot, markers: r.markers, behaviours: r.behaviours,
        builtin: own ? { name: own.name, base: has(appAsset(`mascot-${r.role}`)) ? appAsset(`mascot-${r.role}`) : null,
                         look: own.look && has(appAsset(`mascot-${r.role}-look`)) ? appAsset(`mascot-${r.role}-look`) : null,
                         foot: own.foot } : null,
        namedLines: inv!.namedLines.filter((l) => l.roles.includes(r.role)),
      };
    }),
    forms: inv?.forms ?? [],
    /* with the markers each file carries, for the mapping lists */
    list,
  };
}

/* ── routes ───────────────────────────────────────────────────────────────── */

const Ref = z.object({ set: z.string().max(40), marker: z.string().min(1).max(60) });
const Patch = z.object({
  name: z.string().trim().min(1).max(24).optional(), note: z.string().max(600).optional(),
  base: z.string().max(80).nullable().optional(), look: z.string().max(80).nullable().optional(),
  sets: z.array(z.object({ id: z.string().regex(/^[a-z0-9-]{1,40}$/), label: z.string().max(40), kind: z.string().max(20),
                           asset: z.string().max(80).nullable() })).max(20).optional(),
  map: z.record(z.string().max(40), z.array(Ref).max(6)).optional(),
  walkSet: z.string().max(40).nullable().optional(), strollSet: z.string().max(40).nullable().optional(),
  foot: z.object({ x: z.number(), y: z.number(), top: z.number() }).nullable().optional(),
  report: z.record(z.string(), z.unknown()).optional(),
  status: z.enum(["live", "draft", "hidden"]).optional(),
  voice: z.enum(["keep", "own"]).optional(),
});

export async function mascotRoutes(app: FastifyInstance) {
  app.get("/mascots", async () => mascotsOut());

  app.post("/mascots", (req, reply) => tx(async () => {
    const b = z.object({ role: z.enum(["learner", "friend"]), name: z.string().trim().min(1).max(24),
                         from: z.enum(["builtin", "empty"]).default("empty") }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "Rol ve ad gerekli" });
    let id = slug(b.data.name);
    for (let n = 2; await row(id); n++) id = `${slug(b.data.name)}-${n}`;
    const now = Date.now();
    /* "builtin": start from the app's own file -- a new name, or a set to add */
    const base = b.data.from === "builtin" && await getAsset(appAsset(`mascot-${b.data.role}`)) ? appAsset(`mascot-${b.data.role}`) : null;
    const look = b.data.from === "builtin" && b.data.role === "learner" && await getAsset(appAsset("mascot-learner-look")) ? appAsset("mascot-learner-look") : null;
    const own = latestInventory()?.mascots?.builtin.find((x) => x.role === b.data.role);
    await run(`INSERT INTO mascots(id, role, name, base, look, foot, status, created_at, updated_at)
         VALUES(?, ?, ?, ?, ?, ?, 'draft', ?, ?)`, id, b.data.role, b.data.name, base, look,
        base && own ? JSON.stringify(own.foot) : null, now, now);
    reply.code(201);
    return (await mascotsOut()).list.find((m) => m.id === id);
  }));

  app.patch("/mascots/:id", (req, reply) => tx(async () => {
    const mid = (req.params as { id: string }).id;
    const r = await row(mid);
    if (!r) return reply.code(404).send({ error: "Maskot yok" });
    const b = Patch.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: b.error.issues[0]?.message ?? "Geçersiz istek" });
    if (staleFor(req, r.updated_at)) return reply.code(409).send({ code: "STALE", error: "Bu maskot başka bir yerde değişti." });
    const d = b.data;
    for (const a of [d.base, d.look, ...(d.sets ?? []).map((s) => s.asset)])
      if (a && (await getAsset(a))?.kind !== "animation") return reply.code(400).send({ error: `"${a}" bir Lottie animasyonu değil.` });
    const cur = asMascot(r);
    const next: Mascot = {
      ...cur, name: d.name ?? cur.name, note: d.note ?? cur.note,
      base: d.base !== undefined ? d.base : cur.base, look: d.look !== undefined ? d.look : cur.look,
      sets: d.sets ?? cur.sets, map: d.map ?? cur.map,
      walkSet: d.walkSet !== undefined ? d.walkSet : cur.walkSet, strollSet: d.strollSet !== undefined ? d.strollSet : cur.strollSet,
      foot: d.foot !== undefined ? d.foot : cur.foot, report: d.report ?? cur.report, status: d.status ?? cur.status,
      voice: d.voice ?? cur.voice,
    };
    /* a set taken away takes its lines of the map with it */
    const ids = new Set(["base", ...next.sets.map((s) => s.id)]);
    next.map = Object.fromEntries(Object.entries(next.map).map(([k, v]) => [k, v.filter((x) => ids.has(x.set))]).filter(([, v]) => (v ?? []).length));
    if (next.walkSet && !ids.has(next.walkSet)) next.walkSet = null;
    if (next.strollSet && !ids.has(next.strollSet)) next.strollSet = null;
    if (next.status === "live") {
      const issues = await checkMascot(next);
      if (issues.some((i) => i.level === "error"))
        return reply.code(400).send({ error: "Hatası olan maskot uygulamaya konamaz.", issues });
    }
    /* one live mascot per role: putting this one in play takes the other out
       -- first, since the database holds the rule too (migration 3) */
    if (next.status === "live")
      for (const o of await all<{ id: string; updated_at: number }>("SELECT id, updated_at FROM mascots WHERE role = ? AND status = 'live' AND id != ?", r.role, mid))
        await run("UPDATE mascots SET status = 'draft', updated_at = ? WHERE id = ?", nextStamp(o.updated_at), o.id);
    await run(`UPDATE mascots SET name = ?, note = ?, base = ?, look = ?, sets = ?, map = ?, walk_set = ?, stroll_set = ?,
           foot = ?, report = ?, status = ?, voice = ?, updated_at = ? WHERE id = ?`,
        next.name, next.note, next.base, next.look, JSON.stringify(next.sets), JSON.stringify(next.map),
        next.walkSet, next.strollSet, next.foot ? JSON.stringify(next.foot) : null, JSON.stringify(next.report),
        next.status, next.voice, nextStamp(r.updated_at), mid);
    return (await mascotsOut()).list.find((m) => m.id === mid);
  }));

  app.delete("/mascots/:id", (req, reply) => tx(async () => {
    const mid = (req.params as { id: string }).id;
    if (!(await row(mid))) return reply.code(404).send({ error: "Maskot yok" });
    await run("DELETE FROM mascots WHERE id = ?", mid);
    return { ok: true };
  }));

  app.put("/mascots/travel", async (req, reply) => {
    const b = z.object({ map: z.enum(["walk", "stroll"]), scene: z.enum(["walk", "stroll"]) }).safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "Yürüyüş: walk ya da stroll" });
    await meta.set(TRAVEL_KEY, JSON.stringify(b.data));
    return travel();
  });
}
