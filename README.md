# KHMlight Outage Parser (TypeScript / Cloudflare Workers)

Сервіс автоматичного збору, парсингу, валідації та роздачі графіків погодинних відключень електроенергії (ГПВ) з офіційного сайту АТ «Хмельницькобленерго» ([hoe.com.ua](https://hoe.com.ua/page/pogodinni-vidkljuchennja)).

Побудований на **TypeScript**, працює на **Cloudflare Workers Free + Cron Triggers (кожні 15 хв) + Cloudflare D1** і надає компактне JSON REST API для застосунку **KHMlight**.

---

## Архітектура

```text
├── migrations/
│   └── 0001_initial_schema.sql          # Схема Cloudflare D1 (14-денне зберігання)
├── src/
│   ├── core/                            # Чисте ядро (0 залежностей від Node / Workers / DOM)
│   │   ├── types/                       # Доменні типи, IR екстрактора, контракти API
│   │   ├── ports/                       # Інтерфейси Clock, HttpFetcher, HtmlExtractor, ScheduleStore
│   │   ├── time/                        # Europe/Kyiv clock (DST-safe) та витяг дат
│   │   ├── scraping/                    # Розбивка блоків, фільтр boilerplate і 3-рівневий фільтр новин
│   │   ├── parsing/                     # Парсер інтервалів (хвилини 0..1440) та оперативних змін
│   │   ├── normalizing/                 # Злиття, віднімання скасувань, 12 підчерг (1.1..6.2)
│   │   ├── versioning/                  # Хронологічний реплей версій, sparse-дифи, SHA-256
│   │   ├── validation/                  # Двошарова валідація (Zod v4 jitless + доменні інваріанти + LKG)
│   │   ├── export/                      # Білдер матеріалізованих API-снапшотів
│   │   └── pipeline/                    # Оркестратор синку з IR fast-path і 8 станами RunOutcome
│   ├── adapters/
│   │   ├── html/                        # HtmlRewriterExtractor (Workers prod) + CheerioHtmlExtractor (dev/test)
│   │   ├── http/                        # FetchHttpClient (AbortSignal timeout + розумні ретраї)
│   │   └── storage/                     # D1ScheduleRepository (атомарний db.batch + 14-денний pruning)
│   └── worker/                          # Entrypoint Worker (HTTP API + Cron Trigger)
├── scripts/
│   └── debug-parse.ts                   # Локальний CLI для налагодження на фікстурах або живому сайті
├── docs/
│   └── openapi.yaml                     # OpenAPI 3.1 специфікація REST API
└── tests/                               # Unit-тести (Node) + інтеграційні E2E у workerd із D1
```

### Ключові гарантії надійності
- **Захист Last Known Good (LKG):** помилки мережі (`FETCH_ERROR`), зламаний HTML (`PARSE_ERROR`) чи неповні/підозріло обнулені дані (`INCOMPLETE_DATA`, `ORPHAN_DELTA_WITHOUT_BASE`, `SUSPICIOUS_ZEROING`) **ніколи не перезаписують** останні валідні графіки в D1.
- **Атомарність:** усі зміни таблиць (`days`, `day_revisions`, `api_snapshots`, `sync_state`, `scrape_runs` + 14-денне очищення) комітяться одним `env.DB.batch([...])`.
- **Оптимізація під Free Tier (10 ms CPU):** у продакшені використовується нативний потоковий `HTMLRewriter` (`cheerio` є лише у `devDependencies` і не потрапляє у бандл), Cron має двоступеневий IR fast-path, а HTTP API читає рівно 1 готовий рядок JSON по `PRIMARY KEY`.

---

## REST API

Повна специфікація у форматі **OpenAPI 3.1**: [docs/openapi.yaml](docs/openapi.yaml).

Усі `/api/*` ендпоїнти повертають minified JSON, `Access-Control-Allow-Origin: *`, `ETag` (підтримка `If-None-Match` → `304 Not Modified`) і `Cache-Control: public, max-age=60, stale-while-revalidate=300`.

| Маршрут | Опис | Коди |
|---|---|---|
| `GET /api/current` | Графіки на **сьогодні + завтра** + `availableDates` в 1 запиті | `200`, `304`, `503` |
| `GET /api/queues/:id` | Дані однієї підчерги (`1.1`..`6.2`) + `prevIntervals` і `deltaMinutes` | `200`, `304`, `400`, `503` |
| `GET /api/status` | Легкий індекс (~340 B): `stateHash`, `dataHash`, статуси та дати | `200`, `304`, `503` |
| `GET /api/schedules` | Активні графіки за останні **14 днів** | `200`, `304`, `503` |
| `GET /api/schedules/:date` | Деталі за дату (`YYYY-MM-DD`) + хронологічні `revisions` (sparse diff) | `200`, `304`, `400`, `404` |
| `GET /health` | Перевірка D1, останній `outcome`, `consecutiveFailures` (`ok` / `degraded`) | `200` |

### Формат інтервалів і статусів
- Інтервали задаються кортежами цілих хвилин від опівночі `0..1440`:
  - `[360, 480]` → `06:00–08:00`
  - `[1320, 1440]` → `22:00–24:00`
- `offMinutes` — сумарна кількість хвилин відключень за добу (`600` = `10` год).
- Статуси дня (`status`):
  - `"ACTIVE"` — є заплановані відключення.
  - `"NO_OUTAGES"` — офіційно опубліковано графік без відключень (`intervals: []`, `offMinutes: 0`).
  - `"UNAVAILABLE"` — графік на цю дату ще не опубліковано (`queues: null` / `intervals: null`).

### Приклад відповіді `GET /api/queues/1.1`
```json
{
  "source": "https://hoe.com.ua/page/pogodinni-vidkljuchennja",
  "queue": "1.1",
  "stateHash": "c7065daa2fcaa982",
  "updatedAt": "2026-11-27T00:22:03+02:00",
  "today": {
    "date": "2026-11-27",
    "status": "ACTIVE",
    "message": "За розпорядженням НЕК «Укренерго» 27.11.2026 р. на Хмельниччині будуть застосовані графіки погодинних відключень (ГПВ).",
    "intervals": [[360, 480], [660, 840], [1020, 1200], [1320, 1440]],
    "offMinutes": 600,
    "prevIntervals": null,
    "deltaMinutes": null
  },
  "tomorrow": {
    "date": "2026-11-28",
    "status": "UNAVAILABLE",
    "message": null,
    "intervals": null,
    "offMinutes": null,
    "prevIntervals": null,
    "deltaMinutes": null
  }
}
```

### Рекомендований флоу для Android (KHMlight)
1. **Головний екран:** `GET /api/current` із заголовком `If-None-Match: "<ETag>"`. При `304` — використовуємо кеш (0 байт тіла).
2. **WorkManager / Push / Віджет:** `GET /api/queues/<підчерга>` (~580 B) із `If-None-Match`. Поле `today.deltaMinutes` (`+120` / `-60`) готове для сповіщень про зміну графіка.
3. **Історія змін:** `GET /api/schedules/YYYY-MM-DD` (хронологічні ревізії) або `GET /api/schedules`.
4. **Fallback:** при мережевій помилці чи `503` клієнт перемикається на резервний GitHub Raw JSON.

---

## Локальна розробка та тестування

```powershell
npm install

# Перевірка типів
npm run typecheck

# Усі тести (Node unit + реальний workerd із D1 і HTMLRewriter)
npm test

# Локальний дебаг-скрипт (фікстура або живий hoe.com.ua)
npm run debug -- --fixture tests/fixtures/html/main_page.html --date 2026-11-27
npm run debug -- --live

# Локальна D1 + dev-сервер із ручним викликом Cron
npm run db:migrate:local
npx wrangler dev --test-scheduled
# У другому терміналі:
curl "http://localhost:8787/__scheduled?cron=7,22,37,52+*+*+*+*"
curl "http://localhost:8787/api/current"
```

---

## Деплой у Cloudflare Workers

```powershell
# 1. Створити D1-базу (якщо ще не створена) і вказати її database_id у wrangler.jsonc
npx wrangler d1 create khmlight-outages

# 2. Застосувати міграції на віддаленій базі
npx wrangler d1 migrations apply DB --remote

# 3. Задеплоїти Worker і Cron Trigger (7,22,37,52 * * * *)
npx wrangler deploy

# 4. Перегляд живих логів
npx wrangler tail
```
