# Üretim kurulumu (ilk yayın)

Karar (2026-10-16, veritabanı 2026-10-18): **tek VPS, tek Node süreci,
yerel kalıcı diskte dosyalar (`blobs/`), önünde Caddy; satırlar bir
PostgreSQL'de** (`DATABASE_URL` — Supabase ya da başka bir yönetilen
Postgres; adres henüz verilmedi). Sunucu güncellemeleri ve işletim bizim
sorumluluğumuzda. Bu sorumluluk alınmayacaksa: **kalıcı diskli, tek kopya**
çalışan yönetilen bir servis — geçici dosya sistemine `blobs/` asla konmaz.
Gömülü veritabanı (`DATABASE_URL` yokken) yalnız geliştirme içindir; üretimde
(`NODE_ENV=production`) sunucu onunla açılmaz.

Bu belgedeki dosyalar `deploy/` klasöründe hazır; hiçbiri henüz bir sunucuya
kurulmadı.

## Adresler

| Alan adı | Ne | Caddy'de |
|---|---|---|
| `api.…` | telefonun okuduğu: `/api/app/*`, `/api/health` | başka her yol 404 |
| `media.…` | dosyalar, içerik özetiyle: `/cdn/*` | `CDN_BASE` bu adres |
| `panel.…` | panelin derlenmiş dosyaları + `/api/*` | **kapının arkasında** (basic auth; MFA için `forward_auth`) |

Çocuk uygulamasının okuduğu yollar (api, media) yönetici girişine bağlı
**değildir**; yönetim API'si yalnız panel adresinden ve kapıdan geçerek
erişilir — ayrıca `ADMIN_TOKEN` ister.

## Kurulum adımları

1. `useradd --system loplop`; `/srv/loplop-server` (kod), `/var/lib/loplop`
   (veri, **kalıcı disk**), `/var/backups/loplop` (yerel yedek ara dizini).
2. Node 24, Caddy, rclone, openssl.
3. Sunucu: `npm ci && npm run build`. Panel: `npm ci && npm run build`,
   `dist/` → `/srv/loplop-admin/dist`.
4. `/etc/loplop/server.env` (`deploy/server.env.example`'dan, `chmod 600`):
   `ADMIN_TOKEN=$(openssl rand -hex 32)`, `BACKUP_PASSPHRASE=$(openssl rand -hex 32)`
   — ikincisinin bir kopyası **sunucu dışında** (parola yöneticisi): o
   olmadan hiçbir yedek açılmaz. `DATABASE_URL` (Supabase'de **Session
   pooler** ya da Direct adresi, `?sslmode=require`; Transaction pooler değil)
   ve `DATABASE_SSL=require`.
4b. İçerik geliştirme makinesindeyse: orada sunucuyu durdur,
   `DATABASE_URL=… npm run db:copy -- --from ./data/pgdata` (hedef boş
   olmalı), sonra `data/blobs/` ve `data/secrets.json` → `/var/lib/loplop/`
   (`rsync -a`). Satırlar dosyaları içerik özetiyle anar: biri eksikse
   `GET /api/releases/draft` onu hata olarak gösterir.
5. `deploy/loplop.service` → `/etc/systemd/system/`, `systemctl enable --now loplop`.
6. `deploy/Caddyfile` → alan adları ve e-posta değiştirilir, `caddy hash-password`
   ile panel kapısının şifresi; `systemctl reload caddy`.
7. Uygulamanın envanteri: derleme hattı `PUT https://panel…/api/inventory`
   (anahtarla). Aynı sürüm numarası ikinci kez farklı gönderilemez (409).
8. Mobil derlemede `EXPO_PUBLIC_API_URL=https://api.…`; `npm run release-check`
   ancak o zaman geçer.

## Kurallar

- **Tek süreç.** Sunucu açılışta `DATA_DIR/server.lock` alır; ikinci bir süreç
  açılmaz. **Tek veritabanı sahibi** (2026-10-19, `src/storage/owner.ts`):
  çalışan sunucu, havuz dışındaki kendi bağlantısında bir oturum kilidi tutar;
  aynı `DATABASE_URL`'e bağlanan ikinci sunucu — klasörü ne olursa olsun —
  `DATABASE_LOCK_WAIT_MS` (20 sn) bekler, sonra **göçlerden ve hiçbir şey
  yazmadan önce** açılmayı reddeder; çalışanın süren ücretli işlerine
  dokunmaz. Veritabanı ayrıca klasörüne bağlıdır (`meta.data-folder` =
  `DATA_DIR/folder-id`): başka klasörle açılan sunucu, öteki dursa bile
  reddedilir (satırların andığı dosyalar o klasörde). Klasör yedekten yeniden
  kurulduysa ve dosyalar tamsa bir kez `DATABASE_REBIND=1` ile başlatılır.
  Kilidin bağlantısı koparsa yeniden alınır; o arada başkası aldıysa sunucu
  durur. Oturum kilidi Transaction pooler'da (6543) tutulamaz — adres Session
  pooler ya da Direct olmalı. Güncelleme: **dur → yedek → yeni kod → başlat** — eski ve yeni süreç
  hiçbir an aynı klasöre birlikte yazmaz (`KillMode=control-group`).
  Birden fazla süreç gerekirse önce süreçler arası koordinasyon tasarlanır
  (veritabanı tabanlı kira/kilit, silmeden önce yeniden referans denetimi,
  karantina; çöken sürecin kilidi ve kira süresinin dolması test edilir).
- **ADMIN_TOKEN** yalnız `server.env`'de. Depoda, mobil uygulamada, panelin
  derleme değişkenlerinde, hiçbir URL'de yok; günlüklerde gizlenir. Üretimde
  32 karakterden kısaysa sunucu açılmaz. **Değiştirmek:** yeni değer →
  `systemctl restart loplop` → panelde yeniden giriş (medya belirteçleri de
  geçersiz olur). Birden fazla yönetici olunca ortak anahtar yerine kullanıcı
  bazlı yetki.
- **İzleme:** `GET https://api…/api/health` dakikada bir (dışarıdan bir
  izleyici): `ok:false` ya da `X-Loplop-Warning: disk-low` → uyarı. Günlükler
  `journalctl -u loplop` (JSON; istek adresindeki belirteçler `[gizli]`).
  `systemctl` çöken süreci 3 sn'de yeniden başlatır.

## Yedek (en çok 24 saat kayıp, 4 saat içinde geri dönüş)

- **Her gece** `deploy/loplop-backup.timer` (03:30) ve **her riskli
  dağıtım/göçten önce elle**: `npm run backup -- --out /var/backups/loplop`.
  Veritabanı tek bir salt okunur anlık görüntü transaction'ında (Postgres
  `REPEATABLE READ`: bütün tablolar aynı andaki hâliyle, sunucu çalışırken)
  satır satır `db/<tablo>.jsonl` olarak yazılır — sunucu sürümünden bağımsız;
  anlık görüntünün andığı **bütün dosyalarla aynı sette**; Supabase'in kendi
  yedekleri (ücretli planlarda) satırları tutar ama dosyaları tutmaz; yedek sürerken çöp
  toplama durur (`.gc-hold`). Set AES-256 ile şifrelenir; `rclone` sunucu
  dışına taşır, yerelde 14 gün tutulur.
