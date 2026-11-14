/**
 * ACCOUNTS (Supabase Auth, 2026-10-22): the panel's sign-in and admins list,
 * the app's parent accounts and their progress, the panel's user management
 * and its audit -- driven through the real routes (`inject`) against a FAKE
 * Supabase (`tools/fake-supabase.ts`) on a port of its own: real signed
 * tokens, the real admin API calls, nothing of a real project touched.
 *
 *   npm run test:accounts
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SignJWT } from "jose";
import { startFakeSupabase } from "../tools/fake-supabase.js";

const fake = await startFakeSupabase();
const data = mkdtempSync(path.join(tmpdir(), "loplop-accounts-"));
const HS = "test-legacy-jwt-secret-0123456789abcdef";
Object.assign(process.env, {
  DATA_DIR: data, LOG_LEVEL: "error", APP_DIR: path.resolve(process.env.APP_DIR ?? "../loplop"),
  ADMIN_TOKEN: "MACHINE_KEY_FOR_THE_TESTS_0123456789",
  SUPABASE_URL: fake.url, SUPABASE_ANON_KEY: fake.anonKey, SUPABASE_SERVICE_ROLE_KEY: fake.serviceKey,
  SUPABASE_JWT_SECRET: HS, ADMIN_EMAILS: "boss@ornek.test", AUTH_PROVIDERS: "email,google,apple",
});
const { testDatabase } = await import("./testdb.js");
const tdb = await testDatabase("accounts");
process.env.DATABASE_URL = tdb.url;
process.env.NODE_ENV = "test";

const { openDb, closeDb } = await import("../src/storage/sql.js");
const files = await import("../src/storage/files.js");
const { buildApp } = await import("../src/app.js");

let fail = 0;
const ok = (what: string, cond: boolean, note = "") => {
  if (!cond) { fail++; console.error(`  HATA  ${what}${note ? "  — " + note : ""}`); }
  else console.log(`  gecti  ${what}${note ? "  (" + note + ")" : ""}`);
};
const section = (t: string) => console.log(`\n${t}`);
const keepAlive = setInterval(() => {}, 1000);

await files.ensureDirs();
await openDb();
if (!(await (await import("../src/storage/copy.js")).isEmpty())) { console.error("Test veritabanı boş değil."); process.exit(1); }
const app = await buildApp();

type Res = { status: number; body: any };
async function j(method: string, url: string, token?: string, body?: unknown): Promise<Res> {
  const r = await app.inject({ method: method as never, url, headers: token ? { authorization: `Bearer ${token}` } : {},
                               ...(body !== undefined ? { payload: body as never } : {}) });
  let b: unknown = null;
  try { b = r.body ? JSON.parse(r.body) : null; } catch { b = r.body; }
  return { status: r.statusCode, body: b };
}
const tokenOf = async (email: string, provider = "email") => (await fake.signIn(email, provider)).access_token;
const KEY = process.env.ADMIN_TOKEN!;

section("1 · nasıl girilir (herkese açık)");
{
  const r = await j("GET", "/api/app/auth");
  ok("hesaplar açık, adres, açık anahtar, yöntemler", r.status === 200 && r.body.enabled === true && r.body.url === fake.url
     && r.body.anonKey === fake.anonKey && r.body.providers.join() === "email,google,apple");
  ok("servis anahtarı hiçbir yerde dönmez", !JSON.stringify(r.body).includes(fake.serviceKey));
}

section("2 · panel kapısı");
const boss = await tokenOf("boss@ornek.test");
{
  ok("anahtarsız panel isteği: 401 ADMIN_UNAUTHORIZED", (await j("GET", "/api/words")).body?.code === "ADMIN_UNAUTHORIZED");
  const w = await j("GET", "/api/words", boss);
  ok("ADMIN_EMAILS'teki hesap paneli açar", w.status === 200, String(w.status));
  const me = await j("GET", "/api/auth/me", boss);
  ok("kim olduğu: hesap, e-posta", me.body.via === "account" && me.body.email === "boss@ornek.test" && me.body.accounts === true);
  const stranger = await j("GET", "/api/words", await tokenOf("ebeveyn@ornek.test"));
  ok("yönetici olmayan hesap: 403 ADMIN_FORBIDDEN (çıkış yaptırmaz)", stranger.status === 403 && stranger.body.code === "ADMIN_FORBIDDEN");
  ok("makine anahtarı (ADMIN_TOKEN) hâlâ geçer", (await j("GET", "/api/words", KEY)).status === 200);
  ok("anahtarla 'kim': anahtar", (await j("GET", "/api/auth/me", KEY)).body.via === "key");
  ok("bozuk token: 401", (await j("GET", "/api/words", "a.b.c")).body?.code === "ADMIN_UNAUTHORIZED");
  /* another project's token (another fake: another key) */
  const other = await startFakeSupabase();
  const foreign = (await other.signIn("boss@ornek.test")).access_token;
  await other.close();
  ok("başka bir projenin tokenı: 401", (await j("GET", "/api/words", foreign)).status === 401);
  /* the old shared secret (HS256), and one with the wrong issuer */
  const hs = (iss: string) => new SignJWT({ email: "boss@ornek.test", app_metadata: { provider: "email" } })
    .setProtectedHeader({ alg: "HS256" }).setSubject("hs-boss").setIssuer(iss).setAudience("authenticated")
    .setExpirationTime("1h").sign(new TextEncoder().encode(HS));
  ok("eski ortak sırla (HS256) imzalı token geçer", (await j("GET", "/api/words", await hs(`${fake.url}/auth/v1`))).status === 200);
  ok("başka bir yayıncı (iss): 401", (await j("GET", "/api/words", await hs("https://baska.supabase.co/auth/v1"))).status === 401);
  const expired = await new SignJWT({ email: "boss@ornek.test" }).setProtectedHeader({ alg: "HS256" }).setSubject("x")
    .setIssuer(`${fake.url}/auth/v1`).setAudience("authenticated").setExpirationTime(Math.floor(Date.now() / 1000) - 10)
    .sign(new TextEncoder().encode(HS));
  ok("süresi dolmuş token: 401", (await j("GET", "/api/words", expired)).status === 401);
  const h1 = await j("GET", "/api/health"), h2 = await j("GET", "/api/health", boss);
  ok("sağlık: herkese yalnız durum, yöneticiye ayrıntı", h1.body.dataDir === undefined && !!h2.body.dataDir && h2.body.accounts === true);
  const m = await j("GET", "/api/auth/media", boss);
  ok("yöneticiye medya belirteci", typeof m.body.token === "string");
}

