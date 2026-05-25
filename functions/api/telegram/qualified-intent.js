/**
 * Altyn Therapy — Telegram QualifiedIntent receiver
 * ---------------------------------------------------------------------
 * Endpoint: POST /api/telegram/qualified-intent
 *
 * Designed to be called by:
 *   1. The NextBot GPT platform via its "outgoing webhook" /
 *      automation, when the GPT recognises a qualifying intent in the
 *      Telegram dialog (button "Хочу разбор за 10$" pressed OR keyword
 *      match in the user message).
 *   2. A Telegram bot webhook of our own (future).
 *   3. A manager dashboard / CRM, manually.
 *
 * Auth: shared secret header `x-altyn-intent-secret` matching env
 *       INTENT_SECRET (falls back to ADMIN_SECRET if INTENT_SECRET
 *       is not set, so existing deployments keep working).
 *
 * Behaviour:
 *   - Look up KV `lead:<lead_id>` (if available) for UTM/fbp/fbc.
 *   - Dedupe via KV `qualified:<lead_id>` (TTL 24h) — silently ack
 *     duplicates with already_sent:true.
 *   - Fire QualifiedLead to Meta Conversions API.
 *   - Optionally send a notification message to
 *     TELEGRAM_NOTIFY_CHAT_ID (if TELEGRAM_BOT_TOKEN provided).
 *
 * Privacy rules: NEVER forward to Meta any free-form text, message
 * content, diagnosis, intimate/health data, or names. Only structured
 * tracking metadata.
 */

const ALLOWED_NOTIFY_KEYS = [
  'campaign', 'adset', 'creative', 'payload',
  'telegram_username', 'telegram_user_id', 'telegram_first_name',
  'action', 'status', 'note',
];

const QUALIFIED_TTL = 60 * 60 * 24; // 24h dedupe window
const META_GRAPH_API = 'https://graph.facebook.com/v19.0';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function safeStr(v, max) {
  if (typeof v !== 'string') return null;
  const cleaned = v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, max || 200);
  return cleaned || null;
}

async function sendCapi(env, event) {
  const PIXEL_ID = env.META_PIXEL_ID;
  const TOKEN = env.META_CAPI_ACCESS_TOKEN;
  if (!PIXEL_ID || !TOKEN) return { ok: false, error: 'capi_not_configured' };

  const body = { data: [event] };
  if (env.META_TEST_EVENT_CODE) body.test_event_code = env.META_TEST_EVENT_CODE;

  const url = `${META_GRAPH_API}/${encodeURIComponent(PIXEL_ID)}/events?access_token=${encodeURIComponent(TOKEN)}`;
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, error: 'capi_fetch_failed' };
  }
  const text = await resp.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 500) }; }
  return { ok: resp.ok, status: resp.status, meta: parsed };
}

