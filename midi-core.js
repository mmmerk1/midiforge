(function (root) {
  const SR = 22050;
  const FRAME = 2048;
  const HOP = 256;
  const FPS = SR / HOP;
  const GRID = 4;
  const FMIN = 55;
  const FMAX = 2100;

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let j = 0; j < len / 2; j++) {
          const ur = re[i + j], ui = im[i + j];
          const vr = re[i + j + len / 2] * cr - im[i + j + len / 2] * ci;
          const vi = re[i + j + len / 2] * ci + im[i + j + len / 2] * cr;
          re[i + j] = ur + vr; im[i + j] = ui + vi;
          re[i + j + len / 2] = ur - vr; im[i + j + len / 2] = ui - vi;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
  }

  async function decode(file, onProgress) {
    const arrayBuffer = await file.arrayBuffer();
    const AC = window.AudioContext || window.webkitAudioContext;
    const ac = new AC();
    const buf = await ac.decodeAudioData(arrayBuffer.slice(0));
    const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(buf.duration * SR)), SR);
    const src = off.createBufferSource();
    src.buffer = buf;
    src.connect(off.destination);
    src.start();
    const rendered = await off.startRendering();
    ac.close();
    const data = rendered.getChannelData(0);
    if (onProgress) onProgress(1);
    return { samples: Float32Array.from(data), duration: rendered.duration };
  }

  function transcribe(samples, opts, onProgress) {
    const minNote = (opts && opts.minNote) || 0.05;
    const polyphony = (opts && opts.polyphony) || 5;
    const maxFrames = 1 + Math.floor((samples.length - FRAME) / HOP);
    if (maxFrames <= 0) throw new Error("音频太短，至少需要 0.2 秒");

    const win = new Float32Array(FRAME);
    for (let i = 0; i < FRAME; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (FRAME - 1));

    const nyquistBins = FRAME / 2;
    const gridLo = Math.round((69 + 12 * Math.log2(FMIN / 440)) * GRID);
    const gridHi = Math.round((69 + 12 * Math.log2(FMAX / 440)) * GRID);
    const gridCount = gridHi - gridLo + 1;
    const matrix = new Float32Array(gridCount * maxFrames);

    const re = new Float32Array(FRAME);
    const im = new Float32Array(FRAME);

    for (let f = 0; f < maxFrames; f++) {
      const start = f * HOP;
      for (let i = 0; i < FRAME; i++) {
        re[i] = samples[start + i] * win[i];
        im[i] = 0;
      }
      fft(re, im);
      for (let k = 1; k < nyquistBins; k++) {
        const freq = k * SR / FRAME;
        if (freq < FMIN || freq > FMAX) continue;
        const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
        const note = 69 + 12 * Math.log2(freq / 440);
        const g = Math.round(note * GRID) - gridLo;
        if (g < 0 || g >= gridCount) continue;
        const idx = g * maxFrames + f;
        if (mag > matrix[idx]) matrix[idx] = mag;
      }
      if (onProgress && f % 120 === 0) onProgress(f / maxFrames);
    }

    let peak = 0;
    for (let i = 0; i < matrix.length; i++) if (matrix[i] > peak) peak = matrix[i];
    if (peak <= 0) throw new Error("没听到有效的声音");
    for (let i = 0; i < matrix.length; i++) matrix[i] /= peak;

    const keepPerFrame = Math.max(2, Math.min(8, polyphony + 1));
    const mask = new Uint8Array(matrix.length);
    for (let f = 0; f < maxFrames; f++) {
      const vals = [];
      for (let g = 0; g < gridCount; g++) vals.push([matrix[g * maxFrames + f], g]);
      vals.sort((a, b) => b[0] - a[0]);
      const framePeak = vals.length ? vals[0][0] : 0;
      for (let i = 0; i < Math.min(keepPerFrame, vals.length); i++) {
        const [v, g] = vals[i];
        if (v > 0.05 && v > framePeak * 0.07) mask[g * maxFrames + f] = 1;
      }
    }

    const minFrames = Math.max(2, Math.round(minNote * FPS));
    let notes = [];
    for (let g = 0; g < gridCount; g++) {
      let startF = -1, gap = 0;
      for (let f = 0; f <= maxFrames; f++) {
        const on = f < maxFrames && mask[g * maxFrames + f];
        if (on) {
          if (startF < 0) startF = f;
          gap = 0;
        } else if (startF >= 0) {
          gap++;
          if (gap > 2 || f === maxFrames) {
            const endF = f - gap;
            if (endF - startF + 1 >= minFrames) {
              let sum = 0, cnt = 0;
              for (let x = startF; x <= endF; x++) {
                sum += matrix[g * maxFrames + x];
                cnt++;
              }
              notes.push({
                start: startF / FPS,
                end: (endF + 1) / FPS,
                midi: Math.round((gridLo + g) / GRID),
                grid: gridLo + g,
                conf: sum / Math.max(1, cnt)
              });
              startF = -1;
            } else {
              startF = -1;
            }
          }
        }
      }
    }

    const byGrid = {};
    for (const n of notes) (byGrid[n.grid] = byGrid[n.grid] || []).push(n);
    const overtone = [[48, 0.45], [76, 0.35], [96, 0.28]];
    notes = notes.filter((n) => {
      for (const [off, ratio] of overtone) {
        for (let d = -1; d <= 1; d++) {
          const lower = byGrid[n.grid - off + d];
          if (!lower) continue;
          for (const L of lower) {
            if (L.grid >= n.grid) continue;
            const overlap = Math.min(n.end, L.end) - Math.max(n.start, L.start);
            const span = Math.min(n.end - n.start, L.end - L.start);
            if (overlap > 0 && overlap / Math.max(span, 1e-6) > 0.55 && n.conf < L.conf * ratio * 2.2) return false;
          }
        }
      }
      return true;
    });

    notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
    if (polyphony > 0) {
      const allowed = new Set();
      const times = Array.from(new Set(notes.map((n) => Math.round(n.start * FPS))));
      for (const t of times) {
        const tn = t / FPS;
        const active = notes.filter((n) => n.start <= tn + 1e-6 && n.end > tn);
        active.sort((a, b) => b.conf - a.conf);
        active.slice(0, polyphony).forEach((n) => allowed.add(n));
      }
      notes = notes.filter((n) => allowed.has(n));
    }

    for (const n of notes) {
      n.velocity = Math.max(30, Math.min(120, Math.round(30 + n.conf * 130)));
      delete n.grid;
      delete n.conf;
    }

    const duration = samples.length / SR;
    return { notes, duration, noteCount: notes.length };
  }

  function vlq(v) {
    let out = [v & 0x7f];
    v >>= 7;
    while (v) {
      out.unshift((v & 0x7f) | 0x80);
      v >>= 7;
    }
    return out;
  }

  function writeMidi(notes, duration, bpm) {
    const division = 96;
    const tempoBpm = bpm || 120;
    const usPerQuarter = Math.round(60000000 / tempoBpm);
    const tps = division * tempoBpm / 60;

    const track = [];
    const push = (...bytes) => track.push(...bytes);
    push(0x00, 0xff, 0x51, 0x03, (usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff);
    push(0x00, 0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08);
    const name = "Transcribed";
    push(0x00, 0xff, 0x03, name.length, ...Array.from(name).map((c) => c.charCodeAt(0)));

    const events = [];
    notes.forEach((n, i) => {
      const ch = i % 8;
      const on = Math.round(n.start * tps);
      const off = Math.max(on + 1, Math.round(n.end * tps));
      events.push([on, 1, [0x90 | ch, n.midi & 0x7f, n.velocity & 0x7f]]);
      events.push([off, 0, [0x80 | ch, n.midi & 0x7f, 0x40]]);
    });
    events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

    let last = 0;
    for (const [tick, , payload] of events) {
      push(...vlq(Math.max(0, tick - last)), ...payload);
      last = tick;
    }
    push(0x00, 0xff, 0x2f, 0x00);

    const out = [];
    const put16 = (v) => out.push((v >> 8) & 0xff, v & 0xff);
    const put32 = (v) => out.push((v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
    out.push(0x4d, 0x54, 0x68, 0x64);
    put32(6);
    put16(1);
    put16(2);
    put16(division);
    out.push(0x4d, 0x54, 0x72, 0x6b);
    put32(track.length);
    out.push(...track);
    return new Uint8Array(out);
  }

  function noteName(midi) {
    const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    const oct = Math.floor(midi / 12) - 1;
    return names[midi % 12] + oct;
  }

  root.PitchForge = { decode, transcribe, writeMidi, noteName, SR };
})(typeof self !== "undefined" ? self : this);