section("3 · yöneticiler");
{
  const list = await j("GET", "/api/admins", boss);
  ok("ADMIN_EMAILS listede, ilk girişte hesaba bağlandı", list.body.length === 1 && list.body[0].email === "boss@ornek.test" && list.body[0].seeded && list.body[0].bound);
  const add = await j("POST", "/api/admins", boss, { email: "Yeni.Yonetici@Ornek.test", name: "Ayşe" });
  ok("yönetici eklenir (küçük harfle), Supabase'te hesabı açılır", add.status === 201 && add.body.email === "yeni.yonetici@ornek.test"
     && add.body.account === "created" && [...fake.users.values()].some((u) => u.email === "yeni.yonetici@ornek.test"));
  ok("aynı e-posta ikinci kez: 409", (await j("POST", "/api/admins", boss, { email: "yeni.yonetici@ornek.test" })).status === 409);
  ok("geçersiz e-posta: 400", (await j("POST", "/api/admins", boss, { email: "yok" })).status === 400);
  const ayse = await tokenOf("yeni.yonetici@ornek.test");
  ok("eklenen yönetici paneli açar", (await j("GET", "/api/words", ayse)).status === 200);
  ok("kendini çıkaramaz", (await j("DELETE", `/api/admins/${encodeURIComponent("yeni.yonetici@ornek.test")}`, ayse)).status === 400);
  ok("ADMIN_EMAILS'tekini panelden çıkaramaz", (await j("DELETE", `/api/admins/${encodeURIComponent("boss@ornek.test")}`, ayse)).status === 400);
  ok("çıkarılır", (await j("DELETE", `/api/admins/${encodeURIComponent("yeni.yonetici@ornek.test")}`, boss)).status === 200);
  ok("çıkarılan artık giremez (403)", (await j("GET", "/api/words", ayse)).status === 403);

  /* the panel's password sign-in (2026-11-14) */
  const pwLogin = async (email: string, password: string) => (await fetch(`${fake.url}/auth/v1/token?grant_type=password`, {
    method: "POST", headers: { apikey: fake.anonKey, "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) })).status;
  const withPw = await j("POST", "/api/admins", boss, { email: "sifreli@ornek.test", password: "ilk-sifre-1" });
  ok("ilk şifreyle eklenir; o şifreyle girer", withPw.status === 201 && withPw.body.password === true && (await pwLogin("sifreli@ornek.test", "ilk-sifre-1")) === 200);
  ok("kısa ilk şifre: 400", (await j("POST", "/api/admins", boss, { email: "kisa@ornek.test", password: "1234567" })).status === 400);
  const set = await j("POST", `/api/admins/${encodeURIComponent("sifreli@ornek.test")}/password`, boss, { password: "yeni-sifre-2" });
  ok("şifre belirlenir: eskisi girmez, yenisi girer", set.status === 200 && (await pwLogin("sifreli@ornek.test", "ilk-sifre-1")) === 400
     && (await pwLogin("sifreli@ornek.test", "yeni-sifre-2")) === 200);
  ok("kısa şifre: 400", (await j("POST", `/api/admins/${encodeURIComponent("sifreli@ornek.test")}/password`, boss, { password: "kisa" })).status === 400);
  ok("yönetici olmayanın şifresi buradan belirlenmez: 404",
     (await j("POST", `/api/admins/${encodeURIComponent("anne@ornek.test")}/password`, boss, { password: "yeni-sifre-3" })).status === 404);
  ok("anahtarsız/yöneticisiz şifre belirlenmez (401)",
     (await j("POST", `/api/admins/${encodeURIComponent("sifreli@ornek.test")}/password`, "", { password: "yeni-sifre-4" })).status === 401);
  ok("sunucunun ADMIN_EMAILS yöneticisi de şifre alır", (await j("POST", `/api/admins/${encodeURIComponent("boss@ornek.test")}/password`, boss, { password: "patron-sifre" })).status === 200
     && (await pwLogin("boss@ornek.test", "patron-sifre")) === 200);
  const logged = await j("GET", "/api/audit", boss);
  ok("işlem kaydında 'şifre belirledi', şifrenin kendisi yok", logged.status === 200 && JSON.stringify(logged.body).includes("admin.password")
     && !/ilk-sifre-1|yeni-sifre-2|patron-sifre/.test(JSON.stringify(logged.body)));
  ok("çıkarılır", (await j("DELETE", `/api/admins/${encodeURIComponent("sifreli@ornek.test")}`, boss)).status === 200);
}

section("4 · ebeveyn hesabı ve ilerleme yedeği");
const parent = await tokenOf("anne@ornek.test");
let parentId = "";
{
  ok("token'sız /api/me: 401 SIGNED_OUT", (await j("GET", "/api/me")).body?.code === "SIGNED_OUT");
  const me = await j("GET", "/api/me", parent);
  parentId = me.body.id;
  ok("ebeveyn kendini görür, yedeği yok", me.status === 200 && me.body.email === "anne@ornek.test" && me.body.backup === null);
  ok("yedek yok: 404", (await j("GET", "/api/me/progress", parent)).status === 404);
  const doc = (stops: string[]) => ({ schema: 1, active: "p-1", profiles: [{ id: "p-1", label: "1", createdAt: 1, words: { apple: { met: 1, firstAt: 1, lastAt: 1 } },
                                                                             stops, open: null, at: null, series: {} }] });
  const p1 = await j("PUT", "/api/me/progress", parent, { rev: null, data: doc(["kitchen-1"]), device: "iPhone" });
  ok("ilk yedek: rev 1", p1.status === 200 && p1.body.rev === 1);
  const stale = await j("PUT", "/api/me/progress", parent, { rev: null, data: doc([]) });
  ok("eski sürümden yazım: 409 ve şimdiki yedek (üstüne yazılmaz)", stale.status === 409 && stale.body.current.rev === 1
     && stale.body.current.data.profiles[0].stops[0] === "kitchen-1");
  const p2 = await j("PUT", "/api/me/progress", parent, { rev: 1, data: doc(["kitchen-1", "kitchen-2"]) });
  ok("doğru sürümden: rev 2", p2.body.rev === 2);
  const g = await j("GET", "/api/me/progress", parent);
  ok("okunur", g.body.rev === 2 && g.body.data.profiles[0].stops.length === 2);
  ok("bozuk belge: 400", (await j("PUT", "/api/me/progress", parent, { rev: 2, data: { profiles: "x" } })).status === 400);
  ok("çok büyük belge: 413", (await j("PUT", "/api/me/progress", parent,
    { rev: 2, data: { schema: 1, profiles: [{ big: "x".repeat(600 * 1024) }] } })).status === 413);
  ok("ebeveynin token'ı paneli açmaz", (await j("GET", "/api/users", parent)).status === 403);
}

section("5 · kullanıcı yönetimi");
{
  const l = await j("GET", "/api/users", boss);
  const anne = l.body.users?.find((u: { email: string }) => u.email === "anne@ornek.test");
  ok("liste: hesaplar, toplam, yedek özeti", l.status === 200 && l.body.total >= 3 && anne?.backup?.rev === 2
     && anne.backup.summary.profiles[0].stops === 2 && anne.backup.summary.profiles[0].words === 1, JSON.stringify(anne ?? l.body).slice(0, 200));
  ok("yönetici işaretli", l.body.users.find((u: { email: string }) => u.email === "boss@ornek.test")?.admin === true);
  const s = await j("GET", "/api/users?q=anne", boss);
  ok("arama", s.body.users.length === 1 && s.body.users[0].email === "anne@ornek.test");
  const ban = await j("POST", `/api/users/${parentId}/ban`, boss, { banned: true });
  ok("engellenir (Supabase'te)", ban.status === 200 && !!ban.body.bannedUntil && !!fake.users.get(parentId)?.bannedUntil);
  const otp = await fetch(`${fake.url}/auth/v1/otp`, { method: "POST", headers: { apikey: fake.anonKey, "Content-Type": "application/json" },
                                                       body: JSON.stringify({ email: "anne@ornek.test" }) });
  ok("engelli hesap kod alamaz", otp.status === 400);
  const unban = await j("POST", `/api/users/${parentId}/ban`, boss, { banned: false });
  ok("engel kalkar", unban.status === 200 && unban.body.bannedUntil === null);
  const bossId = [...fake.users.values()].find((u) => u.email === "boss@ornek.test")!.id;
  ok("kendini engelleyemez", (await j("POST", `/api/users/${bossId}/ban`, boss, { banned: true })).status === 400);
  const d = await j("GET", `/api/users/${parentId}`, boss);
  ok("ayrıntı: işlem kaydıyla", d.status === 200 && d.body.events.some((e: { action: string }) => e.action === "account.ban"));
  ok("yedeği sil", (await j("DELETE", `/api/users/${parentId}/progress`, boss)).body.deleted === true
     && (await j("GET", "/api/me/progress", parent)).status === 404);
  const admin2 = await j("POST", "/api/admins", boss, { email: "ikinci@ornek.test" });
  const id2 = [...fake.users.values()].find((u) => u.email === "ikinci@ornek.test")!.id;
  ok("yönetici olan hesap kullanıcılardan silinmez (409)", admin2.status === 201 && (await j("DELETE", `/api/users/${id2}`, boss)).status === 409);
  const del = await j("DELETE", `/api/users/${parentId}`, boss);
  ok("hesap silinir: Supabase'ten ve buradan", del.status === 200 && !fake.users.has(parentId)
     && (await j("GET", `/api/users/${parentId}`, boss)).status === 404);
}

section("6 · uygulamadan hesabı silmek");
{
  const dad = await tokenOf("baba@ornek.test", "google");
  const me = await j("GET", "/api/me", dad);
  ok("Google ile giren ebeveyn", me.body.provider === "google");
  await j("PUT", "/api/me/progress", dad, { rev: null, data: { schema: 1, active: "a", profiles: [] } });
  const del = await j("DELETE", "/api/me", dad);
  ok("kendi hesabını siler: hesap ve yedek gider", del.status === 200 && !fake.users.has(me.body.id));
  const l = await j("GET", "/api/users?q=baba", boss);
  ok("listede yok", l.body.users.length === 0);
  ok("yönetici uygulamadan kendi hesabını silemez (409)", (await j("DELETE", "/api/me", boss)).body?.code === "IS_ADMIN");
}

section("7 · işlem kaydı");
{
  const a = await j("GET", "/api/audit", boss);
  const acts = a.body.map((e: { action: string; actor: string }) => `${e.actor}:${e.action}`);
  for (const want of ["ADMIN_EMAILS:admin.add", "boss@ornek.test:admin.add", "boss@ornek.test:admin.remove", "boss@ornek.test:account.ban",
                      "boss@ornek.test:account.unban", "boss@ornek.test:progress.delete", "boss@ornek.test:account.delete", "baba@ornek.test:account.delete"])
    ok(`kayıtta: ${want}`, acts.includes(want));
}

await app.close();
await closeDb();
await tdb.drop();
await fake.close();
clearInterval(keepAlive);
console.log(fail ? `\nhesaplar: ${fail} HATA` : "\nhesaplar: hepsi gecti");
process.exit(fail ? 1 : 0);
