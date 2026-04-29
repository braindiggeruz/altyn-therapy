/* =====================================================================
   Altyn Therapy — Meta Pixel + Conversion Tracking
   ---------------------------------------------------------------------
   Loads Meta Pixel, fires PageView/ViewContent automatically,
   and uses event delegation to track clicks on every relevant CTA
   (Telegram, WhatsApp, Instagram, phone, "Записаться", quiz, etc.).
   No assumptions about React internals — works on any rendered DOM.
   ===================================================================== */
(function () {
  'use strict';

  // Pixel ID is read from window.__META_PIXEL_ID__ (set via inline script
  // in index.html) so it can be swapped without redeploying this file.
  var PIXEL_ID = (typeof window !== 'undefined' && window.__META_PIXEL_ID__) || '';
  if (!PIXEL_ID) {
    console.warn('[altyn-pixel] Pixel ID not configured — tracking disabled.');
    return;
  }

  // ---------- 1. Standard Meta Pixel bootstrap ---------------------------
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

  window.fbq('init', PIXEL_ID);
  window.fbq('track', 'PageView');

  // After hero settles, send ViewContent so we know the visitor
  // actually engaged with the landing experience.
  setTimeout(function () {
    try {
      window.fbq('track', 'ViewContent', {
        content_name: 'Altyn Therapy Landing',
        content_category: 'hypnotherapy_landing',
        content_type: 'product_page'
      });
    } catch (e) { /* noop */ }
  }, 1500);

  // ---------- 2. Public tracking helper ----------------------------------
  // Use window.altynTrack(eventName, params) anywhere in the app.
  function trackEvent(eventName, params) {
    try {
      if (typeof window.fbq !== 'function') return;
      window.fbq('track', eventName, params || {});
      if (window.__ALTYN_DEBUG_PIXEL__) {
        console.log('[altyn-pixel]', eventName, params || {});
      }
    } catch (e) { /* noop */ }
  }
  window.altynTrack = trackEvent;

  // ---------- 3. Click classification ------------------------------------
  function classifyClick(target) {
    if (!target) return null;
    var anchor = target.closest ? target.closest('a') : null;
    var btn = target.closest ? target.closest('button') : null;
    var el = anchor || btn;
    if (!el) return null;

    var href = (anchor && anchor.href ? anchor.href : '').toLowerCase();
    var text = ((el.innerText || el.textContent || '') + ' ' + (el.getAttribute('aria-label') || '')).trim();
    var textLower = text.toLowerCase();

    // CTA location heuristic — find nearest section
    var section = el.closest('section') || el.closest('[data-section]') || null;
    var sectionLabel = 'unknown';
    if (section) {
      var heading = section.querySelector('h1, h2, h3');
      if (heading) sectionLabel = (heading.innerText || '').slice(0, 40).trim();
    }

    var base = {
      cta_location: sectionLabel,
      button_text: text.slice(0, 80),
      source: 'website'
    };

    // 1) Phone
    if (href.indexOf('tel:') === 0) {
      return { event: 'Contact', params: Object.assign({ content_name: 'phone_call', content_category: 'contact' }, base) };
    }
    // 2) Telegram bot — primary conversion path
    if (href.indexOf('t.me/') !== -1 || href.indexOf('telegram.me/') !== -1) {
      // Bot link is THE conversion. Track as Lead AND Contact for both audiences.
      return {
        event: 'Lead',
        params: Object.assign({
          content_name: 'telegram_consultation',
          content_category: 'free_consultation',
          channel: 'telegram'
        }, base),
        secondary: {
          event: 'Contact',
          params: Object.assign({ content_name: 'telegram', content_category: 'contact' }, base)
        }
      };
    }
    // 3) WhatsApp
    if (href.indexOf('wa.me/') !== -1 || href.indexOf('whatsapp.com') !== -1) {
      return {
        event: 'Lead',
        params: Object.assign({
          content_name: 'whatsapp_consultation',
          content_category: 'free_consultation',
          channel: 'whatsapp'
        }, base),
        secondary: {
          event: 'Contact',
          params: Object.assign({ content_name: 'whatsapp', content_category: 'contact' }, base)
        }
      };
    }
    // 4) Instagram
    if (href.indexOf('instagram.com') !== -1 || href.indexOf('ig.me') !== -1) {
      return { event: 'Contact', params: Object.assign({ content_name: 'instagram_direct', content_category: 'contact', channel: 'instagram' }, base) };
    }

    // 5) Text-based CTA detection (for buttons that don't navigate to an external URL yet)
    var leadKeywords = ['записаться', 'записаться на', 'бесплатн', 'разбор', 'консультац', 'квиз', 'пройти квиз', 'узнать свой сценарий', 'хочу так же'];
    for (var i = 0; i < leadKeywords.length; i++) {
      if (textLower.indexOf(leadKeywords[i]) !== -1) {
        return {
          event: 'Lead',
          params: Object.assign({
            content_name: 'cta_click',
            content_category: 'free_consultation',
            channel: 'website'
          }, base)
        };
      }
    }

    return null;
  }

  // ---------- 4. Global click delegation ---------------------------------
  // De-duplicate rapid double-fires from the same element.
  var lastFire = { ts: 0, key: '' };

  function handleClick(e) {
    var classification = classifyClick(e.target);
    if (!classification) return;

    var key = classification.event + '|' + (classification.params.button_text || '') + '|' + (classification.params.cta_location || '');
    var now = Date.now();
    if (lastFire.key === key && now - lastFire.ts < 800) return;
    lastFire = { ts: now, key: key };

    trackEvent(classification.event, classification.params);
    if (classification.secondary) {
      trackEvent(classification.secondary.event, classification.secondary.params);
    }
  }

  // Capture phase so we fire even when React stops propagation.
  document.addEventListener('click', handleClick, true);

  // ---------- 5. Expose minimal debug surface ----------------------------
  window.altynPixel = {
    id: PIXEL_ID,
    track: trackEvent,
    classify: classifyClick
  };
})();
