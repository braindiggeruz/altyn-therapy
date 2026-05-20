# Meta Pixel + Conversions API — Altyn Therapy

Документация по событийной разметке, серверному CAPI, Telegram-боту
`@altyndirectbot` и развёртыванию на Cloudflare Pages.

## Архитектура

```
                ┌────────────────────────────────┐
   Meta Ad ───► │ altyn-therapy.uz/?utm…         │   (landing)
                │   • PageView                   │
                │   • ViewContent                │
                │   • LandingQualifiedView       │
                │   • CTA_Click                  │
                └──────────────┬─────────────────┘
                               │  click /go/telegram
                               ▼
                ┌────────────────────────────────┐         ┌─────────────────────────┐
                │ /go/telegram?utm…              │         │ KV: ALTYN_LEAD_         │
                │   1. generate lead_id          │────────►│ ATTRIBUTION             │
                │   2. POST /api/lead-           │         │ key: lead:<lead_id>     │
                │      attribution (UTM/fbp/fbc) │         │ TTL 30d                 │
                │   3. fbq+CAPI Contact          │         └─────────────────────────┘
                │   4. fbq+CAPI Lead             │                       ▲
                │   5. open tg://resolve?domain  │                       │
                │      =altyndirectbot&start=    │                       │ recover UTM
                │      <lead_id>                 │                       │ by lead_id
                └──────────────┬─────────────────┘                       │
                               │                                          │
                               ▼                                          │
                ┌────────────────────────────────┐                        │
                │ @altyndirectbot (NextBot GPT)  │                        │
                │   • /start <lead_id>           │                        │
                │   • GPT dialog                 │                        │
                │   • button "Хочу разбор за 10$"│                        │
                └──────────────┬─────────────────┘                        │
                               │ NextBot outgoing webhook                 │
                               │ (or manager / CRM / future own webhook)  │
                               ▼                                          │
                ┌─────────────────────────────────────────────────────────┴┐
                │ POST /api/telegram/qualified-intent                      │
                │   header: x-altyn-intent-secret                          │
                │   body:   { lead_id, telegram_user_id, telegram_username,│
                │             action: "want_diagnostic" }                  │
                │ → recover UTM from KV by lead_id                         │
                │ → dedupe: qualified:<lead_id> 24h                        │
                │ → CAPI: QualifiedLead (no message text!)                 │
                │ → notify TELEGRAM_NOTIFY_CHAT_ID (-1003406252597)        │
                └─────────────────────────────────────────────────────────-┘
```

## Telegram bot status (audit)

* Bot: **@altyndirectbot**, id `8790982465`, name "Алтын | Гипнотерапевт"
* **Webhook is already set on `https://app.nextbot.ru/...` (NextBot GPT platform).**
  We do NOT touch it. Instead NextBot calls our endpoint `/api/telegram/qualified-intent`
  when it detects a qualified intent (button press or keyword match).
* Notify group: **`-1003406252597` "Алтын-заявки"** (supergroup, bot already member). ✅

## Файлы

| Файл | Назначение |
|---|---|
| `index.html` | Landing (loads `altyn-utm.js` then `altyn-pixel.js`) |
| `assets/altyn-utm.js` | UTM / fbclid / `_fbp` / `_fbc` capture; `window.altynUTM` API |
| `assets/altyn-pixel.js` | Pixel init, landing events, rewrites t.me anchors to `/go/telegram` |
| `assets/altyn-enhance.js` | Sticky CTA, video testimonials — все CTA на `/go/telegram` |
| `go/telegram/index.html` | Bridge UI (noindex, mobile-first) |
| `assets/altyn-bridge.js` | Bridge logic: lead_id, attribution POST, Contact/Lead/TGOpen/Copy |
| `functions/api/meta/capi.js` | CAPI proxy for Contact/Lead/CTA_Click/etc |
| `functions/api/meta/qualified-lead.js` | Manual QualifiedLead (`x-altyn-admin-secret`) |
| `functions/api/telegram/qualified-intent.js` | QualifiedLead from NextBot (`x-altyn-intent-secret`) |
| `functions/api/lead-attribution.js` | Saves UTM mapping by lead_id in KV |
| `wrangler.toml` | Documents Cloudflare bindings (env vars + KV) |
| `_headers`, `robots.txt` | noindex / no-cache for sensitive paths |

## Переменные окружения (Cloudflare Pages → Settings → Environment variables)

Обе среды (Production + Preview):

