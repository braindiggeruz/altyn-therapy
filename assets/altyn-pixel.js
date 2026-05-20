/* =====================================================================
   Altyn Therapy — Meta Pixel + Conversion Tracking
   ---------------------------------------------------------------------
   - Loads Meta Pixel ONCE (single Pixel ID, no duplicates).
   - Fires PageView + ViewContent (landing) automatically.
   - On the landing: rewrites every Telegram CTA to go through the
     /go/telegram bridge (UTM/fbclid preserved) and fires CTA_Click
     INSTEAD of Lead — the real Lead fires on the bridge.
   - Fires LandingQualifiedView when the visitor spends >= 8s OR
     scrolls >= 35% of the landing.
   - Tracks tel: / wa.me / instagram.com clicks as Contact (unchanged).
   - Shares event_ids with the server CAPI proxy for browser↔server
     deduplication.
   ===================================================================== */
(function () {
  'use strict';

  var PIXEL_ID = (typeof window !== 'undefined' && window.__META_PIXEL_ID__) || '';
  if (!PIXEL_ID) {
    console.warn('[altyn-pixel] Pixel ID not configured — tracking disabled.');
    return;
  }

  // ---------- 1. Standard Meta Pixel bootstrap (single-init guard) ------
  (function (f, b, e, v, n, t, s) {
    if (f.fbq) return;
    n = f.fbq = function () {
      n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
    };
    if (!f._fbq) f._fbq = n;
    n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = [];
    t = b.createElement(e); t.async = !0;
    t.src = v;
    s = b.getElementsByTagName(e)[0];
    s.parentNode.insertBefore(t, s);
  })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');

  if (!window.__ALTYN_PIXEL_INITED__) {
    window.fbq('init', PIXEL_ID);
    window.__ALTYN_PIXEL_INITED__ = true;
  }
  window.fbq('track', 'PageView');

  // ---------- 2. Helpers ------------------------------------------------
  var IS_BRIDGE = /\/go\/telegram\/?/.test(window.location.pathname);
  var CAPI_ENDPOINT = '/api/meta/capi';
  var STANDARD_EVENTS = { PageView:1, ViewContent:1, Lead:1, Contact:1, CompleteRegistration:1, Search:1, AddToCart:1, Purchase:1, InitiateCheckout:1, AddPaymentInfo:1, Subscribe:1 };

  function getUTMSnapshot() {
    try { return (window.altynUTM && window.altynUTM.get()) || {}; }
    catch (e) { return {}; }
  }
  function eventIdFor(key) {
    try { return window.altynUTM.getEventId(key); }
    catch (e) { return 'altyn_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10); }
  }
  function utmParams() {
    var u = getUTMSnapshot();
    var out = {};
    ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','fbclid','traffic_source'].forEach(function (k) {
      if (u[k]) out[k] = u[k];
    });
    return out;
  }

  function fbqFire(eventName, params, opts) {
    try {
      var method = STANDARD_EVENTS[eventName] ? 'track' : 'trackCustom';
      if (opts && opts.eventID) {
        window.fbq(method, eventName, params || {}, { eventID: opts.eventID });
      } else {
        window.fbq(method, eventName, params || {});
      }
    } catch (e) { /* noop */ }
    if (window.__ALTYN_DEBUG_PIXEL__) {
      try { console.log('[altyn-pixel]', eventName, params || {}, opts || {}); } catch (e) {}
    }
  }

  function postCAPI(payload) {
    try {
      var body = JSON.stringify(payload);
      // fetch+keepalive: survives navigation (deep-link), and Playwright /
      // service workers can intercept it for testing.
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

  /**
   * Unified tracker: fires browser pixel + (optionally) server CAPI
   * with the same event_id.
   *  - eventName: Meta event name (standard or custom)
   *  - eventKey:  semantic key used to dedupe via altynUTM.getEventId()
   *  - params:    custom_data sent to both channels
   *  - opts.serverSkip = true → only fire browser pixel
   */
  function trackEvent(eventName, eventKey, params, opts) {
    opts = opts || {};
    var p, eventId;
    try {
      p = Object.assign({}, utmParams(), params || {});
      eventId = eventKey ? eventIdFor(eventKey) : ('altyn_' + Date.now());
    } catch (e) {
      p = params || {};
      eventId = 'altyn_fallback_' + Date.now();
    }

    try { fbqFire(eventName, p, { eventID: eventId }); } catch (e) { /* noop */ }

    var serverable = { Contact:1, Lead:1, TelegramOpenAttempt:1, CopyLeadPhrase:1, LandingQualifiedView:1, CTA_Click:1, ViewContent:1 };
    if (!opts.serverSkip && serverable[eventName]) {
      try {
        var u = getUTMSnapshot();
        postCAPI({
          event_name: eventName,
          event_id: eventId,
          event_time: Math.floor(Date.now() / 1000),
          event_source_url: window.location.href,
          action_source: 'website',
          fbp: u._fbp || null,
          fbc: u._fbc || null,
          custom_data: p
        });
      } catch (e) { /* noop */ }
    }
    return eventId;
  }

  // Back-compat shim — keep window.altynTrack working for callers in
  // altyn-enhance.js. Old signature: altynTrack(eventName, params).
  window.altynTrack = function (eventName, params) {
    return trackEvent(eventName, null, params || {});
  };
  window.altynTrackV2 = trackEvent;

  // ---------- 3. ViewContent (landing only) -----------------------------
  if (!IS_BRIDGE) {
    setTimeout(function () {
      trackEvent('ViewContent', 'landing_viewcontent', {
        content_name: 'altyn_relationship_scenario_landing',
        content_category: 'hypnotherapy_diagnostic',
        content_type: 'product_page',
        offer_name: 'scenario_diagnostic_10usd',
        value: 10,
        currency: 'USD'
      });
    }, 1500);
  }

  // ---------- 4. Rewrite Telegram links → /go/telegram (landing only) ---
  function buildBridgeUrl() {
    var u = getUTMSnapshot();
    var qs = [];
    ['utm_source','utm_medium','utm_campaign','utm_content','utm_term','fbclid'].forEach(function (k) {
      if (u[k]) qs.push(encodeURIComponent(k) + '=' + encodeURIComponent(u[k]));
    });
    return '/go/telegram' + (qs.length ? ('?' + qs.join('&')) : '');
  }

  function rewriteTelegramAnchors(root) {
    if (IS_BRIDGE) return;
    var scope = root || document;
    var anchors = scope.querySelectorAll('a[href*="t.me/Altyn2304"], a[href*="t.me/altyn2304" i], a[href*="telegram.me/Altyn2304" i]');
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      if (a.dataset.altynBridged === '1') continue;
      a.dataset.altynBridged = '1';
      a.dataset.altynOriginalHref = a.getAttribute('href') || '';
      a.setAttribute('href', buildBridgeUrl());
      // bridge page handles target itself; we keep current target to not break UX
      var relAttr = (a.getAttribute('rel') || '').trim();
      if (relAttr.indexOf('noopener') === -1) {
        a.setAttribute('rel', (relAttr ? relAttr + ' ' : '') + 'noopener');
      }
    }
  }

  // Re-rewrite when SPA mutates the DOM (the React app is hydrated client-side).
  if (!IS_BRIDGE) {
    rewriteTelegramAnchors(document);
    try {
      var mo = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          var m = mutations[i];
          if (m.addedNodes && m.addedNodes.length) {
            for (var j = 0; j < m.addedNodes.length; j++) {
              var node = m.addedNodes[j];
              if (node.nodeType === 1) rewriteTelegramAnchors(node);
            }
          }
        }
      });
      mo.observe(document.documentElement, { childList: true, subtree: true });
      window.__altynPixelMO__ = mo;
    } catch (e) { /* older browsers */ }
  }

  // ---------- 5. Click classification (landing) -------------------------
  function nearestSectionLabel(el) {
    var section = el.closest && (el.closest('section') || el.closest('[data-section]'));
    if (!section) return 'unknown';
    var h = section.querySelector('h1, h2, h3');
    return h ? (h.innerText || '').slice(0, 40).trim().toLowerCase() : 'unknown';
  }

  function ctaLocationFromEl(el, sectionLabel) {
    var cls = (el.className || '').toString().toLowerCase();
    if (el.closest('.altyn-sticky-cta')) return 'sticky';
    if (el.closest('.altyn-price-badge')) return 'price_badge';
    if (el.closest('.altyn-vt-modal')) return 'video_modal';
    if (el.closest('.altyn-vt')) return 'testimonials';
    if (/sticky/.test(cls)) return 'sticky';
    if (/hero/.test(cls)) return 'hero';
    if (/footer/.test(cls)) return 'footer';
    var s = sectionLabel || '';
    if (/тариф|цен|стоим|10\$|price/.test(s)) return 'price_block';
    if (/отзыв|истории|видео/.test(s)) return 'testimonials';
    if (/вопрос|faq/.test(s)) return 'faq';
    if (/футер|подвал|контакт/.test(s)) return 'footer';
    if (/о себе|обо мне|кто я|алтын/.test(s)) return 'about';
    if (/процесс|как мы|как проходит/.test(s)) return 'process';
    return s ? s.slice(0, 24) : 'unknown';
  }

  function classifyClick(target) {
    if (!target) return null;
    var anchor = target.closest ? target.closest('a') : null;
    var btn = target.closest ? target.closest('button') : null;
    var el = anchor || btn;
    if (!el) return null;

    var hrefRaw = (anchor && anchor.href ? anchor.href : '') || '';
    var href = hrefRaw.toLowerCase();
    var bridgedTo = (anchor && anchor.dataset && anchor.dataset.altynOriginalHref) || '';
    var text = ((el.innerText || el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).trim();
    var textLower = text.toLowerCase();
    var section = nearestSectionLabel(el);
    var loc = ctaLocationFromEl(el, section);

    var base = {
      cta_location: loc,
      cta_text: text.slice(0, 80)
    };

    // Telegram CTA — track as CTA_Click only (real Lead happens on bridge)
    if (
      href.indexOf('/go/telegram') !== -1 ||
      /t\.me\/altyn2304/i.test(bridgedTo) ||
      /t\.me\/|telegram\.me\//i.test(href)
    ) {
      return {
        event: 'CTA_Click',
        params: Object.assign({
          destination: '/go/telegram',
          contact_channel: 'telegram',
          offer_name: 'scenario_diagnostic_10usd',
          value: 10,
          currency: 'USD'
        }, base)
      };
    }
    // Phone
    if (href.indexOf('tel:') === 0) {
      return {
        event: 'Contact',
        params: Object.assign({
          content_name: 'phone_call',
          content_category: 'contact',
          contact_channel: 'phone'
        }, base)
      };
    }
    // WhatsApp
    if (href.indexOf('wa.me/') !== -1 || href.indexOf('whatsapp.com') !== -1) {
      return {
        event: 'Contact',
        params: Object.assign({
          content_name: 'whatsapp',
          content_category: 'contact',
          contact_channel: 'whatsapp'
        }, base)
      };
    }
    // Instagram
    if (href.indexOf('instagram.com') !== -1 || href.indexOf('ig.me') !== -1) {
      return {
        event: 'Contact',
        params: Object.assign({
          content_name: 'instagram_direct',
          content_category: 'contact',
          contact_channel: 'instagram'
        }, base)
      };
    }
    // Text-based CTA (no external nav yet, but clearly lead-intent text)
    var leadKeywords = ['записаться', 'хочу разбор', 'разбор за', 'разбор сценария', 'консультац'];
    for (var i = 0; i < leadKeywords.length; i++) {
      if (textLower.indexOf(leadKeywords[i]) !== -1) {
        return {
          event: 'CTA_Click',
          params: Object.assign({
            destination: '/go/telegram',
            offer_name: 'scenario_diagnostic_10usd',
            value: 10,
            currency: 'USD'
          }, base)
        };
      }
    }
    return null;
  }

  // ---------- 6. Click delegation with rate-limit dedup -----------------
  var lastFire = { ts: 0, key: '' };
  function handleClick(e) {
    if (IS_BRIDGE) return; // bridge has its own logic
    var c = classifyClick(e.target);
    if (!c) return;
    var key = c.event + '|' + (c.params.cta_text || '') + '|' + (c.params.cta_location || '');
    var now = Date.now();
    if (lastFire.key === key && now - lastFire.ts < 800) return;
    lastFire = { ts: now, key: key };
    // Each click has a unique eventKey to avoid CAPI dedup-collapsing distinct clicks
    var ekey = 'click_' + key + '_' + now;
    trackEvent(c.event, ekey, c.params);
  }
  document.addEventListener('click', handleClick, true);

  // ---------- 7. LandingQualifiedView (8s OR 35% scroll) ---------------
  if (!IS_BRIDGE) {
    var qualifiedSent = false;
    var startTs = Date.now();
    function maybeQualify(reason, depthPct) {
      if (qualifiedSent) return;
      qualifiedSent = true;
      var seconds = Math.round((Date.now() - startTs) / 1000);
      trackEvent('LandingQualifiedView', 'landing_qualified_view', {
        content_name: 'qualified_landing_view',
        content_category: 'hypnotherapy_diagnostic',
        offer_name: 'scenario_diagnostic_10usd',
        value: 10,
        currency: 'USD',
        seconds_on_page: seconds,
        scroll_depth: typeof depthPct === 'number' ? Math.round(depthPct) : 0
      });
    }

    setTimeout(function () { maybeQualify('time'); }, 8000);

    function scrollDepthPct() {
      var doc = document.documentElement;
      var body = document.body;
      var scrollTop = window.pageYOffset || doc.scrollTop || body.scrollTop || 0;
      var viewport = window.innerHeight || doc.clientHeight || 0;
      var full = Math.max(doc.scrollHeight, body.scrollHeight, doc.offsetHeight, body.offsetHeight) || 1;
      if (full <= viewport) return 100;
      return ((scrollTop + viewport) / full) * 100;
    }
    function onScroll() {
      if (qualifiedSent) {
        window.removeEventListener('scroll', onScroll);
        return;
      }
      var pct = scrollDepthPct();
      if (pct >= 35) maybeQualify('scroll', pct);
    }
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  // ---------- 8. Debug surface ------------------------------------------
  window.altynPixel = {
    id: PIXEL_ID,
    track: trackEvent,
    classify: classifyClick,
    isBridge: IS_BRIDGE
  };
})();
