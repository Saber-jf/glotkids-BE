/**
 * The server, built but not listening: `server.ts` starts it, the tests drive
 * it with `inject` (no port, no network). Everything the panel and the app
 * reach is registered here, in one place.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { statfsSync } from "node:fs";
import multipart from "@fastify/multipart";
import { config } from "./config.js";
import { contentRoutes } from "./modules/content.js";
import { assetRoutes, cdnRoutes } from "./modules/assets.js";
import { settingsRoutes, keyStatus } from "./modules/settings.js";
import { aiRoutes } from "./modules/ai.js";
import { gameRoutes } from "./modules/games.js";
import { categoryRoutes } from "./modules/categories.js";
import { roadmapRoutes } from "./modules/roadmap.js";
import { packRoutes } from "./modules/packs.js";
import { mascotRoutes } from "./modules/mascots.js";
import { songRoutes } from "./modules/songs.js";
import { fontRoutes } from "./modules/fonts.js";
import { paletteRoutes } from "./modules/palettes.js";
import { vocabRoutes } from "./modules/vocab.js";
import { inventoryRoutes, latestInventory, loadInventories } from "./modules/inventory.js";
import { releaseRoutes, channelsOut } from "./modules/releases.js";
import { appRoutes } from "./modules/app.js";
import { authRoutes, initMediaKey, installAuth, panelCaller, tokenOf } from "./modules/auth.js";
import { accountRoutes, seedAdmins } from "./modules/accounts.js";
import { accountsOn } from "./storage/supabase.js";
import { dbInfo, instanceId, one, openDb, requestScope } from "./storage/sql.js";

/** query parameters that carry a credential: never written to a log */
const SECRET_PARAMS = /([?&](?:k|m|token|key)=)[^&#]*/gi;
export const redactUrl = (url: string) => url.replace(SECRET_PARAMS, "$1[gizli]");

export async function buildApp(opts: { logStream?: NodeJS.WritableStream } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      ...(opts.logStream ? { stream: opts.logStream } : {}),
      /* the request line is logged without its credentials (S10): a media
         token in `?m=` is short-lived and read-only, but still not for logs;
         an Authorization header is never logged at all */
      serializers: {
        req: (req) => ({ method: req.method, url: redactUrl(req.url), host: req.host, remoteAddress: req.ip }),
      },
    },
    /* a whole studio document, or an image request with style examples inline */
    bodyLimit: 40 * 1024 * 1024,
  });

  /* the database is open and its tables current before the first request;
     what the app can play is read into memory once (`inventory.ts`) */
  await openDb();
  await loadInventories();
  /* the media tokens' key, and the first admins (ADMIN_EMAILS) */
  await initMediaKey();
  await seedAdmins((m) => console.error(m));
  /* every request reads with a memory of its own (`sql.ts` → `requestScope`) */
  app.addHook("onRequest", (_req, _reply, done) => requestScope(done));

  installAuth(app);
  await app.register(multipart, { limits: { fileSize: 300 * 1024 * 1024, files: 1 } });

  await app.register(async (api) => {
    api.get("/health", async (req, reply) => {
      const inv = latestInventory();
      /* disk: the database and every file live on it (decision 4) */
      let disk: { free: number; total: number; low: boolean } | null = null;
      try {
        const f = statfsSync(config.dataDir);
        const free = f.bavail * f.bsize, total = f.blocks * f.bsize;
        disk = { free, total, low: free < config.diskWarnBytes || free / total < 0.1 };
      } catch { /* not every system tells */ }
      if (disk?.low) reply.header("X-Loplop-Warning", "disk-low");
      /* the database answers, and how fast */
      const t0 = Date.now();
      let db: { ok: boolean; ms: number; error?: string };
      try { await one("SELECT 1 AS up"); db = { ok: true, ms: Date.now() - t0 }; }
      catch (e) { db = { ok: false, ms: Date.now() - t0, error: (e as Error).message }; }
      if (!db.ok) reply.header("X-Loplop-Warning", "database-down");
      const ok = !disk?.low && db.ok;
      /* public (a monitor, a phone): up or not, the disk and the database --
         nothing about the folder, the keys or the build is said to someone
         without the key */
      const c = await panelCaller(tokenOf(req)).catch(() => null);
      if (!c || typeof c === "string")
        return { ok, disk: disk ? { low: disk.low } : null, database: { ok: db.ok } };
      return {
        ok, dataDir: config.dataDir, disk, auth: !!config.adminToken || accountsOn(), accounts: accountsOn(), keys: await keyStatus(),
        database: { ...dbInfo(), ...db }, instance: db.ok ? await instanceId() : null,
        app: inv ? { build: inv.app.build, version: inv.app.version } : null,
        channels: db.ok ? Object.fromEntries((await channelsOut()).map((c) => [c.name, c.release])) : {},
      };
    });
    await api.register(authRoutes);
    await api.register(accountRoutes);
    await api.register(contentRoutes);
    await api.register(assetRoutes);
    await api.register(settingsRoutes);
    await api.register(aiRoutes);
    await api.register(vocabRoutes);
    await api.register(gameRoutes);
    await api.register(categoryRoutes);
    await api.register(roadmapRoutes);
    await api.register(packRoutes);
    await api.register(mascotRoutes);
    await api.register(songRoutes);
    await api.register(fontRoutes);
    await api.register(paletteRoutes);
    await api.register(inventoryRoutes);
    await api.register(releaseRoutes);
    await api.register(appRoutes);
  }, { prefix: "/api" });
  await app.register(cdnRoutes);
  return app;
}