| Переменная | Обязательна | Описание |
|---|---|---|
| `META_PIXEL_ID` | ✅ | `2475663283169925` |
| `META_CAPI_ACCESS_TOKEN` | ✅ | Access Token из Events Manager → Conversions API |
| `META_TEST_EVENT_CODE` | ⚙️ только на время тестов | Удалить после ввода в продакшн |
| `ADMIN_SECRET` | ✅ | Длинный random для `/api/meta/qualified-lead` |
| `INTENT_SECRET` | ⭐ рекомендуется | Длинный random для `/api/telegram/qualified-intent` (отдельный от ADMIN, чтобы давать NextBot отдельный токен). Если не задан — используется `ADMIN_SECRET`. |
| `TELEGRAM_BOT_TOKEN` | ✅ | Токен @altyndirectbot. Нужен для отправки уведомлений в группу. |
| `TELEGRAM_WEBHOOK_SECRET` | ⚙️ | Зарезервирован на случай, если когда-то будем брать webhook на себя (сейчас на NextBot). |
| `TELEGRAM_NOTIFY_CHAT_ID` | ✅ | `-1003406252597` |

**KV namespace bindings**:

| Binding | KV namespace | Назначение |
|---|---|---|
| `LEAD_ATTRIBUTION` | `ALTYN_LEAD_ATTRIBUTION` | `lead:<id>` (30d TTL) + `qualified:<id>` (24h dedupe) |

### Как привязать KV к Cloudflare Pages

**KV namespace УЖЕ создан** (через API):
* Title: `ALTYN_LEAD_ATTRIBUTION`
* ID: `0f8fa30a18af4c799029f4df18b8d6d7`
* Read/write верифицированы.

Что осталось сделать **руками** в Cloudflare Dashboard (~30 секунд):

1. Pages → **altyn-therapy** → Settings → Functions → **KV namespace bindings** → **Add binding**:
   * Variable name: `LEAD_ATTRIBUTION`
   * KV namespace: `ALTYN_LEAD_ATTRIBUTION` (выбрать из списка)
   * Сделать для **Production** И **Preview**.
2. После добавления — следующий деплой подхватит binding автоматически. Или нажать **Retry deployment** на последнем деплое.

Если KV не настроен — bridge всё равно работает (Contact/Lead уходят с полным UTM), но QualifiedLead не сможет восстановить UTM по `lead_id`. То есть Meta получит QualifiedLead без UTM — это допустимо, но менее ценно.

## Карта событий

| event_name | Trigger | Browser | CAPI | event_id key | dedupe |
|---|---|---|---|---|---|
| `PageView` | каждая страница | ✅ | — | — | — |
| `ViewContent` | landing, ~1.5s | ✅ | ✅ | `landing_viewcontent` | sessionStorage |
| `LandingQualifiedView` | 8s или scroll ≥ 35% | ✅ custom | ✅ | `landing_qualified_view` | 1×/сессию |
| `CTA_Click` | клик Telegram CTA | ✅ custom | ✅ | `click_<text>_<loc>_<ts>` | 800ms rate-limit |
| `Contact` | загрузка /go/telegram | ✅ | ✅ | `bridge_contact` | 1×/сессию (флаг) |
| `TelegramOpenAttempt` | auto deep-link / fallback btn | ✅ custom | ✅ | `tg_open_attempt_<method>` | 1×/метод/сессию |
| `Lead` | при TGOpenAttempt | ✅ | ✅ | `tg_lead` | 1×/сессию (флаг `lead_sent`) |
| `CopyLeadPhrase` | клик «Скопировать фразу» | ✅ custom | ✅ | `copy_phrase` | — |
| `QualifiedLead` | NextBot/менеджер/CRM вызов | — | ✅ | `qualified_<lead_id>_<ts>` | KV `qualified:<lead_id>` 24h |

Все Browser+Server события используют один `event_id` для Meta-дедупликации.

## Custom Conversions (создать в Events Manager)

1. **Telegram Contact** — `Event = Contact` AND `URL contains /go/telegram` → Category: Contact
2. **Telegram Lead** — `Event = Lead` AND `URL contains /go/telegram` → Category: Lead
3. **Qualified Telegram Lead** — `Event = QualifiedLead` → Category: Lead
4. **Copy Phrase Intent** — `Event = CopyLeadPhrase` → Category: Contact

### Что выбрать как Optimization event в Ads Manager

* QualifiedLead ≥ 15–30 в неделю → **Qualified Telegram Lead** (главная цель)
* Иначе → **Telegram Lead**
* Если Lead нестабилен → **Telegram Contact**
* **НЕ** оптимизироваться на PageView / ViewContent / простой клик.

## Как вызвать `/api/telegram/qualified-intent` из NextBot

Конфигурация в NextBot (или CRM, или менеджерский скрипт):

```http
POST https://www.altyn-therapy.uz/api/telegram/qualified-intent
Content-Type: application/json
x-altyn-intent-secret: <INTENT_SECRET>

{
  "lead_id": "l_xxxxxx_yyyyy",
  "telegram_user_id": 123456789,
  "telegram_username": "username_optional",
  "telegram_first_name": "Имя",
  "action": "want_diagnostic",
  "action_source": "business_messaging"
}
```

