# Tavşanın Mutfağı · Sunucu

Node.js + TypeScript + Fastify + **PostgreSQL** (`pg`; geliştirmede gömülü Postgres). İki kitleye hizmet eder:

- **panel** (`../loplop-admin`) bir **taslak** düzenler: kelimeler ve kayıtları,
  kelime setleri, oyunlar, kategoriler, dosyalar, ses/görsel stüdyosu; ve
  **yayınlar**.
- **uygulama** yalnızca yayınlananı okur: `/api/app/manifest` ve onun
  adlandırdığı dosyalar (`/cdn/<sha>.<ext>`).

Mimari, senaryolar ve "ne uygulama güncellemesi ister": 
[`../loplop/docs/ICERIK-MIMARISI.md`](../loplop/docs/ICERIK-MIMARISI.md).

```bash
npm install
npm run dev        # tsx watch — 127.0.0.1:8787
npm run typecheck
npm test           # birim (rotalar inject ile, sahte sağlayıcı, mobil okuyucu) + uçtan uca + postgres
npm run test:units # yalnız birim: S01–S12, A02/A03/A08/A09
npm run test:pg    # gerçek PostgreSQL'in güvenceleri (TEST_DATABASE_URL ister; yoksa "DENENMEDİ" der)
npm run build && npm start
npm run db:copy -- --from <kaynak>   # başka bir veritabanının satırlarını bu sunucunun (boş) veritabanına
npm run backup -- --out <klasör>     # satırlar + dosyalar, tek tutarlı set
npm run test:accounts                # hesaplar: sahte Supabase'le panel kapısı, yöneticiler, ebeveyn yedeği, kullanıcılar
npm run auth:fake                    # Supabase projesi yokken girişi denemek için sahte Supabase
```

Ortam (`.env` okunur, `.env.example`): `PORT`, `HOST` (127.0.0.1 dışı için
`ADMIN_TOKEN` şart), `DATA_DIR`, `APP_DIR` (uygulamanın klasörü; varsayılan
`../loplop`), `ADMIN_TOKEN` (verilirse panel uçları `Authorization: Bearer`
ister; telefonun okuduğu uçlar açık kalır), `HISTORY`, `DATABASE_URL`,
`DATABASE_SSL`, `DATABASE_SSL_CA`, `DATABASE_POOL` (aşağıda),
`DATABASE_LOCK_WAIT_MS`, `DATABASE_REBIND` (tek veritabanı sahibi,
`src/storage/owner.ts`).

## Veritabanı (2026-10-18: SQLite'tan PostgreSQL'e)

| `DATABASE_URL` | Ne |
|---|---|
| boş | **gömülü Postgres** (PGlite: aynı Postgres, WebAssembly) `DATA_DIR/pgdata` içinde — geliştirme ve testler; kurulacak bir şey yok. Tek süreç açabilir |
| `postgres://kullanıcı:parola@sunucu:5432/veritabanı?sslmode=require` | gerçek bir PostgreSQL (Supabase, yönetilen Postgres, kendi sunucunuz). **Üretimde zorunlu:** `NODE_ENV=production` iken boşsa sunucu açılmaz |

- **TLS:** `sslmode=disable` → TLS yok; `require` → şifreli, sertifika denetlenmez;
  `verify-full` denetler (`DATABASE_SSL_CA`: sağlayıcının sertifika dosyası).
  `DATABASE_SSL=require|verify` adrestekinin önüne geçer. (`pg`'nin kendisi
  `require`'ı "sistem otoritelerine karşı denetle" diye okuyor ve Supabase'e
  bağlanamıyordu; ayarı sunucu kendisi okur, `sql.ts` → `tlsOf`.)
- **Supabase:** Project Settings → Database → Connection string → **Session
  pooler** (5432) ya da Direct. **Transaction pooler (6543) değil**:
  açılıştaki göç kilidi oturum ister. Parola yalnız `.env` / `server.env`'de.
