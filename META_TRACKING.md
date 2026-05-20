# Meta Pixel + Conversions API — Altyn Therapy

Документация по событийной разметке, серверному CAPI и развёртыванию.

## Архитектура

```
                ┌─────────────────────────┐
   Meta Ad ───► │ altyn-therapy.uz/?utm…  │   (landing)
                │   • PageView            │
                │   • ViewContent         │
                │   • LandingQualifiedView│
                │   • CTA_Click           │
                └────────────┬────────────┘
                             │ click
                             ▼
                ┌─────────────────────────┐
                │ /go/telegram?utm…       │   (bridge, noindex)
                │   • PageView            │
                │   • Contact (br+srv)    │
                │   • TelegramOpenAttempt │
                │   • Lead (br+srv)       │  ← dedupe by event_id
                │   • CopyLeadPhrase      │
                └────────────┬────────────┘
                             │ tg://resolve / t.me
                             ▼
                ┌─────────────────────────┐
                │ @Altyn2304 (Telegram)   │
                └────────────┬────────────┘
                             │ manager flags as qualified
                             ▼
                ┌─────────────────────────┐
                │ POST /api/meta/         │   (CAPI, ADMIN_SECRET)
                │      qualified-lead     │
                │ → Meta: QualifiedLead   │
                └─────────────────────────┘
```

## Файлы

| Файл | Назначение |
|---|---|
| `index.html` | Лендинг (загружает `altyn-utm.js` затем `altyn-pixel.js`) |
| `assets/altyn-utm.js` | Захват UTM / fbclid / _fbp / _fbc; helper `window.altynUTM` |
| `assets/altyn-pixel.js` | Pixel init, landing-события, переписывает t.me ссылки на `/go/telegram` |
| `assets/altyn-enhance.js` | Sticky CTA, видео-отзывы — все CTA указывают на `/go/telegram` |
| `go/telegram/index.html` | Bridge-страница (mobile-first, noindex) |
| `assets/altyn-bridge.js` | Логика bridge: Contact / TelegramOpenAttempt / Lead / CopyLeadPhrase |
| `functions/api/meta/capi.js` | Server CAPI proxy для Contact / Lead / etc |
| `functions/api/meta/qualified-lead.js` | Защищённый endpoint для ручного QualifiedLead |
| `_headers` | noindex для `/go/telegram` + кэш-политики |
| `robots.txt` | Disallow `/api/`, `/go/` |

## Переменные окружения (Cloudflare Pages → Settings → Environment variables)

Эти переменные нужны **обеим средам** (Production + Preview):

| Переменная | Обязательна | Описание |
|---|---|---|
| `META_PIXEL_ID` | да | `2475663283169925` |
| `META_CAPI_ACCESS_TOKEN` | да | Access Token из Events Manager → Settings → Conversions API |
| `META_TEST_EVENT_CODE` | нет | Только пока тестируете в Events Manager → Test Events (например `TEST12345`). **Удалите** после ввода в продакшн. |
| `ADMIN_SECRET` | да | Длинный случайный токен. Используется в заголовке `x-altyn-admin-secret` при ручной отправке QualifiedLead. |

> **Никогда** не коммитьте эти значения в репозиторий. Они доступны только серверным функциям (`functions/api/meta/*.js`).

## Карта событий

| event_name | Когда | Browser fbq | Server CAPI | Dedup by event_id |
|---|---|---|---|---|
| `PageView` | каждая страница | ✅ | — | — |
| `ViewContent` | ~1.5s после загрузки лендинга | ✅ | ✅ | landing_viewcontent |
| `LandingQualifiedView` | 8 c на лендинге **или** scroll ≥ 35% | ✅ custom | ✅ | landing_qualified_view |
| `CTA_Click` | клик по любой Telegram-CTA на лендинге | ✅ custom | ✅ | per-click |
| `Contact` | загрузка `/go/telegram` | ✅ | ✅ | bridge_contact |
| `TelegramOpenAttempt` | авто-deeplink или клик «Открыть Telegram» | ✅ custom | ✅ | tg_open_attempt_{method} |
| `Lead` | при `TelegramOpenAttempt` (1 раз на сессию) | ✅ | ✅ | tg_lead |
| `CopyLeadPhrase` | клик «Скопировать фразу» | ✅ custom | ✅ | copy_phrase |
| `QualifiedLead` | вручную / через бот в будущем | — | ✅ | client-generated |

### Custom Conversions, которые нужно создать в Events Manager