Ответ (успешный):
```json
{
  "ok": true,
  "event_id": "qualified_l_xxxxxx_yyyyy_1700000000",
  "lead_id": "l_xxxxxx_yyyyy",
  "dedupe": "kv_clean",
  "attribution_used": true,
  "capi": { "status": 200, "ok": true },
  "notify": { "ok": true, "telegram_ok": true, "error": null }
}
```

Дубль того же `lead_id` в течение 24 часов возвращает:
```json
{ "ok": true, "already_sent": true, "lead_id": "...", "sent_at": "ISO timestamp" }
```

### Триггеры QualifiedLead (на стороне NextBot)

* Button press: «Хочу разбор за 10$»
* Keyword match (case-insensitive, в первом сообщении пользователя):
  `разбор`, `хочу разбор`, `10$`, `10`, `сценарий`, `отношения`,
  `консультация`, `записаться`, `хочу к Алтын`, `как записаться`

**Никогда** не передавайте в этот endpoint текст переписки или
психологическую информацию пользователя — только структурированную атрибуцию.

## Ручной QualifiedLead (Алтын / менеджер)

```bash
curl -X POST https://altyn-therapy.uz/api/meta/qualified-lead \
  -H "content-type: application/json" \
  -H "x-altyn-admin-secret: $ADMIN_SECRET" \
  -d '{
    "lead_id": "l_xxxxxx_yyyyy",
    "telegram_user_id": 123456789,
    "telegram_username": "username",
    "action": "want_diagnostic"
  }'
```

Если `lead_id` не передан — событие тоже отправится, но без серверного UTM enrichment (только то, что в `custom_data`).

## Production readiness — чеклист

### Уже сделано автоматически
- ✅ Pixel один (id `2475663283169925`), guard `window.__ALTYN_PIXEL_INITED__`
- ✅ Все hardcoded `t.me/Altyn2304` в React-bundle переписываются на `/go/telegram` через MutationObserver в `altyn-pixel.js`
- ✅ Bridge ведёт на `@altyndirectbot?start=<lead_id>`
- ✅ `lead_id` сохраняется в KV перед редиректом
- ✅ Telegram bot можно postить в notify-группу (проверено)
- ✅ Cloudflare KV namespace `ALTYN_LEAD_ATTRIBUTION` создан (id `0f8fa30a18af4c799029f4df18b8d6d7`)
- ✅ PR открыт: https://github.com/braindiggeruz/altyn-therapy/pull/1
- ✅ Secret scan: токены не в репо

### Ручные шаги (P0)

#### 1. Merge PR + дождаться деплоя
1. Открыть PR: https://github.com/braindiggeruz/altyn-therapy/pull/1
2. Squash & merge (или обычный merge — в репе только эти 2 коммита)
3. Cloudflare Pages автоматически задеплоит. Дождаться (~30–60 сек)
4. Проверить: `curl -I https://www.altyn-therapy.uz/go/telegram/` → 200, ответ должен быть нашим bridge HTML (не SPA fallback). В body должно быть `Открываем Telegram…` и `altyn-bridge.js`

#### 2. Привязать KV к Pages project
Cloudflare Dashboard → Pages → **altyn-therapy** → Settings → Functions → **KV namespace bindings** → **Add binding**:
* Variable name: `LEAD_ATTRIBUTION`
* KV namespace: `ALTYN_LEAD_ATTRIBUTION`
* Production + Preview обе среды
* Save → Retry deployment / новый deploy

#### 3. Добавить недостающие env vars
Cloudflare → Pages → altyn-therapy → Settings → Environment variables (Production + Preview):

| Имя | Значение |
|---|---|
| `TELEGRAM_BOT_TOKEN` | (ваш токен @altyndirectbot — храните как **Encrypted**) |
| `TELEGRAM_NOTIFY_CHAT_ID` | `-1003406252597` |
| `INTENT_SECRET` | сгенерировать 32+ random байт (например `openssl rand -hex 32`) — **Encrypted** |
| `TELEGRAM_WEBHOOK_SECRET` | сгенерировать random 32+ байт — **Encrypted** (резерв) |
| `META_TEST_EVENT_CODE` | (только на время тестов, потом удалить) |

#### 4. NextBot → outgoing webhook
В админке NextBot настроить outgoing webhook / automation:
* URL: `https://www.altyn-therapy.uz/api/telegram/qualified-intent`
* Method: POST
* Header: `x-altyn-intent-secret: <INTENT_SECRET>`
* Header: `content-type: application/json`
* Body (template):
  ```json
  {
    "lead_id": "{{message.text после /start или сохранённое из истории}}",
    "telegram_user_id": "{{user.id}}",
    "telegram_username": "{{user.username}}",
    "telegram_first_name": "{{user.first_name}}",
    "action": "want_diagnostic"
  }
  ```
