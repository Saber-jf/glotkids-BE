/**
 * THE APP'S OWN PICTURES, in the asset store, so the panel can show them and a
 * release can point at them.
 *
 *   builtin/game-<id>.png   the menu cards' art, cut from the app on the
 *                           simulator (2026-10-13)
 *   builtin/word-<id>.png   word pictures the app draws as vectors (animals)
 *   <APP_DIR>/src/assets/…  word pictures the app ships as PNGs -- named by
 *                           `app-inventory.json`, copied from the app itself
 *
 * Each is installed as asset `app-<file name>` (`app-game-drag`,
 * `app-word-banana`) and replaced when its bytes change.
 */
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAsset, saveAsset } from "./files.js";
import { createHash } from "node:crypto";

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../builtin");

export const appAsset = (name: string) => `app-${name}`;

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** install one file as an `app-…` asset if it is new or changed */
export async function installFile(id: string, file: string): Promise<boolean> {
  if (!existsSync(file)) return false;
  const buf = await readFile(file);
  const have = await getAsset(id);
  if (have && have.sha256 === sha(buf)) return false;
  await saveAsset(id, path.extname(file).slice(1).toLowerCase(), buf, path.basename(file));
  return true;
}

export async function installBuiltins(): Promise<number> {
  let names: string[];
  try { names = (await readdir(DIR)).filter((f) => f.endsWith(".png")); }
  catch { return 0; }
  let n = 0;
  for (const f of names) if (await installFile(appAsset(f.slice(0, -4)), path.join(DIR, f))) n++;
  return n;
}
