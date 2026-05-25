/**
 * Altyn Therapy — Manual QualifiedLead endpoint
 * ---------------------------------------------------------------------
 * Endpoint: POST /api/meta/qualified-lead
 *
 * Used by:
 *   - Altyn / a manager flagging a real intent-confirmed lead manually
 *   - Future Telegram bot webhook (own server)
 *   - Future CRM webhook
 *
 * Auth: `x-altyn-admin-secret` header matching env ADMIN_SECRET.
 *
 * Behaviour:
 *   - If `lead_id` is provided AND a KV record `lead:<lead_id>` exists,
 *     UTM / fbp / fbc / source_url are recovered from KV.
 *   - Dedupes via KV `qualified:<lead_id>` (TTL 24h) when available.
 *   - Fires QualifiedLead to Meta Conversions API.
 *   - Optionally notifies TELEGRAM_NOTIFY_CHAT_ID.
 *
 * Privacy: NEVER forward to Meta any free-form text, message content,
 * diagnosis, intimate/health data, or names. Only structured tracking
 * metadata. email/phone (if ever passed) are SHA-256 hashed.
 */

const META_GRAPH_API = 'https://graph.facebook.com/v19.0';
const QUALIFIED_TTL = 60 * 60 * 24; // 24h dedupe window

const ALLOWED_CUSTOM_KEYS = new Set([
  'content_name', 'content_category',
  'offer_name', 'value', 'currency',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'fbclid', 'traffic_source',
  'lead_quality', 'lead_source', 'lead_type', 'contact_channel',
  'destination', 'lead_id',
]);

