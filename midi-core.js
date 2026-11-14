(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MidiCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  function lame() {
    if (typeof lamejs === "function") return lamejs;
    if (typeof require === "function") {
      const fs = require("fs");
      const path = require("path");
      const vm = require("vm");
      const file = path.join(__dirname, "lame.min.js");
      vm.runInThisContext(fs.readFileSync(file, "utf8") + "\n;globalThis.lamejs = lamejs;");
      return globalThis.lamejs;
    }
    throw new Error("MP3 encoder not loaded");
  }

  function readVarLen(view, state) {
    let value = 0;
    for (let i = 0; i < 4; i++) {
      const b = view.getUint8(state.p++);
      value = (value << 7) | (b & 0x7f);
      if (!(b & 0x80)) break;
    }
    return value;
  }

  function parseMidi(buffer) {
    const view = new DataView(buffer);
    let p = 0;
    const str = (o) => String.fromCharCode(view.getUint8(o), view.getUint8(o + 1), view.getUint8(o + 2), view.getUint8(o + 3));
    if (str(0) !== "MThd") throw new Error("不是有效的 MIDI 文件");
    const headerLen = view.getUint32(4);
    const format = view.getUint16(8);
    const trackCount = view.getUint16(10);
    const division = view.getInt16(12);
    if (division <= 0) throw new Error("暂不支持 SMPTE 时间格式的 MIDI");
    const ppq = division;
    p = 8 + headerLen;

    const tracks = [];
    const tempos = [{ tick: 0, usPerQuarter: 500000 }];

    for (let t = 0; t < trackCount && p + 8 <= view.byteLength; t++) {
      const chunk = str(p);
      const len = view.getUint32(p + 4);
      p += 8;
      if (chunk !== "MTrk") { p += len; continue; }

      const end = p + len;
      const state = { p };
      let tick = 0;
      let running = 0;
      let name = "";
      const open = new Map();
      const notes = [];

      while (state.p < end) {
        tick += readVarLen(view, state);
        let status = view.getUint8(state.p);
        if (status < 0x80) {
          status = running;
        } else {
          state.p++;
          if (status < 0xf0) running = status;
        }

        if (status === 0xff) {
          const type = view.getUint8(state.p++);
          const size = readVarLen(view, state);
          if (type === 0x51 && size >= 3) {
            const us = (view.getUint8(state.p) << 16) | (view.getUint8(state.p + 1) << 8) | view.getUint8(state.p + 2);
            tempos.push({ tick, usPerQuarter: us || 500000 });
          } else if (type === 0x03) {
            let s = "";
            for (let i = 0; i < size; i++) s += String.fromCharCode(view.getUint8(state.p + i));
            name = s.trim();
          }
          state.p += size;
          continue;
        }

        if (status === 0xf0 || status === 0xf7) {
          const size = readVarLen(view, state);
          state.p += size;
          continue;
        }

        const hi = status & 0xf0;
        const channel = status & 0x0f;

        if (hi === 0x90 || hi === 0x80) {
          const note = view.getUint8(state.p);
          const vel = view.getUint8(state.p + 1);
          state.p += 2;
          const key = channel + ":" + note;
          if (hi === 0x90 && vel > 0) {
            if (!open.has(key)) open.set(key, []);
            open.get(key).push({ tick, vel });
          } else {
            const stack = open.get(key);
            if (stack && stack.length) {
              const start = stack.shift();
              notes.push({ tick: start.tick, durationTicks: tick - start.tick, midi: note, velocity: start.vel, channel });
            }
          }
        } else if (hi === 0xc0 || hi === 0xd0) {
          state.p += 1;
        } else {
          state.p += 2;
        }
      }

      for (const [key, stack] of open) {
        const note = Number(key.split(":")[1]);
        const channel = Number(key.split(":")[0]);
        for (const s of stack) notes.push({ tick: s.tick, durationTicks: Math.max(ppq / 8, 1), midi: note, velocity: s.vel, channel });
      }

      tracks.push({ name: name || "Track " + (t + 1), channel: notes.length ? notes[0].channel : 0, notes });
      p = end;
    }

    tempos.sort((a, b) => a.tick - b.tick);
    const tempoMap = [];
    let us = 500000, lastTick = 0, lastSec = 0;
    for (const tm of tempos) {
      if (tempoMap.length) {
        const d = tm.tick - lastTick;
        lastSec += (d / ppq) * (us / 1e6);
      }
      tempoMap.push({ tick: tm.tick, sec: lastSec, usPerQuarter: tm.usPerQuarter });
      lastTick = tm.tick;
      us = tm.usPerQuarter;
    }
    const tempoAt = (tick) => {
      let seg = tempoMap[0];
      for (const s of tempoMap) if (s.tick <= tick) seg = s;
      return seg.sec + ((tick - seg.tick) / ppq) * (seg.usPerQuarter / 1e6);
    };

    const allNotes = [];
    for (const tr of tracks) {
      for (const n of tr.notes) {
        const start = tempoAt(n.tick);
        const endSec = tempoAt(n.tick + n.durationTicks);
        allNotes.push({
          time: start,
          duration: Math.max(0.02, endSec - start),
          midi: n.midi,
          velocity: n.velocity,
          channel: n.channel,
          track: tr.name
        });
      }
    }
    allNotes.sort((a, b) => a.time - b.time);

    const duration = allNotes.reduce((m, n) => Math.max(m, n.time + n.duration), 0);
    const bpm = Math.round(60000000 / tempoMap.filter((s) => s.tick === 0).pop().usPerQuarter);
    const noteCount = allNotes.length;

    return {
      ppq, format, bpm, notes: allNotes, duration, noteCount,
      tempoMap,
      tracks: tracks.map((tr) => ({ name: tr.name, notes: tr.notes.length }))
    };
  }

  const TIMBRES = {
    sine: (ph) => Math.sin(ph),
    triangle: (ph) => (2 / Math.PI) * Math.asin(Math.sin(ph)),
    square: (ph) => (Math.sin(ph) >= 0 ? 1 : -1) * 0.7,
    saw: (ph) => { const t = ph / (Math.PI * 2); return 2 * (t - Math.floor(t + 0.5)); },
    epiano: (ph) => Math.sin(ph) + 0.35 * Math.sin(2 * ph) * Math.exp(-0.002 * ph) + 0.12 * Math.sin(3 * ph)
  };

  function renderNotes(notes, opts) {
    const sr = (opts && opts.sampleRate) || 44100;
    const timbre = (opts && opts.timbre) || "epiano";
    const gain = (opts && opts.gain) || 1;
    const total = notes.reduce((m, n) => Math.max(m, n.time + n.duration), 0);
    const frames = Math.ceil((total + 0.25) * sr);
    const out = new Float32Array(frames);
    const wave = TIMBRES[timbre] || TIMBRES.epiano;
    const twoPi = Math.PI * 2;

    for (const n of notes) {
      const start = Math.floor(n.time * sr);
      const dur = Math.max(24, Math.floor(n.duration * sr));
      const release = Math.min(Math.floor(0.12 * sr), dur);
      const attack = Math.min(Math.floor(0.008 * sr), dur);
      const vel = (n.velocity || 80) / 127;
      const isDrum = n.channel === 9;
      const freq = isDrum ? 0 : 440 * Math.pow(2, (n.midi - 69) / 12);
      const amp = isDrum ? vel * 0.8 * gain : vel * 0.28 * gain;
      const step = twoPi * freq / sr;
      let phase = 0;
      let seed = (n.midi * 7919 + start) % 65536;

      for (let i = 0; i < dur; i++) {
        const idx = start + i;
        if (idx >= frames) break;
        let env;
        if (i < attack) env = i / attack;
        else if (i > dur - release) env = Math.max(0, (dur - i) / release);
        else env = 0.7 + 0.3 * Math.exp(-i / (sr * 0.35));
        let s;
        if (isDrum) {
          seed = (seed * 1103515245 + 12345) & 0x7fffffff;
          s = ((seed / 0x7fffffff) * 2 - 1) * Math.exp(-i / (sr * 0.06));
        } else {
          phase += step;
          s = wave(phase) * Math.exp(-i / (sr * 1.2));
        }
        out[idx] += s * env * amp;
      }
    }

    let peak = 0;
    for (let i = 0; i < frames; i++) peak = Math.max(peak, Math.abs(out[i]));
    if (peak > 0) {
      const k = 0.9 / peak;
      for (let i = 0; i < frames; i++) out[i] = Math.tanh(out[i] * k * 1.02);
    }
    return { pcm: out, sampleRate: sr, duration: frames / sr };
  }

  function encodeMp3(pcm, sampleRate, kbps) {
    const Lame = lame();
    const enc = new Lame.Mp3Encoder(1, sampleRate, kbps || 192);
    const block = 1152;
    const parts = [];
    for (let i = 0; i < pcm.length; i += block) {
      const chunk = pcm.subarray(i, Math.min(i + block, pcm.length));
      const int16 = new Int16Array(chunk.length);
      for (let j = 0; j < chunk.length; j++) {
        const s = Math.max(-1, Math.min(1, chunk[j]));
        int16[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      const buf = enc.encodeBuffer(int16);
      if (buf.length) parts.push(new Int8Array(buf));
    }
    const tail = enc.flush();
    if (tail.length) parts.push(new Int8Array(tail));
    const size = parts.reduce((m, b) => m + b.length, 0);
    const out = new Int8Array(size);
    let off = 0;
    for (const b of parts) { out.set(b, off); off += b.length; }
    return out;
  }

  function encodeMp3Async(pcm, sampleRate, kbps, onProgress) {
    const Lame = lame();
    const enc = new Lame.Mp3Encoder(1, sampleRate, kbps || 192);
    const block = 1152 * 8;
    const parts = [];
    return new Promise((resolve, reject) => {
      let i = 0;
      function step() {
        try {
          const stop = Math.min(i + block, pcm.length);
          const chunk = pcm.subarray(i, stop);
          const int16 = new Int16Array(chunk.length);
          for (let j = 0; j < chunk.length; j++) {
            const s = Math.max(-1, Math.min(1, chunk[j]));
            int16[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          const buf = enc.encodeBuffer(int16);
          if (buf.length) parts.push(new Int8Array(buf));
          i = stop;
          if (onProgress) onProgress(pcm.length ? i / pcm.length : 1);
          if (i < pcm.length) setTimeout(step, 0);
          else {
            const tail = enc.flush();
            if (tail.length) parts.push(new Int8Array(tail));
            const size = parts.reduce((m, b) => m + b.length, 0);
            const out = new Int8Array(size);
            let off = 0;
            for (const b of parts) { out.set(b, off); off += b.length; }
            resolve(out);
          }
        } catch (e) { reject(e); }
      }
      step();
    });
  }

  return { parseMidi, renderNotes, encodeMp3, encodeMp3Async, TIMBRES: Object.keys(TIMBRES) };
});
