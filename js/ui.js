// DOM side of the experience: loader, reveal-on-scroll, active nav link, height gauge, sound toggle.
import { ForestAudio } from './audio.js';
import { initLiquidGlass } from './liquid-glass.js';

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

  const onScroll = () => root.classList.toggle('is-scrolled', scrollY > innerHeight * 0.6);
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  let shownPct = 0;
  return {
    chapters,
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