async function notifyAltyn(env, payload, source) {
  const TOKEN = env.TELEGRAM_BOT_TOKEN;
  const CHAT = env.TELEGRAM_NOTIFY_CHAT_ID;
  if (!TOKEN || !CHAT) return { ok: false, error: 'notify_not_configured' };

  // Compose a notification using ONLY whitelisted keys.
  // Sensitive text is never copied.
  const lines = ['🔥 Новый целевой лид ALTYN Therapy', ''];
  if (payload.campaign) lines.push('Campaign: ' + safeStr(payload.campaign, 80));
  if (payload.adset) lines.push('Adset: ' + safeStr(payload.adset, 80));
  if (payload.creative) lines.push('Creative: ' + safeStr(payload.creative, 80));
  if (payload.payload) lines.push('Payload: ' + safeStr(payload.payload, 60));
  if (payload.lead_id) lines.push('Lead ID: ' + safeStr(payload.lead_id, 60));
  lines.push('');
  if (payload.telegram_username) lines.push('Telegram: @' + safeStr(payload.telegram_username, 50));
  if (payload.telegram_first_name) lines.push('Имя: ' + safeStr(payload.telegram_first_name, 80));
  if (payload.telegram_user_id) lines.push('user_id: ' + safeStr(String(payload.telegram_user_id), 30));
  lines.push('');
  lines.push('Действие: ' + (safeStr(payload.action, 80) || 'хочет разбор за 10$'));
  lines.push('Статус: QualifiedLead');
  lines.push('Источник: ' + source);
  lines.push('Время: ' + new Date().toISOString());

  const text = lines.join('\n');
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT, text: text, disable_web_page_preview: true }),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok && j.ok, status: r.status, telegram_ok: j.ok, telegram_desc: j.description };
  } catch (e) {
    return { ok: false, error: 'telegram_send_failed' };
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // Auth
  const secretExpected = env.INTENT_SECRET || env.ADMIN_SECRET;
  if (!secretExpected) return jsonResponse({ ok: false, error: 'server_secret_not_configured' }, 503);
  const provided = request.headers.get('x-altyn-intent-secret') || request.headers.get('x-altyn-admin-secret') || '';
  if (!timingSafeEqual(provided, secretExpected)) {
    return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
  }

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ ok: false, error: 'invalid_json' }, 400); }

  const leadId = safeStr(body.lead_id, 60);
  if (!leadId || !/^[A-Za-z0-9_-]{4,60}$/.test(leadId)) {
    return jsonResponse({ ok: false, error: 'lead_id_required_or_invalid' }, 400);
  }

  // 24-hour dedupe via KV (best-effort)
  const kv = env.LEAD_ATTRIBUTION;
  let dedupeNote = 'no_kv';
  if (kv && typeof kv.get === 'function') {
    try {
      const dup = await kv.get('qualified:' + leadId);
      if (dup) {
        return jsonResponse({ ok: true, already_sent: true, lead_id: leadId, sent_at: dup });
      }
      dedupeNote = 'kv_clean';
    } catch (e) { dedupeNote = 'kv_read_error'; }
  }

  // Look up attribution
  let attr = {};
  if (kv && typeof kv.get === 'function') {
    try {
      const raw = await kv.get('lead:' + leadId);
      if (raw) attr = JSON.parse(raw);
    } catch (e) { /* keep attr empty */ }
  }

  // Build CAPI event. ONLY structured tracking metadata; no message text.
  const eventId = safeStr(body.event_id, 120) || `qualified_${leadId}_${Math.floor(Date.now() / 1000)}`;
  const eventTime = Number.isFinite(body.event_time) ? Math.floor(body.event_time) : Math.floor(Date.now() / 1000);

  const userData = {
    client_user_agent: safeStr(attr.user_agent, 500) || safeStr(body.client_user_agent, 500) || '',
  };
  if (attr.client_ip) userData.client_ip_address = attr.client_ip;
  if (attr._fbp) userData.fbp = attr._fbp;
  if (attr._fbc) userData.fbc = attr._fbc;

  // external_id (telegram_user_id) — hash if provided
  const tgUid = body.telegram_user_id != null ? String(body.telegram_user_id) : null;
  if (tgUid) userData.external_id = await sha256Hex('tg:' + tgUid);

  const customData = {
    content_name: 'qualified_telegram_lead',
    offer_name: 'scenario_diagnostic_10usd',
    lead_quality: 'qualified',
    lead_source: 'telegram_bot',
    contact_channel: 'telegram_bot',
    destination: 'Altyn2304',
    value: 10,
    currency: 'USD',
    lead_id: leadId,
  };
  // Add UTM if we have them
  ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','fbclid'].forEach(k => {
    const v = safeStr(attr[k], 200);
    if (v) customData[k] = v;
  });
  // Allow caller to override/add adset/creative codes (NextBot GPT may know)
  if (body.adset_code) customData.utm_content = customData.utm_content || safeStr(body.adset_code, 80);
  if (body.creative_code) customData.utm_term = customData.utm_term || safeStr(body.creative_code, 80);

  const event = {
    event_name: 'QualifiedLead',
    event_time: eventTime,
    event_id: eventId,
    action_source: body.action_source === 'website' ? 'website' : 'business_messaging',
    user_data: userData,
    custom_data: customData,
  };
  const srcUrl = safeStr(attr.landing_page, 500) || safeStr(body.event_source_url, 500);
  if (srcUrl) event.event_source_url = srcUrl;

  const capi = await sendCapi(env, event);

  // Best-effort notification — never block CAPI ack on Telegram outage
  let notify = { ok: false, skipped: true };
  try {
    notify = await notifyAltyn(env, {
      campaign: customData.utm_campaign || null,
      adset: customData.utm_content || null,
      creative: customData.utm_term || null,
      payload: leadId,
      lead_id: leadId,
      telegram_username: safeStr(body.telegram_username, 50),
      telegram_user_id: tgUid,
      telegram_first_name: safeStr(body.telegram_first_name, 80),
      action: safeStr(body.action, 80) || 'хочет разбор за 10$',
    }, body.source || 'telegram_bot');
  } catch (e) { notify = { ok: false, error: 'notify_failed' }; }

  // Persist dedupe key only if CAPI succeeded
  if (capi.ok && kv && typeof kv.put === 'function') {
    try {
      await kv.put('qualified:' + leadId, new Date().toISOString(), { expirationTtl: QUALIFIED_TTL });
    } catch (e) { /* swallow */ }
  }

  return jsonResponse({
    ok: !!capi.ok,
    event_id: eventId,
    lead_id: leadId,
    dedupe: dedupeNote,
    attribution_used: Object.keys(attr).length > 0,
    capi: { status: capi.status || null, ok: !!capi.ok },
    notify: { ok: !!notify.ok, telegram_ok: notify.telegram_ok || null, error: notify.error || null },
  }, capi.ok ? 200 : 502);
}

export async function onRequestGet() {
  return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405);
}