- **Göçler** `src/storage/sql.ts` → `MIGRATIONS`: yalnız eklenir, her biri
  kendi transaction'ında; iki sunucu aynı anda açılırsa biri göç eder, öteki
  bekler. SQLite'ın 1–9. göçleri Postgres'in 1. göçünde tek şemadır.
- **Transaction:** `tx(f)` içindeki bütün sorgular aynı bağlantıdan gider
  (AsyncLocalStorage) ve her yazan transaction önce tek bir veritabanı kilidi
  alır (`pg_advisory_xact_lock`) — SQLite'ın `BEGIN IMMEDIATE`'i gibi: kontrol
  et-sonra yaz her yazım (sürüm çakışması, iş kimliği, belge `rev`'i) eskisi
  kadar güvenli. Transaction içinde ağ beklenmez (yapay zekâ çağrısı dışarıda).
- **Okuma belleği:** bir istekteki aynı sorgu bir kez sorulur; istekteki her
  yazım belleği siler (`requestScope`). Uygulamanın envanteri bellekte tutulur
  (bu süreç tek yazandır, kural 25d).
- **Eski SQLite:** gömülü veritabanı boşken ilk açılışta `DATA_DIR/loplop.db`
  kendiliğinden içeri alınır (`meta.imported-sqlite`); dosya yedek olarak
  kalır. Gerçek bir Postgres bunu **kendiliğinden yapmaz** — satırları
  `npm run db:copy` getirir (klasördeki eski dosya, gömülü veritabanının
  sonradan aldıklarından eski olabilir).
- **Gerçek Postgres'e geçiş:** sunucuyu durdur → `.env`'e `DATABASE_URL` →
  `npm run db:copy -- --from ./data/pgdata` (boş hedefe; doluysa reddeder) →
  `data/blobs/` ve `secrets.json` yeni sunucunun `DATA_DIR`'ine (satırlar
  dosyaları özetiyle anar) → başlat; `/api/health` → `database`.
- **Testler** gerçek veritabanına asla dokunmaz: her biri kendi klasöründe
  gömülü bir veritabanı açar (`DATABASE_URL` kabukta ya da `.env`'de olsa
  bile). `pg` sürücüsünü denemek için yerel bir Postgres:
  `TEST_DATABASE_URL=postgres://kullanici@127.0.0.1:5432/loplop_test npm test`.
  Adres **sunucu açılmadan ve göçler dahil hiçbir şey yazılmadan önce**
  denetlenir (`test/testdb.ts`): bu makinede olmalı, adında `test` geçmeli,
  `DATABASE_URL`'le (kabuk ya da `.env`) aynı olmamalı. Testler o veritabanına
  da yazmaz: her koşu aynı sunucuda kendi veritabanını açar
  (`loplop_test_<etiket>_<rastgele>`, CREATEDB yetkisi gerekir) ve sonunda siler.

## Hesaplar (Supabase Auth, 2026-10-22)

Ayrıntı ve Supabase projesinin kurulumu: [`../loplop/docs/HESAPLAR.md`](../loplop/docs/HESAPLAR.md).

| Ayar | Ne |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | proje ve açık anahtarı (panele ve uygulamaya `/api/app/auth` ile gider) |
| `SUPABASE_SERVICE_ROLE_KEY` | yalnız bu süreçte: hesapları listeler, engeller, siler |
| `SUPABASE_JWT_SECRET` | yalnız eski (HS256) projeler için |
| `ADMIN_EMAILS` | ilk yöneticiler (virgülle); her açılışta eklenir, hesapları açılır |
| `AUTH_PROVIDERS` | gösterilen yöntemler: `email,google,apple` |

