/**
 * Altyn Therapy — Lead Attribution KV writer
 * ---------------------------------------------------------------------
 * Endpoint: POST /api/lead-attribution
 *
 * Called from the /go/telegram bridge BEFORE the user is redirected to
 * the Telegram bot. Saves UTM / fbclid / _fbp / _fbc / event_ids by
 * lead_id, so later the bot side (NextBot outgoing webhook, manager,
 * or future own webhook) can call /api/telegram/qualified-intent with
 * just the lead_id and we recover the full ad attribution server-side.
 *
 * Bindings required:
 *   - KV namespace bound as LEAD_ATTRIBUTION (key: `lead:<lead_id>`)
 * If the binding is missing we return 200 ok=false silently — the
 * browser already fired Contact/Lead with full UTM in custom_data, so
 * Meta gets the signal regardless. KV only enriches QualifiedLead.
 *
 * Privacy: this endpoint must NEVER store free-form text, message
 * content, names, contact info, psychological problems, etc.
 * Only structured tracking metadata.
 */

const LEAD_ID_RE = /^[A-Za-z0-9_-]{6,40}$/;
const SAFE_STR_RE = /^[\u0020-\u007e\u00a0-\u04ff]{0,200}$/;
const TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

const ALLOWED_KEYS = new Set([
  'lead_id', 'payload',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'fbclid', '_fbp', '_fbc',
  'landing_page', 'referrer',
  'cta_location', 'adset_code', 'creative_code',
  'contact_event_id', 'lead_event_id',
]);

function sanitize(input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;
  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.has(key)) continue;
    const v = input[key];
    if (v === null || v === undefined) continue;
    if (typeof v !== 'string') continue;
    const cleaned = v.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 300);
    if (key === 'lead_id' || key === 'payload') {
      if (LEAD_ID_RE.test(cleaned)) out[key] = cleaned;
    } else if (key === 'landing_page' || key === 'referrer') {
      // URLs can have more characters; allow up to 500
      out[key] = cleaned.slice(0, 500);
    } else if (SAFE_STR_RE.test(cleaned) || /^[\w.:/?=&%+\-_,;~#@!$()*'"\s]*$/.test(cleaned)) {
      out[key] = cleaned;
    }
  }
  return out;
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

  let payload;
  try { payload = await request.json(); }
  catch { return jsonResponse({ ok: false, error: 'invalid_json' }, 400); }

  const clean = sanitize(payload);
  const leadId = clean.lead_id;
  if (!leadId) return jsonResponse({ ok: false, error: 'lead_id_required_or_invalid' }, 400);

  // If KV binding is not configured, do not fail the user flow.
  if (!env.LEAD_ATTRIBUTION || typeof env.LEAD_ATTRIBUTION.put !== 'function') {
    return jsonResponse({ ok: false, error: 'kv_not_configured', lead_id: leadId });
  }

  const nowIso = new Date().toISOString();
  const record = Object.assign({}, clean, {
    created_at: nowIso,
    expires_at: new Date(Date.now() + TTL_SECONDS * 1000).toISOString(),
    user_agent: (request.headers.get('user-agent') || '').slice(0, 300),
    client_ip: request.headers.get('cf-connecting-ip') || '',
  });

  try {
    await env.LEAD_ATTRIBUTION.put(
      'lead:' + leadId,
      JSON.stringify(record),
      { expirationTtl: TTL_SECONDS }
    );
  } catch (e) {
    return jsonResponse({ ok: false, error: 'kv_put_failed' }, 502);
  }

  return jsonResponse({ ok: true, lead_id: leadId, payload: clean.payload || leadId, ttl_seconds: TTL_SECONDS });
}

export async function onRequestGet() {
  return jsonResponse({ ok: false, error: 'method_not_allowed' }, 405);
}