function sanitizeCustomData(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const key of Object.keys(input)) {
    if (!ALLOWED_CUSTOM_KEYS.has(key)) continue;
    const v = input[key];
    if (v === null || v === undefined) continue;
    if (typeof v === 'string') {
      out[key] = v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[key] = v;
    }
  }
  return out;
}

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function isHashed(s) { return typeof s === 'string' && /^[a-f0-9]{64}$/i.test(s); }

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function notifyAltyn(env, payload, source) {
  const TOKEN = env.TELEGRAM_BOT_TOKEN;
  const CHAT = env.TELEGRAM_NOTIFY_CHAT_ID;
  if (!TOKEN || !CHAT) return { ok: false, skipped: true };
  const lines = ['🔥 Новый целевой лид ALTYN Therapy', ''];
  if (payload.campaign) lines.push('Campaign: ' + String(payload.campaign).slice(0, 80));
  if (payload.adset) lines.push('Adset: ' + String(payload.adset).slice(0, 80));
  if (payload.creative) lines.push('Creative: ' + String(payload.creative).slice(0, 80));
  if (payload.lead_id) lines.push('Lead ID: ' + String(payload.lead_id).slice(0, 60));
  if (payload.telegram_username) lines.push('Telegram: @' + String(payload.telegram_username).slice(0, 50));
  if (payload.telegram_user_id) lines.push('user_id: ' + String(payload.telegram_user_id).slice(0, 30));
  lines.push('');
  lines.push('Действие: ' + (payload.action || 'хочет разбор за 10$'));
  lines.push('Статус: QualifiedLead');
  lines.push('Источник: ' + source);
  lines.push('Время: ' + new Date().toISOString());
  try {
    const r = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: CHAT, text: lines.join('\n'), disable_web_page_preview: true }),
    });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok && j.ok, telegram_ok: j.ok };
  } catch (e) { return { ok: false, error: 'telegram_send_failed' }; }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const PIXEL_ID = env.META_PIXEL_ID;
  const ACCESS_TOKEN = env.META_CAPI_ACCESS_TOKEN;
  const ADMIN_SECRET = env.ADMIN_SECRET;
  const TEST_EVENT_CODE = env.META_TEST_EVENT_CODE || '';

  if (!PIXEL_ID || !ACCESS_TOKEN || !ADMIN_SECRET) {
    return jsonResponse({ ok: false, error: 'endpoint_not_configured' }, 503);
  }

  const provided = request.headers.get('x-altyn-admin-secret') || '';
  if (!timingSafeEqual(provided, ADMIN_SECRET)) {
    return jsonResponse({ ok: false, error: 'unauthorized' }, 401);
  }

  let payload;
  try { payload = await request.json(); }
  catch { return jsonResponse({ ok: false, error: 'invalid_json' }, 400); }

  // Optional KV lookup by lead_id
  const leadId = typeof payload.lead_id === 'string' && /^[A-Za-z0-9_-]{4,60}$/.test(payload.lead_id)
    ? payload.lead_id : null;
  const kv = env.LEAD_ATTRIBUTION;
  let attr = {};
  let dedupeNote = 'no_lead_id';

  if (leadId && kv && typeof kv.get === 'function') {
    try {
      const dup = await kv.get('qualified:' + leadId);
      if (dup) {
        return jsonResponse({ ok: true, already_sent: true, lead_id: leadId, sent_at: dup });
      }
      const raw = await kv.get('lead:' + leadId);
      if (raw) attr = JSON.parse(raw);
      dedupeNote = 'kv_clean';
    } catch (e) { dedupeNote = 'kv_read_error'; }
  }

  const eventId = (payload.event_id || `qualified_${leadId || 'manual'}_${Math.floor(Date.now() / 1000)}_${Math.random().toString(36).slice(2, 8)}`).slice(0, 120);
  const eventTime = Number.isFinite(payload.event_time)
    ? Math.floor(payload.event_time)
    : Math.floor(Date.now() / 1000);
  const actionSource = payload.action_source === 'website' ? 'website' : 'business_messaging';

  const userData = {};
  if (typeof payload.client_user_agent === 'string') userData.client_user_agent = payload.client_user_agent.slice(0, 500);
  if (attr.user_agent) userData.client_user_agent = attr.user_agent;
  if (attr.client_ip) userData.client_ip_address = attr.client_ip;
  if (attr._fbp) userData.fbp = attr._fbp;
  if (attr._fbc) userData.fbc = attr._fbc;
  if (typeof payload.fbp === 'string' && payload.fbp) userData.fbp = payload.fbp.slice(0, 200);
  if (typeof payload.fbc === 'string' && payload.fbc) userData.fbc = payload.fbc.slice(0, 200);
  if (typeof payload.external_id === 'string' && payload.external_id) {
    userData.external_id = isHashed(payload.external_id)
      ? payload.external_id.toLowerCase()
      : await sha256Hex(payload.external_id.trim().toLowerCase());
  }
  if (payload.telegram_user_id != null) {
    userData.external_id = await sha256Hex('tg:' + String(payload.telegram_user_id));
  }
  if (typeof payload.email === 'string' && payload.email) {
    userData.em = isHashed(payload.email) ? payload.email.toLowerCase() : await sha256Hex(payload.email.trim().toLowerCase());
  }
  if (typeof payload.phone === 'string' && payload.phone) {
    const digits = payload.phone.replace(/\D/g, '');
    if (digits.length >= 7) {
      userData.ph = isHashed(payload.phone) ? payload.phone.toLowerCase() : await sha256Hex(digits);
    }
  }

  const baseCustom = sanitizeCustomData(payload.custom_data || {});
  // Merge attribution from KV (only if not overridden by caller)
  ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','fbclid'].forEach(k => {
    if (!baseCustom[k] && attr[k]) baseCustom[k] = String(attr[k]).slice(0, 200);
  });

  const customData = Object.assign({
    content_name: 'qualified_telegram_lead',
    offer_name: 'scenario_diagnostic_10usd',
    lead_quality: 'qualified',
    lead_source: 'telegram_bot',
    contact_channel: 'telegram_bot',
    destination: 'Altyn2304',
    value: 10,
    currency: 'USD',
  }, baseCustom);
  if (leadId) customData.lead_id = leadId;

  const event = {
    event_name: 'QualifiedLead',
    event_time: eventTime,
    event_id: eventId,
    action_source: actionSource,
    user_data: userData,
    custom_data: customData,
  };
  const srcUrl = (typeof payload.event_source_url === 'string' && payload.event_source_url) || attr.landing_page;
  if (srcUrl) event.event_source_url = String(srcUrl).slice(0, 500);

  const body = { data: [event] };
  if (TEST_EVENT_CODE) body.test_event_code = TEST_EVENT_CODE;

  const url = `${META_GRAPH_API}/${encodeURIComponent(PIXEL_ID)}/events?access_token=${encodeURIComponent(ACCESS_TOKEN)}`;
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return jsonResponse({ ok: false, error: 'capi_fetch_failed' }, 502);
  }
  const text = await resp.text();
  let metaBody;
  try { metaBody = JSON.parse(text); } catch { metaBody = { raw: text.slice(0, 500) }; }

  // Persist 24h dedupe key on success
  if (resp.ok && leadId && kv && typeof kv.put === 'function') {
    try { await kv.put('qualified:' + leadId, new Date().toISOString(), { expirationTtl: QUALIFIED_TTL }); }
    catch (e) {}
  }

  // Best-effort notification
  let notify = { ok: false, skipped: true };
  try {
    notify = await notifyAltyn(env, {
      campaign: customData.utm_campaign,
      adset: customData.utm_content,
      creative: customData.utm_term,
      lead_id: leadId,
      telegram_username: payload.telegram_username,
      telegram_user_id: payload.telegram_user_id,
      action: payload.action,
    }, payload.source || 'manual_admin');
  } catch (e) {}

  if (!resp.ok) return jsonResponse({ ok: false, status: resp.status, meta: metaBody, lead_id: leadId, dedupe: dedupeNote }, 502);
  return jsonResponse({ ok: true, event_id: eventId, lead_id: leadId, dedupe: dedupeNote, meta: metaBody, notify: { ok: !!notify.ok, telegram_ok: notify.telegram_ok || null, error: notify.error || null } });
}

export async function onRequestGet() {
  return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405);
}
