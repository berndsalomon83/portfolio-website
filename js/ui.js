// DOM side of the experience: loader, reveal-on-scroll, active nav link, height gauge, sound toggle.
import { ForestAudio } from './audio.js';
import { initLiquidGlass } from './liquid-glass.js';
import { SEASON_NAMES, seasonIndex, seasonFromDate } from './world/seasons.js';

const svg = (paths) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const SEASON_ICONS = [
  svg('<path d="M12 21v-8"/><path d="M12 13c-4.2 0-6.5-2.6-6.5-6.2 4.2 0 6.5 2.6 6.5 6.2z"/><path d="M12 11c0-3.6 2.6-6.2 6.8-6.2 0 3.6-2.6 6.2-6.8 6.2z"/>'),
  svg('<circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.3M12 19.2v2.3M2.5 12h2.3M19.2 12h2.3M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/>'),
  svg('<path d="M5 19c0-8.3 5.2-14 14-14 0 9.2-6 14-14 14z"/><path d="M5 19l7.5-7.5"/>'),
  svg('<path d="M12 2.5v19M3.8 7.25l16.4 9.5M3.8 16.75l16.4-9.5"/><path d="M9.5 4l2.5 2.3L14.5 4M9.5 20l2.5-2.3 2.5 2.3"/>'),
];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthOf = (v) => MONTHS[Math.floor((((v * 3 + 2) % 12) + 12) % 12)];

