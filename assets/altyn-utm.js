/* =====================================================================
   Altyn Therapy — UTM / fbclid / _fbp / _fbc capture utility
   ---------------------------------------------------------------------
   Loaded on every page BEFORE altyn-pixel.js.
   Public API on window.altynUTM:
     get()       -> { utm_source, utm_medium, utm_campaign,
                      utm_content, utm_term, fbclid,
                      _fbp, _fbc, landing_url, referrer,
                      traffic_source, first_seen_at }
     pixelParams() -> subset suitable for fbq() custom params
     newEventId(prefix) -> stable string event_id (sessionStorage cache per key)
     getEventId(key)    -> get-or-create event_id for a given semantic key
   ===================================================================== */
(function () {
  'use strict';

  var STORAGE_KEY = 'altyn_attribution_v1';
  var SESSION_EVENT_KEY = 'altyn_event_ids_v1';

  function safeJSON(parse, raw, fallback) {
    try { return parse ? JSON.parse(raw) : JSON.stringify(raw); }
    catch (e) { return fallback; }
  }

  function readStore(storage, key) {
    try {
      var raw = storage.getItem(key);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }
  function writeStore(storage, key, value) {
    try { storage.setItem(key, JSON.stringify(value)); } catch (e) { /* quota / safari private */ }
  }

  function getCookie(name) {
    try {
      var m = document.cookie.match('(?:^|;)\\s*' + name.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '=([^;]*)');
      return m ? decodeURIComponent(m[1]) : null;
    } catch (e) { return null; }
  }

  function setCookie(name, value, days) {
    try {
      var d = new Date();
      d.setTime(d.getTime() + (days * 24 * 60 * 60 * 1000));
      var domain = '';
      // Allow cookie to work across www / apex
      var host = location.hostname.replace(/^www\./, '');
      if (host && host.indexOf('.') !== -1 && host !== 'localhost') {
        domain = '; domain=.' + host;
      }
      document.cookie = name + '=' + encodeURIComponent(value) +
        '; expires=' + d.toUTCString() +
        '; path=/' + domain + '; SameSite=Lax';
    } catch (e) { /* noop */ }
  }

  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      try { return window.crypto.randomUUID(); } catch (e) {}
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0, v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // Build the _fbc value Meta expects, from a fresh fbclid:
  //   fb.{subdomain_index}.{timestamp_ms}.{fbclid}
  function buildFbcFromFbclid(fbclid) {
    if (!fbclid) return null;
    return 'fb.1.' + Date.now() + '.' + fbclid;
  }

  function trafficSourceFromReferrer(ref, utm) {
    if (utm && utm.utm_source) return utm.utm_source;
    if (!ref) return 'direct';
    try {
      var u = new URL(ref);
      var host = u.hostname.replace(/^www\./, '');
      if (/facebook\.com|fb\.com|fb\.me/.test(host)) return 'facebook';
      if (/instagram\.com|ig\.me/.test(host)) return 'instagram';
      if (/t\.co|twitter\.com|x\.com/.test(host)) return 'twitter';
      if (/google\./.test(host)) return 'google';
      if (/yandex\./.test(host)) return 'yandex';
      if (/t\.me|telegram\.me/.test(host)) return 'telegram';
      return host;
    } catch (e) { return 'unknown'; }
  }

  function parseQuery() {
    var q = {};
    try {
      var s = window.location.search || '';
      if (s.charAt(0) === '?') s = s.slice(1);
      if (!s) return q;
      s.split('&').forEach(function (pair) {
        if (!pair) return;
        var i = pair.indexOf('=');
        var k = i === -1 ? pair : pair.slice(0, i);
        var v = i === -1 ? '' : pair.slice(i + 1);
        try { k = decodeURIComponent(k); } catch (e) {}
        try { v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e) {}
        if (k) q[k] = v;
      });
    } catch (e) {}
    return q;
  }

  function captureAttribution() {
    var existing = readStore(localStorage, STORAGE_KEY) || {};
    var query = parseQuery();
    var now = Date.now();

    // UTM: fresh hit wins ONLY when present in URL; otherwise keep first-touch.
    var utmKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
    var utm = {};
    var hasFreshUtm = false;
    utmKeys.forEach(function (k) {
      if (query[k]) { utm[k] = query[k]; hasFreshUtm = true; }
      else if (existing[k]) utm[k] = existing[k];
    });

    // fbclid
    var fbclid = query.fbclid || existing.fbclid || null;

    // _fbp / _fbc — Meta sets these as 1st-party cookies, but in-app browsers
    // and tracker blockers sometimes prevent them. We mirror to localStorage.
    var fbp = getCookie('_fbp') || existing._fbp || null;
    var fbc = getCookie('_fbc') || existing._fbc || null;

    // If we have a fresh fbclid and no _fbc cookie, synthesize one and set cookie.
    if (query.fbclid && !getCookie('_fbc')) {
      fbc = buildFbcFromFbclid(query.fbclid);
      setCookie('_fbc', fbc, 90);
    }
    // Pixel script normally writes _fbp; if missing entirely, seed our own
    // so server-side CAPI has something stable to match on.
    if (!fbp) {
      fbp = 'fb.1.' + now + '.' + Math.floor(Math.random() * 1e10);
      setCookie('_fbp', fbp, 90);
    }

    var referrer = existing.referrer || document.referrer || '';
    var landing_url = existing.landing_url || (location.origin + location.pathname + location.search);
    var first_seen_at = existing.first_seen_at || new Date(now).toISOString();
    var traffic_source = trafficSourceFromReferrer(referrer, utm);

    var data = {
      utm_source:   utm.utm_source || null,
      utm_medium:   utm.utm_medium || null,
      utm_campaign: utm.utm_campaign || null,
      utm_content:  utm.utm_content || null,
      utm_term:     utm.utm_term || null,
      fbclid:       fbclid,
      _fbp:         fbp,
      _fbc:         fbc,
      landing_url:  landing_url,
      referrer:     referrer,
      traffic_source: traffic_source,
      first_seen_at:  first_seen_at,
      last_seen_at:   new Date(now).toISOString(),
      had_fresh_utm:  hasFreshUtm
    };
    writeStore(localStorage, STORAGE_KEY, data);
    // Also mirror to sessionStorage for fast same-session reads.
    writeStore(sessionStorage, STORAGE_KEY, data);
    return data;
  }

  // Event-id cache (sessionStorage). For dedupe with CAPI we want the SAME
  // event_id when both browser pixel and server fire the same logical event.
  function getEventId(key) {
    var map = readStore(sessionStorage, SESSION_EVENT_KEY) || {};
    if (map[key]) return map[key];
    var id = 'altyn_' + Date.now().toString(36) + '_' + uuid();
    map[key] = id;
    writeStore(sessionStorage, SESSION_EVENT_KEY, map);
    return id;
  }
  function newEventId(prefix) {
    return (prefix || 'altyn') + '_' + Date.now().toString(36) + '_' + uuid();
  }

  function pixelParams() {
    var a = captureAttribution();
    return {
      utm_source:   a.utm_source,
      utm_medium:   a.utm_medium,
      utm_campaign: a.utm_campaign,
      utm_content:  a.utm_content,
      utm_term:     a.utm_term,
      fbclid:       a.fbclid,
      traffic_source: a.traffic_source
    };
  }

  // Run capture immediately on load.
  var snapshot = captureAttribution();

  window.altynUTM = {
    get: function () { return readStore(sessionStorage, STORAGE_KEY) || captureAttribution(); },
    pixelParams: pixelParams,
    getEventId: getEventId,
    newEventId: newEventId,
    refresh: captureAttribution,
    _snapshot: snapshot
  };
})();
