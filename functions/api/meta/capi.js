/**
 * Altyn Therapy — Meta Conversions API proxy (Cloudflare Pages Function)
 * ---------------------------------------------------------------------
 * Endpoint: POST /api/meta/capi
 *
 * Accepts a *whitelisted* set of events from the browser and forwards
 * them to Meta Graph API with the same event_id used in the browser
 * pixel call, so Meta can dedupe across Browser + Server channels.
 *
 * Env vars (Cloudflare Pages → Settings → Environment variables):
 *   META_PIXEL_ID            (required) — e.g. 2475663283169925
 *   META_CAPI_ACCESS_TOKEN   (required) — long-lived token from Events Manager
 *   META_TEST_EVENT_CODE     (optional) — for Events Manager → Test Events tab
 *
 * Privacy: we DO NOT forward any free-form text, message content,
 * health/psychological data, names, addresses, etc.
 * Only technical signals + UTM/fbp/fbc/fbclid + offer metadata.
 */

const ALLOWED_EVENTS = new Set([
  'Contact',
  'Lead',
  'TelegramOpenAttempt',
  'CopyLeadPhrase',
  'LandingQualifiedView',
  'CTA_Click',
  'ViewContent',
]);

const ALLOWED_CUSTOM_KEYS = new Set([
  'content_name', 'content_category', 'content_type',
  'offer_name', 'value', 'currency',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'fbclid', 'traffic_source',
  'cta_location', 'cta_text', 'destination', 'contact_channel',
  'method', 'device_type', 'browser_type', 'in_app_browser_detected',
  'lead_type', 'copied_text_type',
  'seconds_on_page', 'scroll_depth',
  'lead_id',
]);

function sanitizeCustomData(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const key of Object.keys(input)) {
    if (!ALLOWED_CUSTOM_KEYS.has(key)) continue;
    const v = input[key];
    if (v === null || v === undefined) continue;
    if (typeof v === 'string') {
      // Truncate any string to a safe length and strip control chars.
      out[key] = v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 200);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      out[key] = v;
    }
  }
  return out;
}

function clientIp(request) {
  return request.headers.get('cf-connecting-ip')
      || request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
      || '';
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
    },
  });
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
    },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const PIXEL_ID = env.META_PIXEL_ID;
  const ACCESS_TOKEN = env.META_CAPI_ACCESS_TOKEN;
  const TEST_EVENT_CODE = env.META_TEST_EVENT_CODE || '';

  if (!PIXEL_ID || !ACCESS_TOKEN) {
    return jsonResponse({ ok: false, error: 'capi_not_configured' }, 503);
  }

  let payload;
  try {
    payload = await request.json();
  } catch (e) {
    return jsonResponse({ ok: false, error: 'invalid_json' }, 400);
  }

  const eventName = payload.event_name;
  if (!eventName || !ALLOWED_EVENTS.has(eventName)) {
    return jsonResponse({ ok: false, error: 'event_not_allowed' }, 400);
  }

  const eventId = (payload.event_id || '').toString().slice(0, 120);
  if (!eventId) {
    return jsonResponse({ ok: false, error: 'event_id_required' }, 400);
  }

  const eventTime = Number.isFinite(payload.event_time)
    ? Math.floor(payload.event_time)
    : Math.floor(Date.now() / 1000);

  const sourceUrl = (payload.event_source_url || request.headers.get('referer') || '')
    .toString()
    .slice(0, 500);

  const actionSource = payload.action_source === 'business_messaging'
    ? 'business_messaging'
    : 'website';

  const userData = {
    client_ip_address: clientIp(request),
    client_user_agent: (request.headers.get('user-agent') || '').slice(0, 500),
  };
  if (typeof payload.fbp === 'string' && payload.fbp) userData.fbp = payload.fbp.slice(0, 200);
  if (typeof payload.fbc === 'string' && payload.fbc) userData.fbc = payload.fbc.slice(0, 200);

  // We intentionally do NOT accept email/phone/name/address from the browser
  // here — those would be PII and we have no consent flow for that yet.

  const customData = sanitizeCustomData(payload.custom_data);

  const event = {
    event_name: eventName,
    event_time: eventTime,
    event_id: eventId,
    event_source_url: sourceUrl,
    action_source: actionSource,
    user_data: userData,
    custom_data: customData,
  };

  const body = { data: [event] };
  if (TEST_EVENT_CODE) body.test_event_code = TEST_EVENT_CODE;

  const url = `https://graph.facebook.com/v19.0/${encodeURIComponent(PIXEL_ID)}/events?access_token=${encodeURIComponent(ACCESS_TOKEN)}`;

  let metaResp;
  try {
    metaResp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return jsonResponse({ ok: false, error: 'capi_fetch_failed' }, 502);
  }

  const text = await metaResp.text();
  let metaBody;
  try { metaBody = JSON.parse(text); } catch { metaBody = { raw: text.slice(0, 500) }; }

  if (!metaResp.ok) {
    return jsonResponse({ ok: false, status: metaResp.status, meta: metaBody }, 502);
  }

  return jsonResponse({
    ok: true,
    event_name: eventName,
    event_id: eventId,
    meta: metaBody,
  });
}
