// Narnia Jeopardy sound effects, shared by the TV and the phones.
//
// Every action has a slot. If a file with the slot's name exists in /sounds
// (for example sounds/daily-double.mp3), that file plays. If not, a built-in
// sound made right here in the browser plays instead, so the game always has sound.
//
// To use your own clip: save it as sounds/<slot name>.mp3 next to index.html.
// Slots are listed in SLOT_NAMES below and in the README.

(function () {
  const SLOT_NAMES = [
    'board-fill',    // the board appears at the start of a round
    'pick',          // a clue is picked from the board
    'reveal',        // the clue text appears
    'buzz-in',       // a team buzzes in (TV)
    'phone-buzz',    // the buzz press on a phone
    'too-early',     // buzzed before the buzzers opened
    'times-up',      // nobody buzzed in time, or the Final clock ran out
    'right',         // correct answer
    'wrong',         // wrong answer
    'daily-double',  // Daily Double found
    'team-joined',   // a team arrives in the lobby
    'round-end',     // end of a round
    'final-think',   // Final Jeopardy think music (30 seconds)
    'category-reveal', // a category flips open on the board
    'winner',        // winner fanfare
  ];

  // How loud a sample must be to count as "the sound has started" (0 to 1).
  // Anything quieter at the start of a clip is treated as silence and skipped.
  const SILENCE_THRESHOLD = 0.02;
  const PRE_ROLL_SECONDS = 0.01; // keep this much before the first loud sample so the attack isn't clipped

  let ctx = null;
  let master = null;
  const files = {};   // slot -> { buffer, offset } once a custom file has loaded
  const checked = {}; // slot -> true once we've looked

  function ac() {
    if (!ctx) {
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
        master = ctx.createGain();
        master.gain.value = 0.5;
        master.connect(ctx.destination);
      } catch (e) { return null; }
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  // Where does the sound actually start? Scan from the beginning for the first
  // sample louder than the threshold, on any channel, and back off a hair.
  function findStart(buffer) {
    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) channels.push(buffer.getChannelData(c));
    for (let i = 0; i < buffer.length; i++) {
      for (const data of channels) {
        if (Math.abs(data[i]) > SILENCE_THRESHOLD) {
          return Math.max(0, i / buffer.sampleRate - PRE_ROLL_SECONDS);
        }
      }
    }
    return 0; // all quiet: play it as it is
  }

  // Look for custom files once, quietly. A missing file is fine: the built-in sound plays.
  // Found files are decoded up front so they play instantly, minus their leading silence.
  function probe(base) {
    const c = ac();
    if (!c) return;
    for (const slot of SLOT_NAMES) {
      if (checked[slot]) continue;
      checked[slot] = true;
      fetch((base || '') + 'sounds/' + slot + '.mp3', { cache: 'no-cache' })
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .then((bytes) => bytes && new Promise((res, rej) => c.decodeAudioData(bytes, res, rej)))
        .then((buffer) => {
          if (!buffer) return;
          const offset = findStart(buffer);
          files[slot] = { buffer, offset };
          if (offset > 0.05) console.info(`Sound "${slot}": skipping ${offset.toFixed(2)}s of silence at the start.`);
        })
        .catch(() => {}); // not there, or not a playable file: keep the built-in sound
    }
  }

  // Play a decoded custom file from where its sound starts. Returns the source so it can be stopped.
  function playFile(slot) {
    const c = ac(); const f = files[slot];
    if (!c || !f) return null;
    const src = c.createBufferSource();
    src.buffer = f.buffer;
    src.connect(master);
    src.start(0, f.offset);
    return src;
  }

  // ---------- tiny synth ----------
  function note(freq, start, dur, opts = {}) {
    const c = ac(); if (!c) return;
    const t0 = c.currentTime + start;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = opts.type || 'square';
    osc.frequency.setValueAtTime(freq, t0);
    if (opts.slideTo) osc.frequency.exponentialRampToValueAtTime(opts.slideTo, t0 + dur);
    const vol = opts.vol == null ? 0.18 : opts.vol;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    g.gain.setValueAtTime(vol, t0 + Math.max(0.02, dur - 0.05));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(opts.out || master);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
    return osc;
  }
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);

  function noise(start, dur, vol = 0.15) {
    const c = ac(); if (!c) return;
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource();
    const g = c.createGain();
    g.gain.value = vol;
    src.buffer = buf; src.connect(g); g.connect(master);
    src.start(c.currentTime + start);
  }

  // ---------- built-in sounds ----------
  const BUILTIN = {
    'board-fill'() { // a cascade of quick blips, like tiles flipping in
      for (let i = 0; i < 18; i++) note(hz(72 + ((i * 7) % 12)), i * 0.045, 0.06, { vol: 0.08 });
      note(hz(84), 18 * 0.045, 0.25, { type: 'triangle', vol: 0.15 });
    },
    'pick'() { note(hz(76), 0, 0.07, { vol: 0.12 }); note(hz(83), 0.07, 0.1, { vol: 0.12 }); },
    'reveal'() { note(hz(60), 0, 0.35, { type: 'triangle', slideTo: hz(72), vol: 0.14 }); },
    'buzz-in'() { // a bright two-tone ring-in
      note(hz(88), 0, 0.12, { vol: 0.14 }); note(hz(93), 0.12, 0.12, { vol: 0.14 });
      note(hz(88), 0.24, 0.12, { vol: 0.14 }); note(hz(93), 0.36, 0.2, { vol: 0.14 });
    },
    'phone-buzz'() { note(hz(81), 0, 0.15, { vol: 0.2 }); },
    'too-early'() { note(hz(52), 0, 0.12, { type: 'sawtooth', vol: 0.12 }); note(hz(50), 0.13, 0.18, { type: 'sawtooth', vol: 0.12 }); },
    'times-up'() { // three short descending beeps, then a low tone
      [0, 0.18, 0.36].forEach((t, i) => note(hz(74 - i * 2), t, 0.13, { vol: 0.16 }));
      note(hz(55), 0.56, 0.6, { type: 'triangle', vol: 0.2 });
    },
    'right'() { [72, 76, 79, 84].forEach((m, i) => note(hz(m), i * 0.08, 0.12, { vol: 0.13 })); },
    'wrong'() { note(hz(45), 0, 0.5, { type: 'sawtooth', vol: 0.16 }); note(hz(46), 0, 0.5, { type: 'square', vol: 0.08 }); },
    'daily-double'() { // a laser zoom then a shimmer
      note(hz(48), 0, 0.6, { type: 'sawtooth', slideTo: hz(96), vol: 0.14 });
      for (let i = 0; i < 10; i++) note(hz(84 + (i % 2) * 7), 0.6 + i * 0.06, 0.06, { vol: 0.09 });
      note(hz(84), 1.25, 0.5, { type: 'triangle', vol: 0.16 });
    },
    'category-reveal'() { // a quick swoosh up into a bright ding
      note(hz(60), 0, 0.18, { type: 'triangle', slideTo: hz(84), vol: 0.1 });
      noise(0, 0.15, 0.04);
      note(hz(88), 0.17, 0.35, { type: 'triangle', vol: 0.16 });
      note(hz(95), 0.17, 0.35, { type: 'sine', vol: 0.08 });
    },
    'team-joined'() { note(hz(79), 0, 0.08, { vol: 0.1 }); note(hz(86), 0.08, 0.14, { vol: 0.1 }); },
    'round-end'() { [67, 72, 76, 79, 76, 79, 84].forEach((m, i) => note(hz(m), i * 0.11, 0.14, { vol: 0.12 })); noise(0.8, 0.3, 0.05); },
    'winner'() { // fanfare
      const tune = [[67, 0.15], [72, 0.15], [76, 0.15], [79, 0.3], [76, 0.15], [79, 0.6]];
      let t = 0;
      for (const [m, d] of tune) { note(hz(m), t, d, { vol: 0.14 }); note(hz(m - 12), t, d, { type: 'triangle', vol: 0.12 }); t += d; }
      for (let i = 0; i < 6; i++) noise(t + i * 0.12, 0.08, 0.04);
    },
  };

  // Original 8-bit "thinking" tune, about 30 seconds. Not the show's song;
  // drop your own sounds/final-think.mp3 to replace it.
  let thinkTimer = null;
  let thinkGain = null;
  function playThinkBuiltin() {
    const c = ac(); if (!c) return;
    thinkGain = c.createGain(); thinkGain.gain.value = 1; thinkGain.connect(master);
    const out = thinkGain;
    const step = 60 / 132 / 2; // eighth notes at 132 bpm
    const lead = [69, 72, 76, 72, 74, 72, 69, 67, 69, 72, 76, 79, 77, 76, 74, null,
                  72, 74, 76, 72, 74, 76, 77, 74, 76, 74, 72, 71, 69, null, 69, null];
    const bass = [45, 45, 48, 48, 50, 50, 52, 52, 53, 53, 52, 52, 50, 50, 52, 52];
    let t = 0;
    for (let pass = 0; pass < 4; pass++) {
      const up = pass === 2 ? 12 : 0;
      lead.forEach((m, i) => { if (m) note(hz(m + up), t + i * step, step * 0.9, { vol: 0.09, out }); });
      bass.forEach((m, i) => note(hz(m), t + i * step * 2, step * 1.8, { type: 'triangle', vol: 0.16, out }));
      t += lead.length * step;
    }
    note(hz(57), t, 0.8, { type: 'triangle', vol: 0.18, out });
  }

  let thinkFile = null;
  const Sounds = {
    SLOT_NAMES,
    unlock() { ac(); },
    probe,
    hasFile(slot) { return !!files[slot]; },
    play(slot) {
      try { if (playFile(slot)) return; } catch (e) {}
      if (BUILTIN[slot]) BUILTIN[slot]();
    },
    startThink() {
      Sounds.stopThink();
      try { thinkFile = playFile('final-think'); } catch (e) { thinkFile = null; }
      if (!thinkFile) playThinkBuiltin();
    },
    stopThink() {
      if (thinkFile) { try { thinkFile.stop(); } catch (e) {} thinkFile = null; }
      if (thinkGain && ctx) {
        try { thinkGain.gain.setValueAtTime(0.0001, ctx.currentTime); thinkGain.disconnect(); } catch (e) {}
        thinkGain = null;
      }
      clearTimeout(thinkTimer);
    },
  };
  window.Sounds = Sounds;
})();
