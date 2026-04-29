/* =====================================================================
   Altyn Therapy — Conversion enhancements (vanilla, no deps)
   1) Injects video testimonial section after the existing "Отзывы".
   2) Mounts a sticky mobile bottom CTA bar (Telegram + WhatsApp + Quiz).
   3) Hooks every CTA so window.fbq events fire (handled by altyn-pixel.js).
   ===================================================================== */
(function () {
  'use strict';

  // ---------- Configuration ----------
  var TG = 'https://t.me/altyntherapybot';
  var WA = 'https://wa.me/77077198561?text=' + encodeURIComponent(
    'Здравствуйте! Хочу записаться на бесплатный разбор'
  );

  // 7 testimonials (videos already optimised to ~540×960 H.264 + AAC).
  // Captions are neutral — no fake names, no medical claims.
  var TESTIMONIALS = [
    { id: 1, label: 'Видеоотзыв клиента', caption: 'Спустя несколько сессий стало спокойнее' },
    { id: 2, label: 'История клиента',     caption: 'Увидела свой повторяющийся сценарий' },
    { id: 3, label: 'Опыт после разбора',  caption: 'Стало понятно, с чего начать' },
    { id: 4, label: 'Видеоотзыв клиента', caption: 'Тревога стала тише, появилась опора' },
    { id: 5, label: 'Короткий отзыв',      caption: 'Хочу поделиться своим опытом' },
    { id: 6, label: 'История клиента',     caption: 'Изменилось отношение к себе' },
    { id: 7, label: 'Подробный рассказ',   caption: 'Поделюсь, как прошла работа' }
  ];

  // ---------- Helpers ----------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'data') Object.keys(attrs.data).forEach(function (d) { e.dataset[d] = attrs.data[d]; });
      else e.setAttribute(k, attrs[k]);
    });
    if (html != null) e.innerHTML = html;
    return e;
  }
  function track(event, params) {
    try { if (typeof window.altynTrack === 'function') window.altynTrack(event, params || {}); } catch (e) {}
  }

  // ---------- 1. Build video testimonials section ----------
  function buildSection() {
    var sec = el('section', { class: 'altyn-vt', 'data-altyn-vt': '1', 'aria-labelledby': 'altyn-vt-title' });

    var head = el('div', { class: 'altyn-vt__head' });
    head.appendChild(el('span', { class: 'altyn-vt__eyebrow' }, 'Видеоистории'));
    head.appendChild(el('h2', { class: 'altyn-vt__title', id: 'altyn-vt-title' },
      'Реальные голоса. <em>Реальные истории.</em>'));
    head.appendChild(el('p', { class: 'altyn-vt__sub' },
      'Короткие видеоотзывы клиентов, которые прошли разбор и продолжили работу со сценарием. Без сценариев и постановок — то, как они сами это рассказывают.'));
    sec.appendChild(head);

    var trackWrap = el('div', { class: 'altyn-vt__track-wrap' });
    var trackEl = el('div', { class: 'altyn-vt__track', role: 'list' });

    TESTIMONIALS.forEach(function (t) {
      var card = el('button', {
        class: 'altyn-vt__card',
        type: 'button',
        role: 'listitem',
        'aria-label': t.label + '. ' + t.caption + '. Открыть видео',
        'data-vt-id': String(t.id)
      });
      var poster = el('img', {
        class: 'altyn-vt__poster',
        src: '/testimonials/posters/testimonial-' + t.id + '.jpg',
        alt: t.label,
        loading: 'lazy',
        decoding: 'async',
        width: '540', height: '960'
      });
      card.appendChild(poster);
      card.appendChild(el('span', { class: 'altyn-vt__overlay' }));
      card.appendChild(el('span', { class: 'altyn-vt__play', 'aria-hidden': 'true' }));

      var meta = el('span', { class: 'altyn-vt__meta' });
      meta.appendChild(el('span', { class: 'altyn-vt__label' }, t.label));
      meta.appendChild(el('p', { class: 'altyn-vt__caption' }, '«' + t.caption + '»'));
      card.appendChild(meta);

      card.addEventListener('click', function () { openModal(t); });
      trackEl.appendChild(card);
    });

    trackWrap.appendChild(trackEl);
    sec.appendChild(trackWrap);

    var hint = el('div', { class: 'altyn-vt__hint' }, '← свайп — ещё истории →');
    sec.appendChild(hint);

    var ctaWrap = el('div', { class: 'altyn-vt__cta-wrap' });
    var cta = el('a', {
      class: 'altyn-vt__cta',
      href: TG,
      target: '_blank',
      rel: 'noopener',
      'data-altyn-cta': 'vt-section'
    }, 'Записаться на бесплатный разбор');
    ctaWrap.appendChild(cta);
    ctaWrap.appendChild(el('span', { class: 'altyn-vt__cta-note' }, '1 час · онлайн · без оплаты'));
    sec.appendChild(ctaWrap);

    return sec;
  }

  // ---------- 2. Modal lightbox ----------
  var modal, modalVideo, currentTId = null;

  function buildModal() {
    modal = el('div', { class: 'altyn-vt-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Видеоотзыв' });
    var inner = el('div', { class: 'altyn-vt-modal__inner' });

    modalVideo = el('video', {
      class: 'altyn-vt-modal__video',
      controls: 'true',
      playsinline: 'true',
      preload: 'metadata'
    });
    inner.appendChild(modalVideo);

    var close = el('button', { class: 'altyn-vt-modal__close', type: 'button', 'aria-label': 'Закрыть' }, '×');
    close.addEventListener('click', closeModal);
    inner.appendChild(close);

    var ctaRow = el('div', { class: 'altyn-vt-modal__cta' });
    var primary = el('a', {
      class: 'primary', href: TG, target: '_blank', rel: 'noopener',
      'data-altyn-cta': 'vt-modal-tg'
    }, 'Записаться');
    var secondary = el('a', {
      class: 'secondary', href: WA, target: '_blank', rel: 'noopener',
      'data-altyn-cta': 'vt-modal-wa'
    }, 'WhatsApp');
    ctaRow.appendChild(primary);
    ctaRow.appendChild(secondary);
    inner.appendChild(ctaRow);

    modal.appendChild(inner);
    modal.addEventListener('click', function (e) {
      if (e.target === modal) closeModal();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && modal.classList.contains('altyn-vt-modal--open')) closeModal();
    });
    document.body.appendChild(modal);
  }

  function openModal(t) {
    if (!modal) buildModal();
    currentTId = t.id;
    modalVideo.src = '/testimonials/testimonial-' + t.id + '.mp4';
    modalVideo.poster = '/testimonials/posters/testimonial-' + t.id + '.jpg';
    modal.classList.add('altyn-vt-modal--open');
    document.body.classList.add('altyn-vt-locked');

    // attempt autoplay (muted-first to satisfy iOS); user can unmute via controls.
    modalVideo.muted = false;
    var playPromise = modalVideo.play();
    if (playPromise && playPromise.catch) {
      playPromise.catch(function () {
        modalVideo.muted = true;
        modalVideo.play().catch(function () { /* user will tap */ });
      });
    }

    track('ViewContent', {
      content_name: 'video_testimonial_' + t.id,
      content_category: 'video_testimonial',
      content_type: 'video'
    });
  }

  function closeModal() {
    if (!modal) return;
    modal.classList.remove('altyn-vt-modal--open');
    document.body.classList.remove('altyn-vt-locked');
    try { modalVideo.pause(); } catch (e) {}
    setTimeout(function () { modalVideo.removeAttribute('src'); modalVideo.load && modalVideo.load(); }, 320);
    currentTId = null;
  }

  // ---------- 3. Inject section into the page ----------
  function findReviewsSection() {
    // Heuristic: section whose first heading text contains "ОТЗЫВЫ" (case-insensitive).
    var sections = document.querySelectorAll('main section, body section');
    for (var i = 0; i < sections.length; i++) {
      var s = sections[i];
      if (s.dataset.altynVt) continue;
      var h = s.querySelector('h1, h2, h3');
      if (h && /отзыв|истории трансформации/i.test(h.innerText || '')) {
        return s;
      }
    }
    return null;
  }

  var injected = false;
  function tryInject() {
    if (injected) return true;
    var anchor = findReviewsSection();
    if (!anchor) return false;
    var section = buildSection();
    if (anchor.nextSibling) {
      anchor.parentNode.insertBefore(section, anchor.nextSibling);
    } else {
      anchor.parentNode.appendChild(section);
    }
    injected = true;
    return true;
  }

  // ---------- 4. Sticky mobile CTA bar ----------
  // The existing React app already paints its own fixed bottom bar
  // ("Узнайте свой бессознательный сценарий … Пройти квиз"). To avoid
  // stacking two bars and to give visitors a *richer* set of choices
  // (Записаться + WhatsApp instead of just one button), we hide that
  // legacy bar at runtime when ours is live.
  function findReactBottomBar() {
    var fixedEls = document.querySelectorAll('div.fixed.bottom-0, [class*="fixed"][class*="bottom-0"]');
    for (var i = 0; i < fixedEls.length; i++) {
      var el = fixedEls[i];
      if (el.classList.contains('altyn-sticky-cta')) continue;
      var cls = (el.className || '').toString();
      // Only hide if it looks like a native CTA bar (burgundy bg + bottom + has CTA text)
      if (/bg-\[#6B2D3E\]|bg-\[#6B2D3E\]\/[0-9]+|bg-\[#5A2434\]/.test(cls)) {
        return el;
      }
      // Fallback: any small fixed bottom bar with a Telegram link
      var rect = el.getBoundingClientRect();
      if (rect.height > 0 && rect.height < 130 && el.querySelector('a[href*="t.me"], a[href*="wa.me"]')) {
        return el;
      }
    }
    return null;
  }

  function hideReactBar() {
    var bar = findReactBottomBar();
    if (bar && !bar.dataset.altynHidden) {
      bar.dataset.altynHidden = '1';
      bar.style.setProperty('display', 'none', 'important');
    }
  }

  function buildSticky() {
    var bar = el('div', { class: 'altyn-sticky-cta', role: 'navigation', 'aria-label': 'Быстрая запись' });
    bar.innerHTML =
      '<a href="' + TG + '" target="_blank" rel="noopener" class="primary" data-altyn-cta="sticky-tg">' +
        '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9.78 18.65l.28-4.23 7.68-6.92c.34-.31-.07-.46-.52-.19L7.74 13.3 3.64 12c-.88-.25-.89-.86.2-1.3l15.97-6.16c.73-.33 1.43.18 1.15 1.3l-2.72 12.81c-.19.91-.74 1.13-1.5.71L12.6 16.3l-1.99 1.93c-.23.23-.42.42-.83.42z"/></svg>' +
        '<span>Записаться</span>' +
      '</a>' +
      '<a href="' + WA + '" target="_blank" rel="noopener" class="wa" data-altyn-cta="sticky-wa" aria-label="WhatsApp">' +
        '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M17.47 14.38c-.3-.15-1.74-.86-2.01-.96-.27-.1-.46-.15-.66.15-.2.3-.76.96-.93 1.16-.17.2-.34.22-.64.07-.3-.15-1.25-.46-2.39-1.47-.88-.79-1.48-1.76-1.65-2.06-.17-.3-.02-.46.13-.61.13-.13.3-.34.45-.51.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.07-.15-.66-1.59-.9-2.18-.24-.57-.48-.49-.66-.5l-.56-.01c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.49 0 1.47 1.07 2.89 1.22 3.09.15.2 2.1 3.21 5.08 4.5.71.31 1.27.49 1.7.63.71.23 1.36.2 1.87.12.57-.08 1.74-.71 1.99-1.39.25-.69.25-1.27.17-1.39-.07-.13-.27-.2-.57-.35zM12 2C6.48 2 2 6.48 2 12c0 1.74.45 3.41 1.3 4.9L2 22l5.25-1.37A9.93 9.93 0 0012 22c5.52 0 10-4.48 10-10S17.52 2 12 2z"/></svg>' +
        '<span>WhatsApp</span>' +
      '</a>';
    document.body.appendChild(bar);

    // Show after user scrolls past hero (300px).
    var lastScroll = 0;
    function onScroll() {
      var y = window.scrollY || window.pageYOffset || 0;
      if (y > 320) {
        bar.classList.add('altyn-sticky-cta--visible');
        document.body.classList.add('altyn-sticky-pad');
      } else if (y < 200) {
        bar.classList.remove('altyn-sticky-cta--visible');
        document.body.classList.remove('altyn-sticky-pad');
      }
      lastScroll = y;
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  // ---------- 5. Bootstrap ----------
  function init() {
    // Try injecting now and via observer (React renders async).
    var sectionInjected = tryInject();
    var barHidden = false;
    var attempts = 0;

    function tick() {
      attempts++;
      if (!sectionInjected) sectionInjected = tryInject();
      if (!barHidden) {
        var b = findReactBottomBar();
        if (b) { hideReactBar(); barHidden = true; }
      }
      if ((sectionInjected && barHidden) || attempts > 60) {
        clearInterval(iv);
        if (mo) mo.disconnect();
      }
    }
    var iv = setInterval(tick, 250);
    var mo = new MutationObserver(tick);
    mo.observe(document.body, { childList: true, subtree: true });

    buildSticky();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
