/**
 * API keys. The panel can set and remove them, and see WHETHER each is set
 * and where it came from -- never the value. A key leaves this server only
 * in a request to its own provider.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getSecret, setSecret, type SecretName } from "../storage/files.js";

const NAMES: SecretName[] = ["elevenlabs", "openai", "gemini", "anthropic", "suno"];
const Put = z.object({ name: z.enum(["elevenlabs", "openai", "gemini", "anthropic", "suno"]), value: z.string().max(400) });

export async function keyStatus() {
  const out: Record<string, { set: boolean; source: "panel" | "env" | null; hint: string | null }> = {};
  for (const n of NAMES) {
    const s = await getSecret(n);
    /* the last four characters, so you can tell which key it is */
    out[n] = { set: !!s, source: s?.source ?? null, hint: s ? `…${s.value.slice(-4)}` : null };
  }
  return out;
}

export async function settingsRoutes(app: FastifyInstance) {
  app.get("/settings/keys", async () => keyStatus());
  app.put("/settings/keys", async (req, reply) => {
    const b = Put.safeParse(req.body);
    if (!b.success) return reply.code(400).send({ error: "Geçersiz istek" });
    await setSecret(b.data.name, b.data.value.trim() || null);
    return keyStatus();
  });
}
