/**
 * Altyn Therapy — Manual QualifiedLead endpoint
 * ---------------------------------------------------------------------
 * Endpoint: POST /api/meta/qualified-lead
 *
 * Used by Altyn / a manager / future Telegram bot to mark a real,
 * intent-confirmed lead from Telegram and forward QualifiedLead to Meta
 * Conversions API.
 *
 * Auth: shared secret in request header `x-altyn-admin-secret` matching
 *       env var ADMIN_SECRET. No public access.
 *
 * Env vars:
 *   META_PIXEL_ID            (required)
 *   META_CAPI_ACCESS_TOKEN   (required)
 *   META_TEST_EVENT_CODE     (optional)
 *   ADMIN_SECRET             (required) — long random string
 *
 * Privacy rules:
 *   - No message text, no diagnosis, no health/intimate content
 *   - email/phone optional and ONLY hashed SHA-256 lowercase before send
 *   - external_id optional, treated as opaque user reference
 */

const ALLOWED_CUSTOM_KEYS = new Set([
  'content_name', 'content_category',
  'offer_name', 'value', 'currency',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'fbclid', 'traffic_source',
  'lead_quality', 'lead_source', 'lead_type', 'contact_channel',
  'destination',
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

function isHashed(s) {
  return typeof s === 'string' && /^[a-f0-9]{64}$/i.test(s);
}

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

  const eventId = (payload.event_id || `altyn_qlead_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`).slice(0, 120);
  const eventTime = Number.isFinite(payload.event_time)
    ? Math.floor(payload.event_time)
    : Math.floor(Date.now() / 1000);

  const actionSource = payload.action_source === 'website' ? 'website' : 'business_messaging';

  const userData = {};
  if (typeof payload.client_user_agent === 'string') userData.client_user_agent = payload.client_user_agent.slice(0, 500);
  if (typeof payload.fbp === 'string' && payload.fbp) userData.fbp = payload.fbp.slice(0, 200);
  if (typeof payload.fbc === 'string' && payload.fbc) userData.fbc = payload.fbc.slice(0, 200);
  if (typeof payload.external_id === 'string' && payload.external_id) {
    // hash external_id too so we never store raw user ids in Meta
    userData.external_id = isHashed(payload.external_id)
      ? payload.external_id.toLowerCase()
      : await sha256Hex(payload.external_id.trim().toLowerCase());
  }
  if (typeof payload.email === 'string' && payload.email) {
    userData.em = isHashed(payload.email)
      ? payload.email.toLowerCase()
      : await sha256Hex(payload.email.trim().toLowerCase());
  }
  if (typeof payload.phone === 'string' && payload.phone) {
    const digits = payload.phone.replace(/\D/g, '');
    if (digits.length >= 7) {
      userData.ph = isHashed(payload.phone)
        ? payload.phone.toLowerCase()
        : await sha256Hex(digits);
    }
  }

  const baseCustom = sanitizeCustomData(payload.custom_data || {});
  const customData = Object.assign({
    content_name: 'qualified_telegram_lead',
    offer_name: 'scenario_diagnostic_10usd',
    lead_quality: 'qualified',
    lead_source: 'telegram',
    contact_channel: 'telegram',
    destination: 'Altyn2304',
    value: 10,
    currency: 'USD',
  }, baseCustom);

  const event = {
    event_name: 'QualifiedLead',
    event_time: eventTime,
    event_id: eventId,
    action_source: actionSource,
    user_data: userData,
    custom_data: customData,
  };
  if (typeof payload.event_source_url === 'string') {
    event.event_source_url = payload.event_source_url.slice(0, 500);
  }

  const body = { data: [event] };
  if (TEST_EVENT_CODE) body.test_event_code = TEST_EVENT_CODE;

  const url = `https://graph.facebook.com/v19.0/${encodeURIComponent(PIXEL_ID)}/events?access_token=${encodeURIComponent(ACCESS_TOKEN)}`;

  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return jsonResponse({ ok: false, error: 'capi_fetch_failed' }, 502);
  }

  const text = await resp.text();
  let metaBody;
  try { metaBody = JSON.parse(text); } catch { metaBody = { raw: text.slice(0, 500) }; }

  if (!resp.ok) {
    return jsonResponse({ ok: false, status: resp.status, meta: metaBody }, 502);
  }
  return jsonResponse({ ok: true, event_id: eventId, meta: metaBody });
}

export async function onRequestGet() {
  return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405);
}