- **`SUPABASE_URL` yoksa** hesaplar kapalıdır ve her şey eskisi gibi çalışır.
- **Varsa** panel yalnız yöneticiler listesindeki Supabase hesabıyla açılır; başka bir hesap 403 `ADMIN_FORBIDDEN` alır. `ADMIN_TOKEN` makine anahtarı olarak kalır.
- **Uçlar:**
  - herkese açık: `GET /api/app/auth`;
  - ebeveynin kendi hesabı: `GET/DELETE /api/me`, `GET/PUT /api/me/progress` (sürümlü; eski sürümden yazım 409 alır, şimdiki yedekle birlikte);
  - panel: `GET /api/auth/me`, `GET/POST /api/admins`, `DELETE /api/admins/:email`, `GET /api/users[?q=&page=]`, `GET/DELETE /api/users/:id`, `POST /api/users/:id/ban`, `DELETE /api/users/:id/progress`, `GET /api/audit`.
- **Tablolar (göç 4):** `admins`, `accounts`, `progress_backups`, `audit`.
- **Proje yokken denemek:** `npm run auth:fake` sahte Supabase'i açar ve `.env` satırlarını yazar.

## Açılış sırası

1. veritabanı açılır, göçler çalışır (`src/storage/sql.ts`); gömülü
   veritabanı boşsa eski `loplop.db` bir kez içeri alınır (`storage/copy.ts`);
2. hazır resimler (`builtin/`) depoya `app-game-<id>` / `app-word-<id>` olarak kurulur;
3. uygulamanın envanteri (`APP_DIR/app-inventory.json`, uygulamada
   `npm run inventory`) alınır: motorlar, sahneler, uygulamanın kendi
   kelimeleri, setleri, oyunları ve kategorileri **hazır satırlar** olarak
   tazelenir (panelin onlara verdiği durum, sıra ve kayıtlar korunur);
4. eski JSON dosyalarından tek seferlik taşıma (`src/migrate-json.ts`;
   `db.json`, `games.json`, `categories.json`, `assets/` yedek olarak kalır).

## Veri (`DATA_DIR`, varsayılan `./data` — git'e girmez)

| Yol | İçerik |
|---|---|
| `pgdata/` | gömülü Postgres (yalnız `DATABASE_URL` yokken): bütün tablolar (aşağıda) |
| `loplop.db` | eski SQLite veritabanı: taşındıktan sonra yalnızca yedek |
| `blobs/<sha256>.<uzantı>` | dosya baytları, içerik özetiyle **bir kez** |
| `secrets.json` | panelden girilen API anahtarları |
| `db.json`, `games.json`, `categories.json`, `assets/`, `history/` | eski biçim; taşındıktan sonra yalnızca yedek |

| Tablo | İçerik |
|---|---|
| `assets` | dosya adı → özet, tür, boyut |
| `words`, `word_audio` | tek satır kelime; kayıtları yuva başına (`en, tr, about, about1–3, otter, call`) ve yapıldığı metin |
| `sets`, `set_words` | sıralı kelime listeleri |
| `games`, `categories` | set seçerler; durum (`live`/`draft`/`hidden`), sıra, `config`, adımlar |
| `capabilities` | uygulama sürümü başına envanter (yayımlanmış sürüm değişmez) |
| `jobs` | ücretli üretim işleri: her sonuç anında; aynı `jobId` ikinci kez ödenmez |
| `releases`, `channels` | donmuş manifestler; `test` / `production` → yayın |
| `documents`, `document_history` | panelin stüdyo belgesi (son 50 sürüm) |
| `meta` | taşıma işaretleri |

## API (`/api`)

