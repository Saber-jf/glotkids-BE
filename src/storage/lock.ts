/**
 * ONE SERVER PROCESS PER DATA FOLDER (decision 2026-10-16, items 4 and 7).
 *
 * The collector's lock (`files.ts` → `withBlobLock`) only orders work inside
 * one process. Two processes on the same folder -- an old and a new server
 * overlapping during a deploy, a second instance started by hand -- could
 * still race an upload against a deletion. Until uploads, references and
 * deletions are coordinated across processes, the rule is simply: one
 * process. This file enforces it at start: `server.lock` names the process
 * holding the folder; a second one refuses to start. A lock whose process is
 * gone (a crash) is taken over.
 */
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

export class FolderInUse extends Error {}

/**
 * A restore that has not finished (`tools/restore.ts`): the folder holds part
 * of a backup. A server never starts on it -- it would fill the empty database
 * with its own rows and the restore could not be finished.
 */
export const RESTORE_MARK = ".restore-incomplete.json";

interface Holder { pid: number; host: string; startedAt: string }

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
};

/** take the folder for this process, or throw `FolderInUse` */
export function holdDataFolder(dir: string): () => void {
  const file = path.join(dir, "server.lock");
  const me: Holder = { pid: process.pid, host: hostname(), startedAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx");
      writeSync(fd, JSON.stringify(me));
      closeSync(fd);
      const release = () => {
        try { if ((JSON.parse(readFileSync(file, "utf8")) as Holder).pid === process.pid) unlinkSync(file); } catch { /* gone */ }
      };
      process.once("exit", release);
      for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => { release(); process.exit(0); });
      return release;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let h: Holder | null = null;
      try { h = JSON.parse(readFileSync(file, "utf8")) as Holder; } catch { /* unreadable: treat as stale */ }
      if (h && h.host !== me.host)
        throw new FolderInUse(`Veri klasörü başka bir makinedeki süreçte (${h.host}, pid ${h.pid}). Aynı klasörü iki sunucu kullanamaz.`);
      if (h && h.pid !== process.pid && alive(h.pid))
        throw new FolderInUse(`Veri klasörünü başka bir sunucu süreci kullanıyor (pid ${h.pid}, ${h.startedAt}). Önce onu durdurun.`);
      try { unlinkSync(file); } catch { /* raced: try again */ }
    }
  }
  throw new FolderInUse("Veri klasörünün kilidi alınamadı.");
}
