/* =====================================================================
   Altyn Therapy — /go/telegram bridge logic
   ---------------------------------------------------------------------
   Runs ONLY on the /go/telegram bridge page. Responsibilities:
   1. On page load:
        - fbq('track','Contact', …)  + parallel server CAPI Contact (same event_id)
   2. Auto deep-link attempt to tg://resolve?domain=Altyn2304
        - fires TelegramOpenAttempt (browser only)
        - fires Lead (browser + server CAPI, single fire per session)
   3. "Открыть Telegram" button:
        - fires TelegramOpenAttempt + Lead (deduped against the auto attempt)
   4. "Скопировать фразу" button:
        - copies the lead phrase, fires CopyLeadPhrase
   5. Detects in-app browsers and disables auto-open in IG/FB webviews
      (deep links are unreliable there — we let the user tap instead).
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

  function getUTM() {
    try { return (window.altynUTM && window.altynUTM.get()) || {}; } catch (e) { return {}; }
  }
  function getEventId(key) {
    try { return window.altynUTM.getEventId(key); }
    catch (e) { return 'altyn_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10); }
  }
  function fbqTrack(eventName, params, opts) {
    try {
      if (typeof window.fbq !== 'function') return;
      var p = params || {};
      var o = opts || {};
      // Use trackCustom for non-standard names
      var standardEvents = { PageView:1, ViewContent:1, Lead:1, Contact:1, CompleteRegistration:1, Search:1, AddToCart:1, Purchase:1, InitiateCheckout:1, AddPaymentInfo:1, Subscribe:1 };
      var method = standardEvents[eventName] ? 'track' : 'trackCustom';
      if (o.eventID) {
        window.fbq(method, eventName, p, { eventID: o.eventID });
      } else {
        window.fbq(method, eventName, p);
      }
    } catch (e) { /* noop */ }
  }

  function postCAPI(payload) {
    try {
      var body = JSON.stringify(payload);
      // Prefer fetch+keepalive over sendBeacon: keepalive lets the request
      // survive page unload (deep-link to Telegram), AND it's intercept-able
      // by service workers / route mocks for testing.
      if (typeof fetch === 'function') {
        fetch(CAPI_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: body,
          keepalive: true,
          credentials: 'omit',
          mode: 'same-origin'
        }).catch(function () { /* swallow */ });
        return;
      }
      if (navigator.sendBeacon) {
        var blob = new Blob([body], { type: 'application/json' });
        navigator.sendBeacon(CAPI_ENDPOINT, blob);
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
    // strip nulls so we don't pollute fbq event params
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

    // 1) Browser pixel — safe by itself, but isolate so a fbq error never
    //    swallows the CAPI call below.
    try {
      fbqTrack(eventName, params, { eventID: eventId });
    } catch (e) { /* noop */ }

    // 2) Server CAPI (whitelisted server events only)
    var serverEvents = { Contact: 1, Lead: 1, TelegramOpenAttempt: 1, CopyLeadPhrase: 1, LandingQualifiedView: 1, CTA_Click: 1 };
    if (!serverEvents[eventName]) return eventId;
    if (opts && opts.serverSkip) return eventId;

    try {
      postCAPI({
        event_name: eventName,
        event_id: eventId,
        event_time: Math.floor(Date.now() / 1000),
        event_source_url: window.location.href,
        action_source: 'website',
        fbp: u._fbp || null,
        fbc: u._fbc || null,
        custom_data: params
      });
    } catch (e) { /* noop */ }
    return eventId;
  }

  // ----- Dedupe state for Lead (per session, per bridge load) -----
  var SESSION_FLAGS_KEY = 'altyn_bridge_flags_v1';
  function readFlags() {
    try { return JSON.parse(sessionStorage.getItem(SESSION_FLAGS_KEY) || '{}'); }
    catch (e) { return {}; }
  }
  function setFlag(k, v) {
    var f = readFlags(); f[k] = (v === undefined ? true : v);
    try { sessionStorage.setItem(SESSION_FLAGS_KEY, JSON.stringify(f)); } catch (e) {}
  }

  // ===================================================================
  // Step 1 — Contact on bridge load
  // ===================================================================
  var device = detectDevice();
  var contactParams = {
    content_name: 'telegram_redirect_page',
    contact_channel: 'telegram',
    destination: TG_USERNAME,
    device_type: device.device_type,
    browser_type: device.browser_type,
    in_app_browser_detected: device.in_app_browser_detected
  };
  // Fire Contact once per bridge page load (sessionKey ties browser+server eventIds)
  if (!readFlags().contact_sent) {
    track('Contact', 'bridge_contact', contactParams);
    setFlag('contact_sent');
  }

  // ===================================================================
  // Step 2 — Telegram open attempt (auto + manual button)
  // ===================================================================
  function fireTelegramOpenAttempt(method) {
    var flags = readFlags();
    // Allow at most ONE TelegramOpenAttempt per session+method (auto/fallback).
    var flagKey = 'tg_open_' + method;
    if (flags[flagKey]) return;
    setFlag(flagKey);

    var params = Object.assign({}, contactParams, {
      method: method, // 'auto_deeplink' | 'fallback_button'
    });
    track('TelegramOpenAttempt', 'tg_open_attempt_' + method, params);

    // Lead — only once per bridge session, regardless of method.
    if (!flags.lead_sent) {
      setFlag('lead_sent');
      track('Lead', 'tg_lead', {
        content_name: 'telegram_open_lead',
        lead_type: OFFER.offer_name,
        contact_channel: 'telegram',
        destination: TG_USERNAME,
        device_type: device.device_type,
        browser_type: device.browser_type,
        in_app_browser_detected: device.in_app_browser_detected
      });
    }
  }

  function attemptAutoOpen() {
    // In-app browsers (Instagram/Facebook webview) usually ignore tg:// silently,
    // and many block window.location change to custom schemes. We still fire
    // the auto attempt event (so we know the user reached the bridge with
    // intent), but we do NOT force a location change there — let the user tap.
    if (device.in_app_browser_detected) {
      fireTelegramOpenAttempt('auto_deeplink');
      return;
    }
    fireTelegramOpenAttempt('auto_deeplink');
    // Slight delay so analytics + CAPI beacon flush before we navigate away.
    setTimeout(function () {
      try { window.location.href = TG_APP_URL; } catch (e) {}
    }, 350);
  }

  // ===================================================================
  // Step 3 — Bind UI
  // ===================================================================
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
      openBtn.addEventListener('click', function (e) {
        // Let the normal anchor navigation happen (target=_blank → t.me),
        // but also fire the events.
        fireTelegramOpenAttempt('fallback_button');
        // We DON'T preventDefault — the anchor's href takes the user to t.me.
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
            copied_text_type: 'telegram_first_message'
          });
        };
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(LEAD_PHRASE).then(function () { done(true); }, function () { done(false); });
          } else {
            // Fallback for older Safari / in-app browsers
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

    // Auto-open with a short, visible delay so the user reads the phrase first.
    setTimeout(attemptAutoOpen, 800);
  });

  // Expose for debugging
  window.altynBridge = {
    fireTelegramOpenAttempt: fireTelegramOpenAttempt,
    device: device,
    phrase: LEAD_PHRASE,
    tgApp: TG_APP_URL,
    tgWeb: TG_WEB_URL
  };
})();
