/**
 * An admin's panel password, from the terminal (2026-11-14: the panel signs in
 * with e-mail and password). For the first admin, or one who cannot sign in
 * any more; inside the panel an admin sets passwords on "Kullanıcılar →
 * Yöneticiler".
 *
 *   npm run admin:password -- siz@ornek.org
 *
 * The password is asked for and not shown, goes to Supabase only and is
 * written nowhere: not to a file, not to the log, not to the database. The
 * account is made (confirmed) if there is none. It does not open the
 * database, so it runs beside a running server.
 */
import { createInterface } from "node:readline";
import { accountsOn, MIN_PASSWORD, setPassword } from "../src/storage/supabase.js";

const email = (process.argv[2] ?? "").trim().toLowerCase();
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error("Kullanım: npm run admin:password -- e-posta@adresi");
  process.exit(2);
}
if (!accountsOn()) {
  console.error("Hesaplar kurulmamış: .env'de SUPABASE_URL, SUPABASE_ANON_KEY ve SUPABASE_SERVICE_ROLE_KEY olmalı.");
  process.exit(2);
}

/** a line read without echoing it */
function ask(q: string): Promise<string> {
  return new Promise((ok) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
    let asking = true;
    out._writeToOutput = (s: string) => { if (asking) { out.output.write(s); asking = false; } };
    rl.question(q, (a) => { rl.close(); process.stdout.write("\n"); ok(a); });
  });
}

const a = await ask(`${email} için yeni şifre (en az ${MIN_PASSWORD} karakter, görünmez): `);
const b = await ask("Bir daha: ");
if (a !== b) { console.error("İki şifre aynı değil; hiçbir şey değişmedi."); process.exit(1); }
try {
  const { created } = await setPassword(email, a);
  console.log(`Tamam: ${email} şifresi belirlendi${created ? " (hesap da açıldı)" : ""}. Panel bu e-posta yöneticiler listesindeyse girer (ADMIN_EMAILS ya da panelden eklenen).`);
} catch (e) {
  console.error(`Olmadı: ${(e as Error).message}`);
  process.exit(1);
}
