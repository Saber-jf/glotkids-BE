/**
 * The studio document's references to files: a fixed line's approved take
 * (in use: a release carries it), and the archive -- every take and every
 * generated picture, kept so a paid result is never lost. Read straight from
 * the stored document; `modules/content.ts` validates what is written there.
 */
import { one } from "./sql.js";
import type { Use } from "./files.js";

interface StudioRefs {
  lines?: { clip: string; approved?: string }[];
  takes?: { clip: string; asset: string }[];
  gens?: { asset: string; subject?: string }[];
  localeApproved?: Record<string, Record<string, { asset: string }>>;
  workshop?: { asset: string; name?: string }[];
}

export async function studioDoc(): Promise<StudioRefs | null> {
  const r = await one<{ data: string }>("SELECT data FROM documents WHERE name = 'studio'");
  if (!r) return null;
  try { return JSON.parse(r.data) as StudioRefs; } catch { return null; }
}

/** every file the document refers to, and how */
export function studioRefs(d: StudioRefs | null): Map<string, Use[]> {
  const out = new Map<string, Use[]>();
  const add = (id: string | undefined, u: Use) => { if (id) out.set(id, [...(out.get(id) ?? []), u]); };
  if (!d) return out;
  for (const l of Array.isArray(d.lines) ? d.lines : [])
    add(l.approved, { kind: "line-approved", ref: l.clip, text: `${l.clip} onaylı kaydı` });
  for (const t of Array.isArray(d.takes) ? d.takes : [])
    add(t.asset, { kind: "take", ref: t.clip, text: `${t.clip} denemesi`, archive: true });
  /* a take in use in another language: in use, like a fixed line's */
  if (d.localeApproved && typeof d.localeApproved === "object")
    for (const [code, lines] of Object.entries(d.localeApproved))
      for (const [clip, t] of Object.entries(lines ?? {}))
        add(t?.asset, { kind: "line-approved", ref: `${code}:${clip}`, text: `${code} · ${clip} onaylı kaydı` });
  for (const w of Array.isArray(d.workshop) ? d.workshop : [])
    add(w.asset, { kind: "take", ref: w.name ?? "", text: `ses atölyesi kaydı ${w.name ?? ""}`.trim(), archive: true });
  for (const g of Array.isArray(d.gens) ? d.gens : [])
    add(g.asset, { kind: "gen", ref: g.subject ?? "", text: "görsel stüdyosu üretimi", archive: true });
  return out;
}
