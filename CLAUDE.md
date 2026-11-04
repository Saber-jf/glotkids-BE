# Tavşanın Mutfağı · Sunucu — çalışma notları

Projenin bütün kararları ve kuralları uygulamanın klasöründe:
**`../loplop/CLAUDE.md`** — bu klasörde çalışırken de önce onu oku.

## Her değişiklik dört katmanda (kural 28, kullanıcı, 2026-10-18)

Burada yapılan her değişiklik ve her yeni özellik için **uygulama**
(`../loplop`), **panel** (`../loplop-admin`), **sunucu** (bu klasör) ve
**veritabanı** (`src/storage/sql.ts`) birlikte kontrol edilir; gereken
değişiklik aynı işte yapılır. Ayrıntılı kontrol listesi `../loplop/CLAUDE.md`
→ kural 28.

- Yeni sütun/tablo = **yeni göç** (`MIGRATIONS`'a eklenir, eskisi düzenlenmez)
  ve `TABLES` listesine girer.
- Her sorgu `await`li; kontrol-sonra-yaz bir `tx(...)` içinde; transaction
  içinde ağ beklenmez.
- Veritabanının kendi kuralları (göç 3, 2026-10-19): durak başına tek canlı
  şarkı, rol başına tek canlı maskot birer kısmi tekil indeks; bir satırı
  canlı yapan yol **önce ötekini taslağa indirir, sonra bunu canlı yapar**.
  Yeni tablo `TABLES`'a, göç 1'den sonra geldiyse `TABLE_SINCE`'e de girer
  (geri yükleme eski şemanın eksik tablosunu ayırt etsin).
- Test veritabanı denetimi (`test/testdb.ts`) her test dosyasında sunucu
  açılmadan ve ilk yazımdan önce; gerçek Postgres güvenceleri `test/pg.ts`.
- Bitirmeden: burada `npm run typecheck` ve `npm test`; panelde `npm run build`
  ve `npm run test:e2e`; uygulamada `npm run typecheck`, `npm run loadcheck`,
  `npm run screentest`.