* Триггеры (любой из):
  * Нажата inline-кнопка с текстом `Хочу разбор за 10$`
  * Сообщение пользователя содержит (case-insensitive): `разбор`, `хочу разбор`, `10$`, `сценарий`, `отношения`, `консультация`, `записаться`, `хочу к Алтын`, `как записаться`
* НЕ вызывать на `/start` без явного intent.

Если NextBot не поддерживает outgoing webhook — оставить QualifiedLead manual-only (через `/api/meta/qualified-lead` с `x-altyn-admin-secret`). Меня можно вернуть к этому в любой момент.

#### 5. Meta Events Manager: Test Events
1. Открыть Events Manager → Test Events → скопировать test code (формат `TEST12345`)
2. Задать `META_TEST_EVENT_CODE` в Cloudflare (Production+Preview) → wait redeploy
3. Открыть в браузере с тест-UTM:
   `https://www.altyn-therapy.uz/?utm_source=facebook&utm_campaign=ladder_test&utm_content=adset_x&utm_term=creative_y&fbclid=TEST_FBCLID_123`
4. Ожидаемая лестница:
   * Landing: `PageView → ViewContent → LandingQualifiedView` (через 8 c) → клик CTA → `CTA_Click`
   * Bridge: `PageView → Contact → TelegramOpenAttempt → Lead`
   * Клик «Скопировать фразу»: `CopyLeadPhrase`
   * После /start в боте → NextBot trigger → `QualifiedLead`
5. Все Contact/Lead должны быть в Test Events с пометкой `Browser + Server (Deduplicated)`
6. **Удалить `META_TEST_EVENT_CODE`** из Cloudflare после успешной проверки

#### 6. Создать недостающие Custom Conversions в Events Manager
(уже создана **Telegram Lead - Go Telegram** — это №2)

| # | Имя | Event | Filter | Category |
|---|---|---|---|---|
| 1 | Telegram Contact | `Contact` | URL contains `/go/telegram` | Contact |
| 2 | ✅ Telegram Lead — есть | `Lead` | URL contains `/go/telegram` | Lead |
| 3 | Qualified Telegram Lead | `QualifiedLead` | (без URL фильтра) | Lead |
| 4 | Copy Phrase Intent | `CopyLeadPhrase` | (без URL фильтра) | Contact |

#### 7. Ads Manager — текущий optimization event
* Сейчас → **Telegram Lead - Go Telegram** (уже активна)
* Когда накопится 15–30 QualifiedLead/неделю → переключить на **Qualified Telegram Lead**
* НЕ оптимизироваться на PageView/ViewContent/CTR.

#### 8. Devices smoke-test (ручной)
После merge + KV binding пройти:
* Android Chrome — клик CTA, попасть на bridge, дойти до бота, `/start <lead_id>` виден
* Android Instagram in-app — кнопка «Открыть Telegram» работает; deeplink требует тапа
* Android Facebook in-app — то же
* iPhone Safari — auto-deeplink работает
* iPhone Instagram in-app — тап на кнопку
* iPhone Facebook in-app — тап на кнопку
* Desktop Chrome — открывается web.telegram.org

#### 9. Security cleanup (после успешного теста)
- Ротировать TELEGRAM_BOT_TOKEN через @BotFather (`/token` → выбрать @altyndirectbot → `/revoke`) и обновить в Cloudflare
- Ротировать Cloudflare API token (Profile → API Tokens → Roll)
- Отозвать GitHub PAT (если ещё не сделано)
- Удалить `META_TEST_EVENT_CODE` из Cloudflare

## Запреты, которых код придерживается

* ❌ Второй Pixel — нет, проверяется `window.__ALTYN_PIXEL_INITED__`.
* ❌ Hardcoded токены во frontend — нет.
* ❌ `Purchase` / `InitiateCheckout` без оплаты — нет.
* ❌ PII / диагнозы / текст переписки в Meta — никогда.
* ❌ Lead-дубль auto-open + fallback button — нет (`lead_sent` flag).
* ❌ QualifiedLead-дубль за 24ч — нет (`qualified:<lead_id>` KV key).
* ❌ Перезапись чужого Telegram webhook — нет.

## Что ещё можно улучшить (P2 backlog)

* Когда NextBot устаканится — настроить его outgoing webhook на наш `/api/telegram/qualified-intent`.
* D1 + admin UI для просмотра атрибуции и истории QualifiedLead.
* Перенос webhook на свой Cloudflare endpoint, если NextBot откажет.
* A/B на bridge: instant auto-redirect vs phrase 2s pause.
