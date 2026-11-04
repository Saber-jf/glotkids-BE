/**
 * WHAT A PHONE READS. Public (no key) and read-only: only ever a published
 * release, never the draft the panel is editing.
 *
 *   GET /api/app/manifest?build=<n>&schema=<n>&channel=<test|production>
 *       the channel's release, cut to what that build can play
 *       (`releases.ts` → `forBuild`). ETag = release + build + that build's
 *       inventory fingerprint, so a phone that already has it gets 304.
 *   GET /api/app/catalog · GET /api/app/categories
 *       the shape builds before the manifest read (`core/remote.ts` before
 *       2026-10-16): the production release, for build 1, words inlined
 */
import type { FastifyInstance } from "fastify";
import { channelHead, CHANNELS, forBuild, releaseManifest, SCHEMA, type Manifest } from "./releases.js";
import { inventoryFor, inventoryHash } from "./inventory.js";

async function current(channel: string, build: number): Promise<Manifest | null> {
  const id = await channelHead(channel);
  const m = id ? await releaseManifest(id) : null;
  return m ? forBuild(m, build) : null;
}

export async function appRoutes(app: FastifyInstance) {
  app.get("/app/manifest", async (req, reply) => {
    const q = req.query as { build?: string; schema?: string; channel?: string };
    const build = Math.max(1, Number(q.build) || 1);
    const schema = Number(q.schema) || SCHEMA;
    const channel = (CHANNELS as readonly string[]).includes(q.channel ?? "") ? q.channel! : "production";
    if (schema !== SCHEMA) return reply.code(409).send({ error: `Bu sunucu içerik şeması ${SCHEMA} yazıyor; uygulama ${schema} okuyor.` });
    const m = await current(channel, build);
    if (!m) return reply.code(204).send();
    /* the answer depends on the release AND on what this build can play: if
       a build's inventory is ever taken in again with other engines, the
       body changes -- so does the tag (S11) */
    const tag = `"r${m.release}-b${build}-${inventoryHash(inventoryFor(build)) ?? "0"}"`;
    reply.header("ETag", tag).header("Cache-Control", "no-cache");
    if (req.headers["if-none-match"] === tag) return reply.code(304).send();
    return m;
  });

  /* ── the old shape, for builds that read it ── */
  const legacyWords = (m: Manifest, set: string) => {
    const ids = m.sets.find((s) => s.id === set)?.words ?? [];
    return ids.map((id) => m.words.find((w) => w.id === id)).filter((w) => !!w).map((w) => ({
      id: w!.id, en: w!.en, tr: w!.tr, about: w!.about, color: w!.color,
      icon: w!.icon && m.assets[w!.icon] ? m.assets[w!.icon]!.url : null,
    }));
  };
  const url = (m: Manifest, id: string | null) => (id && m.assets[id] ? m.assets[id]!.url : null);

  app.get("/app/catalog", async () => {
    const m = await current("production", 1);
    if (!m) return { games: [] };
    return { games: m.games.map((g) => ({
      id: g.id, template: g.template, builtin: false, name: g.name, subtitle: g.subtitle, icon: url(m, g.icon),
      kind: "game", takesWords: true, words: legacyWords(m, g.set),
    })) };
  });

  app.get("/app/categories", async () => {
    const m = await current("production", 1);
    if (!m) return { categories: [] };
    /* a pack's category is shown only after a grown-up agreed to download it:
       an old build that cannot ask never gets it */
    return { categories: m.categories.filter((c) => !c.pack).map((c) => ({
      id: c.id, title: c.title, subtitle: c.subtitle, icon: url(m, c.icon), words: legacyWords(m, c.set),
      steps: c.steps.map((s) => {
        if (s.kind === "video") return { ...s, video: url(m, s.video) };
        if (s.kind === "game") {
          const g = m.games.find((x) => x.id === s.game);
          const template = "template" in s ? s.template : g?.template;
          const name = "name" in s ? s.name : g?.name;
          return { id: s.id, kind: "game", game: s.game, template, name, teach: s.teach };
        }
        return s;
      }),
    })) };
  });
}
