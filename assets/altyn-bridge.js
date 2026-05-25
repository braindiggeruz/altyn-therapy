/* =====================================================================
   Altyn Therapy — /go/telegram bridge logic (Direct DM to Altyn)
   ---------------------------------------------------------------------
   Destination is Altyn's personal Telegram @Altyn2304 (not a bot).
   * Personal Telegram accounts do NOT support /start payloads, so the
     deep-link is a clean tg://resolve?domain=Altyn2304 (no &start=).
   * We STILL generate a short `lead_id` and post UTM/fbclid/_fbp/_fbc to
     /api/lead-attribution to preserve campaign attribution analytics.
     The lead_id is logged server-side; it just isn't passed via Telegram
     start payload anymore.

   Event ladder fired from this page (browser pixel + server CAPI):
     PageView -> Contact -> TelegramOpenAttempt -> Lead -> CopyLeadPhrase
   Lead is deduplicated to one fire per session via sessionStorage flag.
   ===================================================================== */
(function () {
  'use strict';

  var TG_USERNAME = 'Altyn2304';
  var TG_APP_URL = 'tg://resolve?domain=' + TG_USERNAME;
  var TG_WEB_URL = 'https://t.me/' + TG_USERNAME;
  var LEAD_PHRASE = 'Хочу разбор сценария за 10$';
  var OFFER = {
    offer_name: 'scenario_diagnostic_10usd',
    value: 10,
    currency: 'USD'
  };
  var CAPI_ENDPOINT = '/api/meta/capi';
  var ATTRIB_ENDPOINT = '/api/lead-attribution';

  // -------- helpers --------
  function getUTM() {
    try { return (window.altynUTM && window.altynUTM.get()) || {}; } catch (e) { return {}; }
  }
  function getEventId(key) {
    try { return window.altynUTM.getEventId(key); }
    catch (e) { return 'altyn_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10); }
  }

  function shortBase36(n) {
    return Number(n).toString(36).replace(/[^a-z0-9]/g, '').slice(-6);
  }
  function randSegment(len) {
    var alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
    var out = '';
    for (var i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
    return out;
  }
  // Telegram /start payload allows [A-Za-z0-9_-] up to 64 chars. We keep
  // ours short and easy to log: l_<ts>_<rand>.
  function generateLeadId() {
    return 'l_' + shortBase36(Date.now()) + '_' + randSegment(5);
  }

  function getOrCreateLeadId() {
    var k = 'altyn_lead_id_v1';
    try {
      var existing = sessionStorage.getItem(k);
      if (existing && /^l_[a-z0-9_]{6,40}$/.test(existing)) return existing;
      var id = generateLeadId();
      sessionStorage.setItem(k, id);
      return id;
    } catch (e) {
      return generateLeadId();
    }
  }

  function fbqTrack(eventName, params, opts) {
    try {
      if (typeof window.fbq !== 'function') return;
      var p = params || {};
      var o = opts || {};
      var standardEvents = { PageView:1, ViewContent:1, Lead:1, Contact:1, CompleteRegistration:1, Search:1, AddToCart:1, Purchase:1, InitiateCheckout:1, AddPaymentInfo:1, Subscribe:1 };
      var method = standardEvents[eventName] ? 'track' : 'trackCustom';
      if (o.eventID) {
        window.fbq(method, eventName, p, { eventID: o.eventID });
      } else {
        window.fbq(method, eventName, p);
      }
    } catch (e) { /* noop */ }
  }

  function postJSON(endpoint, payload) {
    try {
      var body = JSON.stringify(payload);
      if (typeof fetch === 'function') {
        fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: body,
          keepalive: true,
          credentials: 'omit',
          mode: 'same-origin'
        }).catch(function () {});
        return;
      }
      if (navigator.sendBeacon) {
        navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' }));
      }
    } catch (e) { /* noop */ }
  }

  function detectDevice() {
    var ua = (navigator.userAgent || '').toLowerCase();
    var isIOS = /iphone|ipad|ipod/.test(ua);
    var isAndroid = /android/.test(ua);
    var inIG = /instagram/.test(ua);
    var inFB = /fban|fbav|fb_iab/.test(ua);
    var inTG = /telegram/.test(ua);
    var inLine = /line\//.test(ua);
    var inWeChat = /micromessenger/.test(ua);
    var inAppBrowser = inIG || inFB || inLine || inWeChat;
    var browser = 'other';
    if (/crios/.test(ua)) browser = 'chrome_ios';
    else if (/fxios/.test(ua)) browser = 'firefox_ios';
    else if (/safari/.test(ua) && isIOS) browser = 'safari_ios';
    else if (/chrome/.test(ua)) browser = 'chrome';
    else if (/firefox/.test(ua)) browser = 'firefox';
    else if (/safari/.test(ua)) browser = 'safari';
    return {
      device_type: isIOS ? 'ios' : isAndroid ? 'android' : 'desktop',
      browser_type: browser,
      in_app_browser_detected: inAppBrowser,
      in_app_kind: inIG ? 'instagram' : inFB ? 'facebook' : inLine ? 'line' : inWeChat ? 'wechat' : (inTG ? 'telegram' : null)
    };
  }

  function utmCustom(extra) {
    var u = getUTM();
    var base = {
      utm_source: u.utm_source || null,
      utm_medium: u.utm_medium || null,
      utm_campaign: u.utm_campaign || null,
      utm_content: u.utm_content || null,
      utm_term: u.utm_term || null,
      fbclid: u.fbclid || null,
      traffic_source: u.traffic_source || null,
      offer_name: OFFER.offer_name,
      value: OFFER.value,
      currency: OFFER.currency
    };
    if (extra) Object.keys(extra).forEach(function (k) { base[k] = extra[k]; });
    var clean = {};
    Object.keys(base).forEach(function (k) {
      if (base[k] !== null && base[k] !== undefined && base[k] !== '') clean[k] = base[k];
    });
    return clean;
  }

  function track(eventName, eventKey, extraParams, opts) {
    var u, params, eventId;
    try {
      u = getUTM();
      params = utmCustom(extraParams || {});
      eventId = getEventId(eventKey);
    } catch (e) {
      eventId = 'altyn_fallback_' + Date.now();
      params = extraParams || {};
      u = {};
    }
    try { fbqTrack(eventName, params, { eventID: eventId }); } catch (e) {}

    var serverEvents = { Contact: 1, Lead: 1, TelegramOpenAttempt: 1, CopyLeadPhrase: 1 };
    if (!serverEvents[eventName]) return eventId;
    if (opts && opts.serverSkip) return eventId;

    try {
      postJSON(CAPI_ENDPOINT, {
        event_name: eventName,
        event_id: eventId,
        event_time: Math.floor(Date.now() / 1000),
        event_source_url: window.location.href,
        action_source: 'website',
        fbp: u._fbp || null,
        fbc: u._fbc || null,
        custom_data: params
      });
    } catch (e) {}
    return eventId;
  }

  // -------- session flags (lead dedupe) --------
  var SESSION_FLAGS_KEY = 'altyn_bridge_flags_v1';
  function readFlags() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_FLAGS_KEY) || '{}'); }
    catch (e) { return {}; }
  }
  function setFlag(k, v) {
    var f = readFlags(); f[k] = (v === undefined ? true : v);
    try { sessionStorage.setItem(SESSION_FLAGS_KEY, JSON.stringify(f)); } catch (e) {}
  }

  // -------- lead_id + attribution --------
  var LEAD_ID = getOrCreateLeadId();
  var device = detectDevice();
  var contactEventId = getEventId('bridge_contact');
  var leadEventId = getEventId('tg_lead');

  // Compose Telegram URLs. Personal profile @Altyn2304 does not support
  // /start payloads — keep URLs clean. lead_id is still posted to
  // /api/lead-attribution for campaign attribution.
  function bridgeTgAppUrl() { return TG_APP_URL; }
  function bridgeTgWebUrl() { return TG_WEB_URL; }

  // Update the visible anchor href so the manual button uses lead_id too.
  (function fixOpenButtonHref() {
    function apply() {
      var a = document.getElementById('open-tg');
      if (a) a.setAttribute('href', bridgeTgWebUrl());
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', apply, { once: true });
    } else { apply(); }
  })();

  // Save attribution mapping to KV. If KV binding is missing, the server
  // returns 503/ok:false silently — that's fine, this is best-effort.
  function sendAttribution() {
    var u = getUTM();
    if (readFlags().attribution_sent) return;
    setFlag('attribution_sent');
    postJSON(ATTRIB_ENDPOINT, {
      lead_id: LEAD_ID,
      payload: LEAD_ID,
      utm_source: u.utm_source || null,
      utm_medium: u.utm_medium || null,
      utm_campaign: u.utm_campaign || null,
      utm_content: u.utm_content || null,
      utm_term: u.utm_term || null,
      fbclid: u.fbclid || null,
      _fbp: u._fbp || null,
      _fbc: u._fbc || null,
      landing_page: u.landing_url || (location.origin + '/'),
      referrer: u.referrer || document.referrer || '',
      cta_location: 'bridge',
      adset_code: u.utm_content || null,
      creative_code: u.utm_term || null,
      contact_event_id: contactEventId,
      lead_event_id: leadEventId
    });
  }

  // -------- Step 1: Contact on bridge load --------
  var contactParams = {
    content_name: 'telegram_bot_bridge',
    contact_channel: 'telegram_bot',
    destination: TG_USERNAME,
    device_type: device.device_type,
    browser_type: device.browser_type,
    in_app_browser_detected: device.in_app_browser_detected,
    lead_id: LEAD_ID
  };
  if (!readFlags().contact_sent) {
    track('Contact', 'bridge_contact', contactParams);
    setFlag('contact_sent');
  }
  // Best-effort persistence of UTM mapping by lead_id
  sendAttribution();

  // -------- Step 2: Telegram open attempt + Lead --------
  function fireTelegramOpenAttempt(method) {
    var flags = readFlags();
    var flagKey = 'tg_open_' + method;
    if (flags[flagKey]) return;
    setFlag(flagKey);

    var params = Object.assign({}, contactParams, { method: method });
    track('TelegramOpenAttempt', 'tg_open_attempt_' + method, params);

    if (!flags.lead_sent) {
      setFlag('lead_sent');
      track('Lead', 'tg_lead', {
        content_name: 'telegram_bot_open_lead',
        lead_type: OFFER.offer_name,
        contact_channel: 'telegram_bot',
        destination: TG_USERNAME,
        device_type: device.device_type,
        browser_type: device.browser_type,
        in_app_browser_detected: device.in_app_browser_detected,
        lead_id: LEAD_ID
      });
    }
  }

  function attemptAutoOpen() {
    if (device.in_app_browser_detected) {
      // tg:// is unreliable in IG/FB webview — fire the event but don't navigate.
      fireTelegramOpenAttempt('auto_deeplink');
      return;
    }
    fireTelegramOpenAttempt('auto_deeplink');
    setTimeout(function () {
      try { window.location.href = bridgeTgAppUrl(); } catch (e) {}
    }, 350);
  }

  // -------- Step 3: Bind UI --------
  function onReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else { fn(); }
  }

  onReady(function () {
    var openBtn = document.getElementById('open-tg');
    var copyBtn = document.getElementById('copy-phrase');
    var copyLabel = document.getElementById('copy-label');

    if (openBtn) {
      openBtn.setAttribute('href', bridgeTgWebUrl());
      openBtn.addEventListener('click', function () {
        fireTelegramOpenAttempt('fallback_button');
      });
    }

    if (copyBtn && copyLabel) {
      copyBtn.addEventListener('click', function () {
        var done = function (ok) {
          copyBtn.classList.toggle('copied', !!ok);
          copyLabel.textContent = ok ? 'Скопировано ✓' : 'Не удалось — выделите вручную';
          setTimeout(function () {
            copyBtn.classList.remove('copied');
            copyLabel.textContent = 'Скопировать фразу';
          }, 2400);
          track('CopyLeadPhrase', 'copy_phrase', {
            content_name: 'lead_phrase_copy',
            copied_text_type: 'telegram_first_message',
            lead_id: LEAD_ID
          });
        };
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(LEAD_PHRASE).then(function () { done(true); }, function () { done(false); });
          } else {
            var ta = document.createElement('textarea');
            ta.value = LEAD_PHRASE;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.focus(); ta.select();
            var ok = false;
            try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
            document.body.removeChild(ta);
            done(ok);
          }
        } catch (e) { done(false); }
      });
    }

    setTimeout(attemptAutoOpen, 800);
  });

  window.altynBridge = {
    leadId: LEAD_ID,
    fireTelegramOpenAttempt: fireTelegramOpenAttempt,
    device: device,
    phrase: LEAD_PHRASE,
    tgApp: bridgeTgAppUrl(),
    tgWeb: bridgeTgWebUrl()
  };
})();