1. **Telegram Contact** — `Event = Contact` AND `URL contains /go/telegram` → Category: Contact
2. **Telegram Lead** — `Event = Lead` AND `URL contains /go/telegram` → Category: Lead
3. **Qualified Telegram Lead** — `Event = QualifiedLead` → Category: Lead
4. **Copy Phrase Intent** — `Event = CopyLeadPhrase` → Category: Lead (не использовать как основной optimization event пока не накопится статистика)

### Что выбрать в Ads Manager как Optimization Event

* Если QualifiedLead ≥ 15–30 в неделю → **QualifiedLead**
* Иначе → **Telegram Lead** (custom conversion)
* Если Telegram Lead нестабилен → **Contact** (custom conversion)
* **НЕ** оптимизироваться на PageView или простой ViewContent.

## Ручная отправка QualifiedLead

Когда Алтын/менеджер видит в Telegram, что человек **реально** написал и заинтересован:

```bash
curl -sX POST https://altyn-therapy.uz/api/meta/qualified-lead \
  -H "content-type: application/json" \
  -H "x-altyn-admin-secret: $ADMIN_SECRET" \
  -d '{
    "action_source": "business_messaging",
    "custom_data": {
      "utm_source": "facebook",
      "utm_campaign": "scenario_oct2026",
      "utm_content": "creative_a"
    }
  }'
```

Минимально допустимый body: `{}` (тогда отправится только канал/оффер/value).

**Запрещено** отправлять текст переписки, диагнозы, личные данные. Если когда-нибудь будете отправлять email/phone — сервер **уже** SHA-256-хеширует их перед отправкой в Meta.

## Тестирование

### 1. Events Manager → Test Events

1. Получите `TEST12345`-код из Events Manager → Test Events.
2. Установите его в Cloudflare как `META_TEST_EVENT_CODE`.
3. Откройте сайт, проверьте порядок событий:
   * Лендинг: `PageView` → `ViewContent` → `LandingQualifiedView` → `CTA_Click`
   * `/go/telegram`: `PageView` → `Contact` → `TelegramOpenAttempt` → `Lead`
   * Клик «Скопировать фразу»: `CopyLeadPhrase`
4. **Удалите** `META_TEST_EVENT_CODE` после проверки.

### 2. Meta Pixel Helper (Chrome extension)

* На каждой странице должен быть ровно **один** Pixel ID `2475663283169925`.
* На bridge должны видеться `PageView`, `Contact`, через 0.5–1 c — `TelegramOpenAttempt` + `Lead`.

### 3. Устройства/окружения

Обязательно проверить:

* Android Chrome
* Android Instagram in-app browser
* Android Facebook in-app browser
* iPhone Safari
* iPhone Instagram / Facebook in-app browser
* Desktop Chrome

В IG/FB in-app browser:
* `tg://` deep-link обычно блокируется — **auto-open отключен**, пользователь должен тапнуть кнопку.
* Кнопка «Открыть Telegram» при этом всё равно срабатывает (anchor target=_blank → t.me/Altyn2304).
* События `TelegramOpenAttempt` + `Lead` фиксируются при тапе на кнопку.

### 4. Дедупликация browser ↔ server

В Events Manager → Diagnostics проверьте, что для `Contact`/`Lead` доля `Browser + Server` (deduplicated) высокая. Если видны `Browser only` без `Server only` пары — значит CAPI токен или endpoint не сработал.

## Запреты, которых код придерживается

* ❌ Второй Pixel — нет, проверяется `window.__ALTYN_PIXEL_INITED__`
* ❌ Hardcoded токены во frontend — нет
* ❌ `Purchase` / `InitiateCheckout` без оплаты — нет
* ❌ PII в Meta — нет; email/phone (если когда-то добавим) пойдут только хэшем SHA-256
* ❌ Текст переписки/диагнозы — никогда
* ❌ Lead-дубль auto-open + fallback button — нет, session-flag `lead_sent`

## Что ещё можно улучшить (будущее)

* Подключить Telegram-бот (`@altyntherapybot`) → авто-распознавание ключевых слов в первом сообщении → авто `QualifiedLead`.
* Перенести `META_PIXEL_ID` в env (сейчас он публичен по дизайну — Pixel ID не секрет).
* Добавить серверный лог запросов в KV/D1 для проверки сходимости с Meta Events Manager.
* A/B тест на bridge: 1) auto-deeplink сразу 2) показывать phrase 2 c и потом редирект.