| Uç | İş |
|---|---|
| `GET /health` | durum, disk, veritabanı (tür, yer, yanıt süresi), uygulama sürümü, kanallar, anahtarların ayarlı olup olmadığı |
| `GET/POST /words` · `GET/PATCH/DELETE /words/:id` | kelime kütüphanesi. Uygulamanın kelimesi değişmez (telefonda hep uygulamanınki) |
| `PUT/DELETE /words/:id/audio/:slot` | bir yuvanın kaydı + yapıldığı metin |
| `GET/POST /sets` · `GET/PATCH/DELETE /sets/:id` | setler; kullanılan set silinmez, uygulamanın setinin kelimeleri değişmez |
| `GET/POST /games` · `GET/PATCH/DELETE /games/:id` · `PUT /games/order` | oyunlar; yeni oyun yalnız **açık** motordan, bir set seçer. Her biri `issues` taşır |
| `GET /games/templates` | yeni oyunun yapılabileceği açık motorlar |
| `GET/POST /categories` · `GET/PATCH/DELETE /categories/:id` · `PUT /categories/order` | kategoriler: set + adımlar; hatalı olan `live` olamaz |
| `GET /categories/scenes` | sürümdeki canlı sahneler |
| `GET /inventory` · `GET /inventory/builds` · `PUT /inventory` | envanter; `PUT` derleme hattı içindir |
| `GET /releases` · `GET /releases/draft` · `POST /releases` · `GET /releases/:id` | yayınlar; taslak = ne gidecek, ne durduruyor, kanallara göre fark |
| `GET /channels` · `PUT /channels/:name` | kanalı bir yayına çevir (üretime al / geri al) |
| `GET/POST /assets` · `GET/DELETE /assets/:id` · `POST /assets/gc` | dosyalar; kullanılan dosya silinmez (409 `ASSET_IN_USE`, yalnız arşivdeki `?archive=drop`); `gc` kilitli, 10 dk'dan yeni bloba dokunmaz |
| `GET /assets/usage` · `GET /assets/:id/usage` | bir dosyayı kim kullanıyor: tek cevap |
| `GET /auth/media` | 1 saatlik salt okunur medya belirteci (`?m=`); tam anahtar hiçbir URL'de olmaz |
| `GET /ai/jobs/:id` | ücretli işin durumu ve sonuçları |
| `GET /inventory/conflicts` | envanterin getirdiği, panelde zaten var olan kimlikler |
| `GET/PUT /db` | stüdyo belgesi (`rev`; eski `rev` → 409) |
| `GET/PUT /settings/keys` · `GET /ai/test/:provider` | AI anahtarları (değer geri dönmez) |
| `GET /ai/eleven/voices` · `GET /ai/eleven/credits` · `POST /ai/eleven/tts` · `POST /ai/images` | üretim; sonuç yanıt dönmeden diske yazılır |

**Telefon için (açık):** `GET /api/app/manifest?build=&schema=&channel=` —
kanalın yayını, o sürümün oynatabildiğine kesilmiş; ETag `"r<yayın>-b<sürüm>"`,
304; kanal boşsa 204; şema tutmazsa 409. `GET /cdn/<sha>.<ext>` —
`Cache-Control: immutable`. Eski sürümler için `GET /api/app/catalog`,
`GET /api/app/categories` (üretim yayını, eski biçim).

## Sözleşmeler

Yazımlar `If-Match: "<updatedAt>"` alabilir (eski sürüm → 409 `STALE` +
`current`); yayın isteği taslağın `fingerprint`'ini `expect` olarak alabilir
(değiştiyse 409 `DRAFT_CHANGED`); hatalar makinece ayrılır (`code`):
`ADMIN_UNAUTHORIZED` (yalnız bu panelden çıkarır), `PROVIDER_AUTH_FAILED`,
`PROVIDER_TIMEOUT`, `PROVIDER_RATE_LIMIT`, `JOB_RUNNING`, `BAD_DOCUMENT`,
`CLIP_TAKEN`, `BUILD_IMMUTABLE`. İstek günlüğü `k`, `m`, `token`, `key`
parametrelerini `[gizli]` yazar. Ayrıntı: `../loplop/docs/ICERIK-MIMARISI.md`
→ "Güvenilirlik sözleşmeleri".

## Sırada

Barındırma (HTTPS, yedek, `ADMIN_TOKEN`) ve üretim veritabanının adresi;
`blobs/`'u nesne deposuna ve CDN'e taşımak (`cdnUrl` tek yer); derleme
hattından `PUT /inventory`.