- **Eksik set yedek değildir** (2026-10-19): veritabanının andığı bir dosya
  diskte yoksa (ya da başka bir hata olursa) komut hata koduyla biter, klasör
  `…-EKSIK` adını ve `YEDEK.json`'da `complete: false` taşır, şifrelenmez ve
  geri yüklenmez — zamanlayıcı başarısız görünür, izleyici bunu yakalamalı.
  `YEDEK.json` her tablo dosyasının satır sayısını ve SHA-256'sını yazar.
- **Ayda bir tatbikat:** `npm run restore-check -- --from <yedek>` — boş bir
  klasöre geri yükler, ayrı bir sunucu açar, içeriği, stüdyo belgesini ve
  her kanaldaki yayının bütün dosyalarını bayt bayt denetler, süreyi yazar;
  sonra paneli o kopyaya karşı açıp göz atın (komut nasıl yapılacağını yazar).
  Sonucu tarihle not edin.
- **Geri dönüş:** `systemctl stop loplop` → **boş** bir veritabanı (yeni bir
  Supabase projesi ya da `DROP SCHEMA public CASCADE; CREATE SCHEMA public;`
  sonrası) → `DATABASE_URL=… npm run restore -- --from <yedek> --to /var/lib/loplop-yeni`
  → klasörü yerine koy → `systemctl start loplop`. Dolu bir veritabanına geri
  yükleme reddedilir. SQLite dönemi yedekleri (`loplop.db` içeren) de aynı
  komutla Postgres'e geri yüklenir.
- **Geri yükleme hiçbir şey yazmadan önce bütün seti denetler:** `YEDEK.json`,
  biçim, eksiksizlik, şema (daha yeni sunucunun yedeği reddedilir), şemanın
  her tablosunun dosyası (eksik tablo sessizce atlanmaz), satır sayıları,
  dosya özetleri ve bütün medya dosyaları. Sonra sıra: klasöre işaret
  (`.restore-incomplete.json`) → veritabanı boş mu → dosyalar → satırlar tek
  transaction'da (`meta.restored-from` ile). **Yarıda kalırsa** (disk doldu,
  bağlantı koptu) aynı komut yeniden çalıştırılır: kaldığı yerden devam eder,
  satırları iki kez yazmaz. İşaret duran klasörle sunucu açılmaz. Geri
  yüklenen veritabanı klasör bağı taşımaz; ilk açılan sunucu bağlar.
- Bir disk anlık görüntüsü ya da CDN kopyası **tek başına yedek sayılmaz.**

## Sonra (ihtiyaç olunca)

**R2 + CDN:** `cdnUrl`/`blobPath` tek geçiş noktası. Geçişte: adresler içerik
özetine bağlı ve değişmez kalır; dosyalar yüklenip doğrulanmadan manifest
yayınlanmaz; eski yayınların dosyaları geri dönüş için korunur; taslak/özel
dosyalar herkese açık yapılmaz (yalnız yayınlanmış özetler bucket'a çıkar);
manifest (`no-cache`, ETag) ile değişmez dosyaların (`immutable`) önbellek
politikası ayrı kalır.
