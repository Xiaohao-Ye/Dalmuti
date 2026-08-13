/* De Grote Dalmuti — procedurele achtergrondmuziek (WebAudio, geen samples).
   Balatro-stijl funk-groove: four-on-the-floor met open hats op de offbeat,
   syncopische funkbas, clavinet-stabs en een dromerige pad op een hypnotische
   dorische vamp — met een reactief lowpass-filter dat opengaat bij spannende
   momenten.

   API: Music.start(), Music.toggle(), Music.lift(bool), Music.excite(0..1),
        Music.duck(bool), Music.enabled */
'use strict';

const Music = (() => {
  const BPM = 112;
  const STEP = 60 / BPM / 4;          // duur van een 16e noot
  const BARS = 4;
  const STEPS = BARS * 16;
  const SWING = STEP * 0.16;          // lichte 16e-noten shuffle (funk)

  // Dorische vamp à la Balatro: Am7 – Am7 – D9 – Am7 (MIDI-nummers)
  const CHORDS = [
    [57, 60, 64, 67],       // A C E G   (Am7)
    [57, 60, 64, 67],
    [50, 54, 57, 60, 64],   // D F# A C E (D9 — de F# geeft die dorische glans)
    [57, 60, 64, 67],
  ];
  // melodie: A-mineur pentatoniek, met F# als kleur op de D9-maat
  const PENTA = [69, 72, 74, 76, 79, 81];
  const PENTA_D = [69, 72, 74, 76, 78, 81];

  let ctx = null;
  let masterGain, duckGain, filter, chordBus, tremolo;
  let noiseBuf, crackleSrc;
  let timer = null;
  let nextTime = 0;
  let step = 0;
  let melody = {};                    // step -> midi, elke loop opnieuw
  let enabled = localStorage.getItem('dalmuti.music') !== 'uit';
  let playing = false;
  let lifted = false;                 // jouw beurt: filter iets open
  let boost = 0;                      // tijdelijke bump door events
  let progress = 0;                   // 0..1: hoe spannend staat de ronde ervoor
  let loops = 0;                      // afgespeelde loops (voor secties A/B)
  let lastTick = 0;

  const midiToFreq = m => 440 * Math.pow(2, (m - 69) / 12);

  /* ---------- opbouw ---------- */

  function ensureCtx() {
    if (ctx) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();

    masterGain = ctx.createGain();
    masterGain.gain.value = 0.55;
    duckGain = ctx.createGain();
    duckGain.gain.value = 1;

    filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 900;
    filter.Q.value = 0.4;

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -20;
    comp.ratio.value = 5;

    filter.connect(comp).connect(duckGain).connect(masterGain).connect(ctx.destination);

    // aparte bus met langzame wah-achtige tremolo voor stabs en pad
    chordBus = ctx.createGain();
    chordBus.gain.value = 1;
    tremolo = ctx.createOscillator();
    tremolo.frequency.value = 3.1;
    const tremGain = ctx.createGain();
    tremGain.gain.value = 0.1;
    tremolo.connect(tremGain).connect(chordBus.gain);
    tremolo.start();
    chordBus.connect(filter);

    // ruisbuffer voor drums
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const nd = noiseBuf.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  }

  /* ---------- instrumenten ---------- */

  /* Funkbas: staccato, met een vleugje zaagtand voor grit */
  function bass(t, midi, dur, vel) {
    const f = midiToFreq(midi);
    const o1 = ctx.createOscillator();
    o1.type = 'triangle';
    o1.frequency.value = f;
    const o2 = ctx.createOscillator();
    o2.type = 'sawtooth';
    o2.frequency.value = f;
    const g2 = ctx.createGain();
    g2.gain.value = 0.25;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 520;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel, t + 0.012);
    g.gain.setTargetAtTime(0.0001, t + dur * 0.55, 0.045); // kort en punchy
    o1.connect(lp);
    o2.connect(g2).connect(lp);
    lp.connect(g).connect(filter);
    o1.start(t); o2.start(t);
    o1.stop(t + dur + 0.3); o2.stop(t + dur + 0.3);
  }

  /* Clavinet-achtige stab: kort, knorrig, door een bandpass */
  function clav(t, midi, vel) {
    const o = ctx.createOscillator();
    o.type = 'square';
    o.frequency.value = midiToFreq(midi);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1350;
    bp.Q.value = 1.6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel, t + 0.004);
    g.gain.setTargetAtTime(0.0001, t + 0.03, 0.035);
    o.connect(bp).connect(g).connect(chordBus);
    o.start(t);
    o.stop(t + 0.25);
  }

  /* Dromerige pad: detuned, traag, diep gefilterd — de zweverige onderlaag */
  function pad(t, notes, dur) {
    notes.forEach(m => {
      const f = midiToFreq(m);
      [-7, 7].forEach(cents => {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = f;
        o.detune.value = cents;
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 640;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.016, t + dur * 0.35);
        g.gain.setTargetAtTime(0.0001, t + dur * 0.8, dur * 0.15);
        o.connect(lp).connect(g).connect(chordBus);
        o.start(t);
        o.stop(t + dur * 1.3);
      });
    });
  }

  /* Zachte e-piano voor een enkel accent */
  function ePiano(t, midi, vel, dur) {
    const f = midiToFreq(midi);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel, t + 0.008);
    g.gain.setTargetAtTime(0.0001, t + 0.05, dur * 0.55);
    const o1 = ctx.createOscillator();
    o1.type = 'sine';
    o1.frequency.value = f;
    const o2 = ctx.createOscillator();
    o2.type = 'triangle';
    o2.frequency.value = f * 2.004;
    const g2 = ctx.createGain();
    g2.gain.value = 0.28;
    o1.connect(g);
    o2.connect(g2).connect(g);
    g.connect(chordBus);
    o1.start(t); o2.start(t);
    o1.stop(t + dur + 1); o2.stop(t + dur + 1);
  }

  function kick(t) {
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(130, t);
    o.frequency.exponentialRampToValueAtTime(46, t + 0.08);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
    o.connect(g).connect(filter);
    o.start(t);
    o.stop(t + 0.2);
  }

  function hat(t, open, vol) {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7500;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + (open ? 0.16 : 0.035));
    s.connect(hp).connect(g).connect(filter);
    s.start(t, Math.random());
    s.stop(t + 0.25);
  }

  function snare(t) {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2000;
    bp.Q.value = 0.8;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.15, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    s.connect(bp).connect(g).connect(filter);
    s.start(t, Math.random());
    s.stop(t + 0.15);
  }

  function lead(t, midi) {
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = midiToFreq(midi);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.05, t + 0.02);
    g.gain.setTargetAtTime(0.0001, t + 0.12, 0.16);
    o.connect(g).connect(chordBus);
    o.start(t);
    o.stop(t + 0.7);
  }

  /* Vinylkraak: heel subtiel, schaarse tikjes in een geloopte buffer */
  function startCrackle() {
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < 40; i++) {
      const pos = Math.floor(Math.random() * d.length);
      const len = 2 + Math.floor(Math.random() * 20);
      for (let j = 0; j < len && pos + j < d.length; j++) {
        d[pos + j] = (Math.random() * 2 - 1) * Math.exp(-j / 6) * 0.5;
      }
    }
    crackleSrc = ctx.createBufferSource();
    crackleSrc.buffer = buf;
    crackleSrc.loop = true;
    const g = ctx.createGain();
    g.gain.value = 0.02;
    crackleSrc.connect(g).connect(duckGain);
    crackleSrc.start();
  }

  /* ---------- compositie per 16e stap ---------- */

  function scheduleStep(s, t) {
    const bar = Math.floor(s / 16);
    const pos = s % 16;
    const chord = CHORDS[bar];
    const nextChord = CHORDS[(bar + 1) % BARS];
    const section = Math.floor(loops / 2) % 2; // om de 2 loops: vers A ↔ vers B
    if (pos % 2 === 1) t += SWING; // funk-shuffle op de 16e noten

    // drums: disco/funk — kick op elke tel, open hat op de offbeats.
    // Hoe spannender de ronde, hoe drukker de 16e ghost-tikjes.
    if (pos % 4 === 0) kick(t);
    if (pos === 4 || pos === 12) snare(t);
    if (pos % 4 === 2) hat(t, true, 0.055 + progress * 0.015);
    else if (pos % 2 === 0) hat(t, false, 0.03);
    else if (Math.random() < 0.25 + progress * 0.55) hat(t, false, 0.015 + progress * 0.01);

    // funkbas: vers A is de hoofdgroove, vers B een drukkere variant
    const r = chord[0] - 24;
    if (section === 0) {
      if (pos === 0) bass(t, r, STEP * 2.2, 0.34);
      if (pos === 3) bass(t, r + 12, STEP * 1.1, 0.2);
      if (pos === 6) bass(t, r + 12, STEP * 1.2, 0.26);
      if (pos === 8) bass(t, r + 7, STEP * 1.8, 0.3);
      if (pos === 11) bass(t, r + 10, STEP * 1.1, 0.22);
      if (pos === 12) bass(t, r, STEP * 1.6, 0.3);
      if (pos === 15) bass(t, nextChord[0] - 24 + (Math.random() < 0.5 ? 2 : -1), STEP * 0.9, 0.2);
    } else {
      if (pos === 0) bass(t, r, STEP * 1.6, 0.34);
      if (pos === 2) bass(t, r, STEP * 0.8, 0.16);
      if (pos === 4) bass(t, r + 12, STEP * 1.1, 0.24);
      if (pos === 7) bass(t, r + 10, STEP * 1.3, 0.28);
      if (pos === 10) bass(t, r + 7, STEP * 1.1, 0.26);
      if (pos === 12) bass(t, r + 5, STEP * 1.2, 0.26);
      if (pos === 14) bass(t, r + 3, STEP * 0.9, 0.2); // chromatisch afdalen
    }

    // pad: één zweverig akkoord per maat (in vers B een octaaf hoger)
    if (pos === 0) pad(t, section === 0 ? chord.slice(1) : chord.slice(1).map(m => m + 12), STEP * 16);

    // clavinet-stabs: percussief, op de syncopen (ander patroon per vers)
    const voic = chord.slice(-2);
    if (section === 0) {
      if (pos === 3 || pos === 11) voic.forEach(m => clav(t, m, 0.05));
      if (pos === 7) voic.forEach(m => clav(t, m, 0.065));
      if (pos === 14 && bar % 2 === 1) voic.forEach(m => clav(t, m, 0.045));
    } else {
      if (pos === 2 || pos === 6) voic.forEach(m => clav(t, m, 0.055));
      if (pos === 10) voic.forEach(m => clav(t, m + 12, 0.05));
      if (pos === 13) voic.forEach(m => clav(t, m, 0.045));
    }

    // zacht e-piano-accent aan het begin van elke tweede maat
    if (pos === 4 && bar % 2 === (section === 0 ? 0 : 1)) {
      chord.slice(1, 3).forEach((m, i) => ePiano(t + i * 0.012, m, 0.07, 1.1));
    }

    // schaarse melodie, elke loop anders
    if (melody[s] !== undefined) lead(t, melody[s]);
  }

  function regenMelody() {
    melody = {};
    for (let bar = 0; bar < BARS; bar++) {
      if (Math.random() < 0.4) continue; // soms een stille maat
      const scale = bar === 2 ? PENTA_D : PENTA;
      const n = 1 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        const pos = [2, 5, 9, 10, 13][Math.floor(Math.random() * 5)];
        melody[bar * 16 + pos] = scale[Math.floor(Math.random() * scale.length)];
      }
    }
  }

  /* ---------- scheduler & filter-automatisering ---------- */

  function tick() {
    const now = ctx.currentTime;
    while (nextTime < now + 0.35) {
      if (step === 0) { loops++; regenMelody(); }
      scheduleStep(step, nextTime);
      step = (step + 1) % STEPS;
      nextTime += STEP;
    }
    // boost langzaam laten wegzakken
    const dt = now - lastTick;
    lastTick = now;
    boost = Math.max(0, boost - dt * 0.25);
    const x = Math.min(1, (lifted ? 0.5 : 0.22) + progress * 0.22 + boost);
    const freq = 700 + Math.pow(x, 1.6) * 5800;
    filter.frequency.setTargetAtTime(freq, now, 0.25);
  }

  /* ---------- publieke API ---------- */

  function start() {
    if (!enabled || playing) return;
    try {
      ensureCtx();
      if (ctx.state === 'suspended') ctx.resume();
      playing = true;
      step = 0;
      nextTime = ctx.currentTime + 0.06;
      lastTick = ctx.currentTime;
      masterGain.gain.setTargetAtTime(0.55, ctx.currentTime, 0.5);
      startCrackle();
      timer = setInterval(tick, 90);
    } catch (e) { /* audio niet beschikbaar */ }
  }

  function stop() {
    if (!playing) return;
    playing = false;
    clearInterval(timer);
    if (ctx) {
      masterGain.gain.setTargetAtTime(0, ctx.currentTime, 0.15);
      if (crackleSrc) { try { crackleSrc.stop(ctx.currentTime + 0.5); } catch (e) {} }
    }
  }

  return {
    start,
    stop,
    toggle() {
      enabled = !enabled;
      localStorage.setItem('dalmuti.music', enabled ? 'aan' : 'uit');
      if (enabled) start(); else stop();
      return enabled;
    },
    lift(b) { lifted = !!b; },
    excite(x) { boost = Math.max(boost, Math.min(1, x)); },
    setProgress(x) { progress = Math.max(0, Math.min(1, x)); },
    duck(b) {
      if (!ctx) return;
      duckGain.gain.setTargetAtTime(b ? 0.25 : 1, ctx.currentTime, 0.2);
    },
    get enabled() { return enabled; },
    get playing() { return playing; },
    get state() { return ctx ? ctx.state : 'geen context'; },
  };
})();
