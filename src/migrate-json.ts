/**
 * ONE-TIME MOVE from the JSON files to the database (2026-10-16).
 *
 *   data/assets/<id>.<ext>  -> assets (same ids), bytes into blobs/ by hash
 *   data/db.json            -> the studio document (same revision); its word
 *                              sets -> the vocabulary (words, recordings, sets)
 *   data/games.json         -> games; a new game's own word copy becomes a set
 *   data/categories.json    -> categories; the same
 *
 * Runs once (`meta.migrated-json`), after the app's inventory is in, so the
 * app's own words and sets already exist and are reused rather than copied.
 * Nothing is deleted: the old files stay as a backup.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { meta, one, run, tx } from "./storage/sql.js";
import { getAsset, P, saveAsset } from "./storage/files.js";
import { readDocument, writeDocument } from "./modules/content.js";

interface OldWord { id: string; en: string; tr: string; about?: string; color?: string; icon?: string | null;
                    sounds?: Record<string, string> }

export async function migrateJson(log: (m: string) => void) {
  if (await meta.get("migrated-json")) return;
  const D = config.dataDir;
  const notes: string[] = [];

  /* files first: everything below refers to them by id */
  const names = new Map<string, string>();
  const dbFile = path.join(D, "db.json");
  const oldDb = existsSync(dbFile)
    ? (JSON.parse(await readFile(dbFile, "utf8")) as { rev: number; db: Record<string, unknown> }) : null;
  for (const a of (oldDb?.db.assets as { id: string; name: string }[] | undefined) ?? []) names.set(a.id, a.name);
  if (existsSync(P.legacyAssets)) {
    let n = 0;
    for (const f of await readdir(P.legacyAssets)) {
      const dot = f.lastIndexOf(".");
      if (dot < 1) continue;
      const id = f.slice(0, dot), ext = f.slice(dot + 1).toLowerCase();
      if (await getAsset(id)) continue;
      try { await saveAsset(id, ext, await readFile(path.join(P.legacyAssets, f)), names.get(id) ?? f); n++; }
      catch { /* a type the store does not take: left behind */ }
    }
    if (n) notes.push(`${n} dosya`);
  }

  const has = async (id: string | null | undefined) => (id && await getAsset(id) ? id : null);
  const now = Date.now();

  /* the studio document, as it was (its own transaction) */
  if (oldDb && !(await readDocument("studio"))) {
    await writeDocument("studio", oldDb.db, oldDb.rev);
    notes.push(`stüdyo belgesi (rev ${oldDb.rev})`);
  }

  await tx(async () => {
    /* a word: the app's own (or one already taken in) is reused as it is */
    const word = async (w: OldWord) => {
      if (await one("SELECT id FROM words WHERE id = ?", w.id)) return;
      await run(`INSERT INTO words(id, en, tr, about, kind, color, icon, builtin, created_at, updated_at)
           VALUES(?, ?, ?, ?, 'thing', ?, ?, 0, ?, ?)`,
          w.id, w.en, w.tr, w.about ?? "", /^#[0-9a-fA-F]{6}$/.test(w.color ?? "") ? w.color : "#6D3FC8",
          await has(w.icon), now, now);
    };
    const sounds = async (w: OldWord) => {
      for (const [slot, asset] of Object.entries(w.sounds ?? {}))
        if (await has(asset) && !(await one("SELECT word_id FROM word_audio WHERE word_id = ? AND slot = ?", w.id, slot)))
          await run("INSERT INTO word_audio(word_id, slot, asset, text, updated_at) VALUES(?, ?, ?, '', ?)", w.id, slot, asset, now);
    };
    const newSet = async (id: string, name: string, ws: OldWord[]) => {
      if (await one("SELECT id FROM sets WHERE id = ?", id)) return id;
      await run("INSERT INTO sets(id, name, note, builtin, created_at, updated_at) VALUES(?, ?, '', 0, ?, ?)", id, name, now, now);
      for (const [i, w] of ws.entries())
        await run("INSERT INTO set_words(set_id, word_id, pos) VALUES(?, ?, ?) ON CONFLICT DO NOTHING", id, w.id, i);
      return id;
    };

    /* the word sets the studio document used to hold */
    for (const s of (oldDb?.db.sets as { id: string; name: string; note?: string; words: OldWord[] }[] | undefined) ?? []) {
      for (const w of s.words) { await word(w); await sounds(w); }
      if (!(await one("SELECT id FROM sets WHERE id = ?", s.id))) {
        await newSet(s.id, s.name, s.words);
        await run("UPDATE sets SET note = ? WHERE id = ?", s.note ?? "", s.id);
      }
    }

    /* games: a built-in keeps what the panel set about it; a new one gets
       its words as a set of their own */
    const gFile = path.join(D, "games.json");
    if (existsSync(gFile)) {
      const games = JSON.parse(requireText(gFile)) as { id: string; template: string; builtin: boolean; name: string;
        subtitle: string; family: string; icon: string | null; words: OldWord[]; status: string; order: number }[];
      let n = 0;
      for (const g of games) {
        if (g.builtin) {
          await run("UPDATE games SET status = ?, ord = ? WHERE id = ? AND builtin = 1", g.status, g.order, g.id);
          continue;
        }
        if (await one("SELECT id FROM games WHERE id = ?", g.id)) continue;
        for (const w of g.words) await word(w);
        const set = g.words.length ? await newSet(`oyun-${g.id}`, `${g.name} kelimeleri`, g.words) : null;
        await run(`INSERT INTO games(id, template, builtin, name, subtitle, family, icon, set_id, config, status, ord, created_at, updated_at)
             VALUES(?, ?, 0, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?)`,
            g.id, g.template, g.name, g.subtitle, g.family ?? "", await has(g.icon), set, g.status, g.order, now, now);
        n++;
      }
      if (n) notes.push(`${n} yeni oyun`);
    }

    const cFile = path.join(D, "categories.json");
    if (existsSync(cFile)) {
      const cats = JSON.parse(requireText(cFile)) as { id: string; builtin: boolean; title: string; subtitle: string;
        icon: string | null; words: OldWord[]; steps: unknown[]; status: string; order: number }[];
      let n = 0;
      for (const c of cats) {
        if (c.builtin || await one("SELECT id FROM categories WHERE id = ?", c.id)) continue;
        for (const w of c.words) await word(w);
        const set = c.words.length ? await newSet(`kategori-${c.id}`, `${c.title} kelimeleri`, c.words) : null;
        await run(`INSERT INTO categories(id, builtin, title, subtitle, icon, set_id, steps, status, ord, created_at, updated_at)
             VALUES(?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            c.id, c.title, c.subtitle, await has(c.icon), set, JSON.stringify(c.steps), c.status, c.order, now, now);
        n++;
      }
      if (n) notes.push(`${n} yeni kategori`);
    }
    await meta.set("migrated-json", new Date().toISOString());
  });
  log(`eski JSON dosyalarından taşındı: ${notes.join(", ") || "taşınacak bir şey yoktu"}`);
}

/* read synchronously inside the transaction (a file, not the network) */
import { readFileSync } from "node:fs";
const requireText = (f: string) => readFileSync(f, "utf8");