const MAIL_SUBJECT = "Hej Bernd – let's talk";

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // older browsers / non-secure contexts
    try {
      const t = document.createElement('textarea');
      t.value = text;
      t.setAttribute('readonly', '');
      t.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
      document.body.appendChild(t);
      t.select();
      const ok = document.execCommand('copy');
      t.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

let toastEl = null;
let toastTimer = 0;
function toast(message) {
  if (!toastEl) {
    toastEl = document.createElement('div');
    toastEl.className = 'toast';
    toastEl.setAttribute('role', 'status');
    toastEl.setAttribute('aria-live', 'polite');
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = message;
  toastEl.classList.add('is-on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), 3400);
}

export function initUI() {
  const root = document.documentElement;
  const loader = document.getElementById('loader');
  const pct = document.getElementById('loader-pct');
  const bar = document.getElementById('loader-bar');
  const label = document.getElementById('loader-label');
  const gauge = document.querySelector('.gauge');
  const gaugeValue = document.querySelector('.gauge__value');
  const year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());

  // e-mail and phone links are assembled here so they aren't sitting in the HTML for scrapers.
  // A click opens the mail app with a subject and also copies the address — webmail users can paste it.
  document.querySelectorAll('[data-mail]').forEach((a) => {
    const [user, domain] = a.dataset.mail.split('|');
    const address = `${user}@${domain}`;
    a.href = `mailto:${address}?subject=${encodeURIComponent(MAIL_SUBJECT)}`;
    if (a.hasAttribute('data-show')) a.textContent = address;
    a.addEventListener('click', async () => {
      if (await copyText(address)) toast(`Address copied: ${address}`);
    });
  });
  document.querySelectorAll('[data-tel]').forEach((a) => {
    const number = a.dataset.tel.split('|').join(' ');
    a.href = `tel:${number.replace(/[^0-9+]/g, '')}`;
    a.textContent = number;
  });

  // stagger the words of the final sentence
  document.querySelectorAll('.finale__line .w').forEach((w, i) => w.style.setProperty('--i', i));

  // reveal chapters as they enter the viewport
  const chapters = [...document.querySelectorAll('[data-chapter]')];
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) e.target.classList.add('is-in');
    },
    { threshold: 0.18, rootMargin: '0px 0px -8% 0px' },
  );
  chapters.forEach((c) => io.observe(c));

  // active nav link
  const links = [...document.querySelectorAll('.nav__links a')];
  const setActive = (id) => {
    for (const a of links) a.classList.toggle('is-active', a.getAttribute('href') === `#${id}`);
    document.body.dataset.scene = id;
  };
  const navIO = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) setActive(e.target.id);
    },
    { threshold: 0.5 },
  );
  chapters.forEach((c) => navIO.observe(c));

  // optional soundscape (always user-initiated)
  const sound = document.querySelector('.nav__sound');
  if (sound && (window.AudioContext || window.webkitAudioContext)) {
    const audio = new ForestAudio();
    sound.addEventListener('click', async () => {
      const on = await audio.toggle();
      sound.setAttribute('aria-pressed', String(on));
    });
    document.addEventListener('visibilitychange', () => {
      if (!audio.ctx) return;
      if (document.hidden) audio.ctx.suspend();
      else if (audio.on) audio.ctx.resume();
    });
  } else if (sound) {
    sound.hidden = true;
  }

  // "Just the forest": hide every word and drift slowly through the walk; a quiet card keeps the essentials.
  const zen = document.querySelector('.nav__zen');
  if (zen) {
    const card = document.querySelector('.zen-card');
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let on = false;
    let lastInput = 0;
    let dir = 1;
    let acc = 0;
    let prev = 0;
    let raf = 0;
    const drift = (now) => {
      if (!on) return;
      raf = requestAnimationFrame(drift);
      const dt = Math.min(0.1, (now - prev) / 1000);
      prev = now;
      // any scroll, touch or key pauses the drift for a while
      if (reduced || now - lastInput < 8000) return;
      const max = document.documentElement.scrollHeight - innerHeight;
      if (max <= 0) return;
      // the whole walk takes about four minutes, then it turns around
      acc += (max / 240) * dt * dir;
      const step = Math.trunc(acc);
      if (step !== 0) {
        window.scrollBy({ top: step, behavior: 'instant' });
        acc -= step;
      }
      if (scrollY >= max - 1 && dir > 0) dir = -1;
      if (scrollY <= 1 && dir < 0) dir = 1;
    };
    const input = () => {
      lastInput = performance.now();
    };
    const setZen = (v) => {
      on = v;
      root.classList.toggle('zen', on);
      zen.setAttribute('aria-pressed', String(on));
      zen.setAttribute('aria-label', on ? 'Bring back the text' : 'Let me zone out a little: hide the text');
      zen.title = on ? 'Bring back the text' : 'Let me zone out a little';
      if (card) card.setAttribute('aria-hidden', String(!on));
      cancelAnimationFrame(raf);
      if (on) {
        lastInput = performance.now() - 5000;
        prev = performance.now();
        raf = requestAnimationFrame(drift);
      }
    };
    for (const ev of ['wheel', 'touchstart', 'keydown', 'pointerdown']) addEventListener(ev, input, { passive: true });
    zen.addEventListener('click', () => setZen(!on));
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && on) setZen(false);
    });
    if (new URLSearchParams(location.search).has('zen')) setZen(true);
  }

  const onScroll = () => root.classList.toggle('is-scrolled', scrollY > innerHeight * 0.6);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  let shownPct = 0;
  return {
    chapters,
    // season button + panel (only shown once the 3D forest is running)
    bindSeasons(state) {
      const box = document.querySelector('.season');
      if (!box) return;
      box.hidden = false;
      const toggle = box.querySelector('.season__toggle');
      const panel = box.querySelector('.season__panel');
      const range = box.querySelector('.season__range');
      const name = box.querySelector('.season__name');
      const icon = box.querySelector('.season__icon');
      const segs = [...box.querySelectorAll('[data-season]')];
      const today = box.querySelector('.season__today');
      let lastIndex = -1;
      const sync = () => {
        const v = state.target;
        const i = seasonIndex(v);
        if (i !== lastIndex) {
          name.textContent = SEASON_NAMES[i];
          icon.innerHTML = SEASON_ICONS[i];
          segs.forEach((b, k) => b.classList.toggle('is-on', k === i));
          lastIndex = i;
        }
        range.value = v.toFixed(2);
        range.setAttribute('aria-valuetext', `${SEASON_NAMES[i]}, ${monthOf(v)}`);
        toggle.setAttribute('aria-label', `Season: ${SEASON_NAMES[i]}. Change the season`);
      };
      let closeTimer = 0;
      const open = () => {
        clearTimeout(closeTimer);
        panel.hidden = false;
        void panel.offsetWidth;
        panel.classList.add('is-open');
        toggle.setAttribute('aria-expanded', 'true');
      };
      const close = () => {
        panel.classList.remove('is-open');
        toggle.setAttribute('aria-expanded', 'false');
        closeTimer = setTimeout(() => (panel.hidden = true), 350);
      };
      toggle.addEventListener('click', () => (panel.hidden ? open() : close()));
      range.addEventListener('input', () => {
        state.set(Number(range.value));
        sync();
      });
      segs.forEach((b) =>
        b.addEventListener('click', () => {
          state.set(Number(b.dataset.season));
          sync();
        }),
      );
      today.addEventListener('click', () => {
        state.set(seasonFromDate());
        sync();
      });
      document.addEventListener('pointerdown', (e) => {
        if (!panel.hidden && !box.contains(e.target)) close();
      });
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !panel.hidden) {
          close();
          toggle.focus();
        }
      });
      sync();
    },
    progress(p, text) {
      shownPct = Math.max(shownPct, Math.round(p * 100));
      if (pct) pct.textContent = String(shownPct);
      if (bar) bar.style.width = `${shownPct}%`;
      if (text && label) label.textContent = text;
    },
    done() {
      loader?.classList.add('is-done');
      root.classList.add('is-ready');
      // lens-like glass edges, built once the forest is up so they don't compete with loading
      setTimeout(() => initLiquidGlass(), 400);
      setTimeout(() => loader?.remove(), 1600);
    },
    gauge(story) {
      if (!gauge) return;
      const p = Math.min(1, Math.max(0, story.s / 4));
      gauge.style.setProperty('--p', p.toFixed(4));
      const h = story.height;
      gaugeValue.textContent = h >= 2 ? `${Math.round(h)} m` : `${h.toFixed(1)} m`;
    },
  };
}
