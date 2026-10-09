// Optional morning soundscape, fully synthesised with Web Audio (no files):
// wind moving through the crowns + great tits (talgoxe) and a robin-like trill, in a soft forest reverb.

function noiseBuffer(ctx, seconds = 4) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let last = 0;
    for (let i = 0; i < len; i++) {
      // brown-ish noise: soft and deep like distant wind
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      d[i] = last * 3.2;
    }
  }
  return buf;
}

function reverbImpulse(ctx, seconds = 2.6, decay = 3.2) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return buf;
}

export class ForestAudio {
  constructor() {
    this.ctx = null;
    this.on = false;
    this.timer = 0;
  }

  init() {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = 0;
    this.master.connect(ctx.destination);

    this.reverb = ctx.createConvolver();
    this.reverb.buffer = reverbImpulse(ctx);
    const wet = ctx.createGain();
    wet.gain.value = 0.35;
    this.reverb.connect(wet).connect(this.master);
    this.dry = ctx.createGain();
    this.dry.gain.value = 0.8;
    this.dry.connect(this.master);

    // wind
    const src = ctx.createBufferSource();
    src.buffer = noiseBuffer(ctx);
    src.loop = true;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 520;
    lp.Q.value = 0.4;
    const windGain = ctx.createGain();
    windGain.gain.value = 0.16;
    // slow gusts
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoAmt = ctx.createGain();
    lfoAmt.gain.value = 0.09;
    lfo.connect(lfoAmt).connect(windGain.gain);
    const lfo2 = ctx.createOscillator();
    lfo2.frequency.value = 0.05;
    const lfo2Amt = ctx.createGain();
    lfo2Amt.gain.value = 260;
    lfo2.connect(lfo2Amt).connect(lp.frequency);
    src.connect(lp).connect(windGain);
    windGain.connect(this.dry);
    windGain.connect(this.reverb);
    src.start();
    lfo.start();
    lfo2.start();
  }

  // a single whistled note with a pitch glide
  note(t, f0, f1, dur, gain, pan) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    o.connect(g).connect(p);
    p.connect(this.dry);
    p.connect(this.reverb);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // talgoxe: "ti-ta ti-ta ti-ta"
  greatTit() {
    const t0 = this.ctx.currentTime + 0.05;
    const pan = Math.random() * 1.6 - 0.8;
    const vol = 0.025 + Math.random() * 0.03;
    const hi = 4600 + Math.random() * 600;
    const lo = hi * (0.72 + Math.random() * 0.06);
    const reps = 3 + Math.floor(Math.random() * 3);
    for (let i = 0; i < reps; i++) {
      const t = t0 + i * 0.36;
      this.note(t, hi, hi * 0.97, 0.09, vol, pan);
      this.note(t + 0.15, lo * 1.04, lo, 0.13, vol * 0.85, pan);
    }
  }

  // a softer, descending trill further away
  trill() {
    const t0 = this.ctx.currentTime + 0.05;
    const pan = Math.random() * 1.6 - 0.8;
    const vol = 0.012 + Math.random() * 0.012;
    let f = 6200 + Math.random() * 800;
    const n = 7 + Math.floor(Math.random() * 6);
    for (let i = 0; i < n; i++) {
      const t = t0 + i * 0.075;
      this.note(t, f, f * 0.86, 0.06, vol, pan);
      f *= 0.955;
    }
    this.note(t0 + n * 0.075 + 0.05, f * 1.3, f * 0.7, 0.22, vol * 1.2, pan);
  }

  schedule() {
    clearTimeout(this.timer);
    if (!this.on) return;
    const wait = 2500 + Math.random() * 6500;
    this.timer = setTimeout(() => {
      if (!this.on) return;
      if (Math.random() < 0.62) this.greatTit();
      else this.trill();
      this.schedule();
    }, wait);
  }

  async toggle() {
    if (!this.ctx) this.init();
    this.on = !this.on;
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(this.on ? 0.9 : 0, t, 0.6);
    if (this.on) {
      setTimeout(() => this.greatTit(), 900);
      this.schedule();
    } else {
      clearTimeout(this.timer);
    }
    return this.on;
  }
}
