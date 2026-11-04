/**
 * THE TESTS' DATABASE, checked before any server starts and before anything
 * is written -- the migrations included (2026-10-19). Until then the unit
 * tests opened TEST_DATABASE_URL (running the migrations into it) and only
 * THEN asked whether it was empty, and the end-to-end test handed it to a
 * server without asking at all.
 *
 *   no TEST_DATABASE_URL   an embedded Postgres in the test's own folder
 *   TEST_DATABASE_URL=…    a Postgres kept for tests; it must be
 *                            - on this machine (127.0.0.1 / localhost / ::1),
 *                            - a database whose name says so ("test" in it),
 *                            - not the server's own (DATABASE_URL in the
 *                              shell or in .env, compared host:port/name);
 *                          and then the tests do not write into IT either: a
 *                          NEW database is made on that server for the run
 *                          (`<name>_<random>`, CREATEDB needed) and dropped at
 *                          the end.
 *
 * Call it before setting DATABASE_URL for the test: it reads the real one.
 */
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";

const LOCAL = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const where = (u: URL) => `${LOCAL.has(u.hostname) ? "127.0.0.1" : u.hostname}:${u.port || "5432"}${decodeURIComponent(u.pathname)}`;

/** the server's own database, as the shell or `.env` names it (never written by a test) */
function realUrls(): string[] {
  const out = [process.env.DATABASE_URL ?? ""];
  if (existsSync(".env")) out.push(parseEnv(readFileSync(".env", "utf8")).DATABASE_URL ?? "");
  return out.filter(Boolean);
}

/** why this address must not be a test's database; null if it may */
export function unsafeTestUrl(url: string, real = realUrls()): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return "adres okunamıyor"; }
  if (!/^postgres(ql)?:$/.test(u.protocol)) return "postgres:// adresi değil";
  if (!LOCAL.has(u.hostname)) return `bu makinede değil (${u.hostname}); testler yalnız yerel bir Postgres'e yazar`;
  const name = decodeURIComponent(u.pathname.replace(/^\//, ""));
  if (!/test/i.test(name)) return `veritabanının adında "test" yok (${name || "(ad yok)"})`;
  for (const r of real) {
    try { if (where(new URL(r)) === where(u)) return "sunucunun kendi veritabanıyla (DATABASE_URL) aynı"; } catch { /* not an address */ }
  }
  return null;
}

export interface TestDb { url: string; name: string; drop(): Promise<void> }

/** a database of this run's own -- checked, made, and dropped at the end; "" = embedded */
export async function testDatabase(tag = "t"): Promise<TestDb> {
  const base = process.env.TEST_DATABASE_URL ?? "";
  if (!base) return { url: "", name: "gömülü", drop: async () => {} };
  const why = unsafeTestUrl(base);
  if (why) throw new Error(`TEST_DATABASE_URL reddedildi: ${why}. Hiçbir şey yazılmadı.`);
  const pg = (await import("pg")).default;
  const u = new URL(base);
  const name = `${decodeURIComponent(u.pathname.slice(1)).toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 30)}_${tag}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  try { await admin.query(`CREATE DATABASE "${name}"`); }
  catch (e) { throw new Error(`Test veritabanı açılamadı (${(e as Error).message}); TEST_DATABASE_URL'in kullanıcısı CREATEDB yetkisi ister.`); }
  finally { await admin.end(); }
  u.pathname = "/" + name;
  return {
    url: u.toString(), name,
    drop: async () => {
      const c = new pg.Client({ connectionString: base });
      await c.connect();
      try { await c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); } finally { await c.end(); }
    },
  };
}
