/**
 * PAID JOBS (S08). A generation the panel asks for -- a voice line, a batch of
 * pictures -- is a job with the panel's own id. Each result is stored the
 * moment the provider returns it and written to the job at once, so a later
 * failure in the same batch, a dropped connection or a closed tab never loses
 * what was already paid for.
 *
 * The id makes the request idempotent ON THIS SERVER: the same id again never
 * calls the provider a second time -- a finished job answers with what it
 * made, a running one says so. Only a job the provider REFUSED with nothing
 * made may be run again under its id.
 *
 * What this does NOT promise: the providers used here have no idempotency
 * key and no way to look a request up. A request that was sent and then lost
 * -- a timeout, a dropped connection, this server stopping half way -- may
 * have been carried out and charged. Such a job is UNCERTAIN: it is shown as
 * such, never sent again on its own, and only a person decides to make a new
 * one (decision 3, 2026-10-16).
 *
 *   admin   GET /ai/jobs · GET /ai/jobs/:id
 */
import type { FastifyInstance } from "fastify";
import { all, one, run, tx } from "../storage/sql.js";
import type { AssetMeta } from "../storage/files.js";

export type JobStatus = "running" | "done" | "partial" | "failed" | "uncertain";
export interface Job {
  id: string; kind: string; status: JobStatus; assets: AssetMeta[]; errors: string[];
  createdAt: number; updatedAt: number;
}
interface JobRow { id: string; kind: string; status: JobStatus; request: string; assets: string; errors: string;
                   created_at: number; updated_at: number }

export const jobIdOk = (id: string) => /^[a-zA-Z0-9_-]{8,80}$/.test(id);

const out = (r: JobRow): Job => ({ id: r.id, kind: r.kind, status: r.status, assets: JSON.parse(r.assets),
                                   errors: JSON.parse(r.errors), createdAt: r.created_at, updatedAt: r.updated_at });

export async function getJob(id: string): Promise<Job | null> {
  const r = await one<JobRow>("SELECT * FROM jobs WHERE id = ?", id);
  return r ? out(r) : null;
}

/**
 * Open a job, or find it. `fresh` is true when the caller should call the
 * provider; false means answer with `job` as it is. One transaction: two
 * requests with the same id at once open it once -- the second finds it running.
 */
export function openJob(id: string, kind: string, request: unknown): Promise<{ fresh: boolean; job: Job }> {
  return tx(async () => {
    const cur = await getJob(id);
    if (cur && !(cur.status === "failed" && cur.assets.length === 0)) return { fresh: false, job: cur };
    const now = Date.now();
    await run(`INSERT INTO jobs(id, kind, status, request, assets, errors, created_at, updated_at)
         VALUES(?, ?, 'running', ?, '[]', '[]', ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = 'running', errors = '[]', updated_at = excluded.updated_at`,
        id, kind, JSON.stringify(request).slice(0, 20000), now, now);
    return { fresh: true, job: (await getJob(id))! };
  });
}

/** a result is stored: on the job at once */
export function jobAsset(id: string, a: AssetMeta): Promise<void> {
  return tx(async () => {
    const j = (await getJob(id))!;
    await run("UPDATE jobs SET assets = ?, updated_at = ? WHERE id = ?", JSON.stringify([...j.assets, a]), Date.now(), id);
  });
}

/** `uncertain`: the last request may have reached the provider without an answer coming back */
export function endJob(id: string, errors: string[], uncertain = false): Promise<Job> {
  return tx(async () => {
    const j = (await getJob(id))!;
    const status: JobStatus = errors.length === 0 ? "done" : j.assets.length ? "partial" : uncertain ? "uncertain" : "failed";
    if (uncertain) errors = [...errors, "Sağlayıcı isteği almış ve ücretlendirmiş olabilir; sonucu bilinmiyor. Otomatik olarak yeniden gönderilmez."];
    await run("UPDATE jobs SET status = ?, errors = ?, updated_at = ? WHERE id = ?", status, JSON.stringify(errors), Date.now(), id);
    return (await getJob(id))!;
  });
}

/** at start: a job still marked running belonged to a process that stopped -- its cost is unknown */
export async function markInterruptedJobs(): Promise<number> {
  const r = await run(`UPDATE jobs SET status = 'uncertain', updated_at = ?,
                   errors = '["Sunucu bu iş sürerken durdu; sağlayıcı isteği tamamlamış ve ücretlendirmiş olabilir."]'
                 WHERE status = 'running'`, Date.now());
  return r.changes;
}

export async function jobRoutes(app: FastifyInstance) {
  app.get("/ai/jobs", async () =>
    (await all<JobRow>("SELECT * FROM jobs ORDER BY created_at DESC, id LIMIT 300")).map(out));
  app.get("/ai/jobs/:id", async (req, reply) =>
    (await getJob((req.params as { id: string }).id)) ?? reply.code(404).send({ error: "İş yok", code: "JOB_UNKNOWN" }));
}
