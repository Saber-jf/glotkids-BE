/**
 * Files: icons, backgrounds, recordings, music, videos. An upload returns the
 * asset's metadata in the shape the panel keeps, with a `url` it can show.
 * The bytes are stored under their content hash (`storage/files.ts`).
 *
 *   admin   GET /assets · GET /assets/usage · GET /assets/:id/usage
 *           POST /assets[?id=] · DELETE /assets/:id[?archive=drop] · POST /assets/gc
 *   both    GET /api/assets/:id   (by name -- the panel, and old app builds)
 *   app     GET /cdn/<sha>.<ext>  (by content -- immutable, cache forever)
 *
 * DELETING A NAME (S06): the server decides, from every reference there is
 * (`assetUsage`): a file a word, game, category or approved line uses is
 * refused with 409 `ASSET_IN_USE` and the list; one only the studio's archive
 * keeps (a take, a generated picture) is refused with `ASSET_ARCHIVED` unless
 * the caller says so (`?archive=drop` -- the panel does when it is deleting
 * that very archive record). Bytes a release was published with stay either
 * way (`gc`).
 *
 * Every file is served with `nosniff` and a sandboxing CSP: an SVG opened on
 * its own runs no script and cannot reach the panel's storage (S10).
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";
import { assetUsage, usageIndex, extFor, FileTypeError, findAsset, gc, kindOf, listAssets, metaOf, mimeFor, openAsset, removeAsset, safeId,
         saveAsset, blobPath, safeSha, type AssetMeta } from "../storage/files.js";
import { existsSync, statSync } from "node:fs";
import { tx } from "../storage/sql.js";

export const newId = (kind: string) => `${kind}-${randomUUID().slice(0, 12)}`;

/** store bytes the server made itself (a generated recording or picture);
 *  the extension follows the type the provider actually returned */
export async function storeBuffer(buf: Buffer, name: string, mime: string): Promise<AssetMeta> {
  const kind = kindOf(mime) ?? "image";
  const byType = extFor("", mime);
  const ext = byType === "bin" ? extFor(name, mime) : byType;
  return saveAsset(newId(kind), ext, buf, `${name.replace(/\.[a-z0-9]{2,4}$/i, "")}.${ext}`, mime);
}

/** what every file response carries */
export function fileHeaders(reply: FastifyReply, ext: string, size: number) {
  return reply.type(mimeFor(ext)).header("Content-Length", size)
    .header("X-Content-Type-Options", "nosniff")
    .header("Content-Security-Policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
}

export async function assetRoutes(app: FastifyInstance) {
  app.get("/assets", async () => (await listAssets()).map(metaOf));

  /* who uses what: one answer for every screen of the panel */
  app.get("/assets/usage", async () => {
    const [list, uses] = await Promise.all([listAssets(), usageIndex()]);
    return Object.fromEntries(list.map((a) => [a.id, uses.get(a.id) ?? []]));
  });
  app.get("/assets/:id/usage", async (req) => assetUsage((req.params as { id: string }).id));

  /* ?id= lets the panel keep the id it already uses (moving files it held) */
  app.post("/assets", async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "Dosya yok" });
    const kind = kindOf(file.mimetype);
    if (!kind) return reply.code(415).send({ error: `Desteklenmeyen tür: ${file.mimetype}` });
    const asked = (req.query as { id?: string }).id;
    if (asked && !safeId(asked)) return reply.code(400).send({ error: "Geçersiz kimlik" });
    const id = asked ?? newId(kind);
    try {
      const meta = await saveAsset(id, extFor(file.filename, file.mimetype), file.file, file.filename, file.mimetype);
      if (file.file.truncated) { await removeAsset(id); return reply.code(413).send({ error: "Dosya çok büyük" }); }
      return meta;
    } catch (e) {
      if (e instanceof FileTypeError) return reply.code(415).send({ error: e.message, code: "FILE_TYPE" });
      throw e;
    }
  });

  app.get("/assets/:id", async (req, reply) => {
    const a = await findAsset((req.params as { id: string }).id);
    if (!a) return reply.code(404).send({ error: "Yok" });
    /* a name can be given new bytes: always revalidate (the ETag is the
       content hash, so an unchanged file costs a 304) */
    const tag = `"${a.sha}"`;
    if (req.headers["if-none-match"] === tag) {
      fileHeaders(reply, a.ext, a.size).header("ETag", tag).header("Cache-Control", "private, no-cache");
      return reply.code(304).send();
    }
    /* a part of the file (a <video> seeking -- Safari will not play one
       without it): one range, "bytes=start-end" or "bytes=start-" */
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, a.size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), a.size - 1) : a.size - 1;
      if (start >= a.size || start > end)
        return reply.code(416).header("Content-Range", `bytes */${a.size}`).send();
      fileHeaders(reply, a.ext, end - start + 1).header("ETag", tag).header("Cache-Control", "private, no-cache")
        .header("Accept-Ranges", "bytes").header("Content-Range", `bytes ${start}-${end}/${a.size}`);
      return reply.code(206).send(openAsset(a.file, start, end));
    }
    fileHeaders(reply, a.ext, a.size).header("ETag", tag).header("Cache-Control", "private, no-cache").header("Accept-Ranges", "bytes");
    return reply.send(openAsset(a.file));
  });

  /* one transaction: nothing starts using it between the look and the delete */
  app.delete("/assets/:id", (req, reply) => tx(async () => {
    const id = (req.params as { id: string }).id;
    const uses = await assetUsage(id);
    const live = uses.filter((u) => !u.archive);
    if (live.length)
      return reply.code(409).send({ code: "ASSET_IN_USE", error: `Bu dosya kullanılıyor: ${live.map((u) => u.text).join(", ")}`, usage: uses });
    if (uses.length && (req.query as { archive?: string }).archive !== "drop")
      return reply.code(409).send({ code: "ASSET_ARCHIVED", error: `Bu dosya arşivde duruyor: ${uses.map((u) => u.text).join(", ")}`, usage: uses });
    await removeAsset(id);
    return { ok: true };
  }));

  /* bytes no name and no release refers to any more */
  app.post("/assets/gc", async () => gc());
}

/** the content-addressed files a phone downloads: public, immutable */
export async function cdnRoutes(app: FastifyInstance) {
  app.get("/cdn/:file", async (req, reply) => {
    const f = (req.params as { file: string }).file;
    const [sha, ext] = f.split(".");
    if (!sha || !ext || !safeSha(sha) || !/^[a-z0-9]{2,4}$/.test(ext)) return reply.code(404).send({ error: "Yok" });
    const file = blobPath(sha, ext);
    if (!existsSync(file)) return reply.code(404).send({ error: "Yok" });
    return fileHeaders(reply, ext, statSync(file).size)
      .header("Cache-Control", "public, max-age=31536000, immutable").send(openAsset(file));
  });
}
