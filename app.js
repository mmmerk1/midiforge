const el = (id) => document.getElementById(id);
const state = {
  file: null,
  decoded: null,
  notes: null,
  midiBytes: null,
  mode: "server",
  minNote: 0.05,
  polyphony: 5,
  serverReady: false
};

const wave = el("wave");
const roll = el("roll");
const wctx = wave.getContext("2d");
const rctx = roll.getContext("2d");
const rollLayer = document.createElement("canvas");

let audioCtx = null;
let playing = false;
let playStart = 0;
let raf = null;
let nodes = [];

function fmt(sec) {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return m + ":" + (s < 10 ? "0" : "") + s.toFixed(1);
}

function fmtMm(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return m + ":" + (s < 10 ? "0" : "") + s;
}

function setHint(text, bad) {
  const h = el("hint");
  h.textContent = text;
  h.style.color = bad ? "#ff7a55" : "#5d6774";
}

function setStep(n) {
  document.querySelectorAll(".step").forEach((s) => {
    s.classList.toggle("active", Number(s.dataset.step) <= n);
  });
}

function chipGroup(id, onChange) {
  const wrap = el(id);
  wrap.addEventListener("click", (e) => {
    const b = e.target.closest(".chip");
    if (!b || b.disabled) return;
    wrap.querySelectorAll(".chip").forEach((c) => c.classList.remove("on"));
    b.classList.add("on");
    onChange(b.dataset.v);
  });
}

chipGroup("modeChips", (v) => {
  state.mode = v;
  if (v === "server" && !state.serverReady) {
    setHint("这个页面没有连到后端，会自动用浏览器内引擎。", true);
    state.mode = "local";
    const s = el("modeChips").querySelector('[data-v="local"]');
    el("modeChips").querySelectorAll(".chip").forEach((c) => c.classList.remove("on"));
    s.classList.add("on");
  }
});
chipGroup("minNoteChips", (v) => { state.minNote = Number(v); });
chipGroup("polyChips", (v) => { state.polyphony = Number(v); });

async function checkServer() {
  try {
    const r = await fetch("api/health", { cache: "no-store" });
    if (!r.ok) throw new Error("no");
    const j = await r.json();
    if (!j.ok) throw new Error("no");
    state.serverReady = true;
    el("engine").classList.add("ok");
    el("engine").innerHTML = "<i></i>后端已连接";
  } catch (e) {
    state.serverReady = false;
    el("engine").innerHTML = "<i></i>纯浏览器";
    const srv = el("modeChips").querySelector('[data-v="server"]');
    if (srv) srv.disabled = true;
    const loc = el("modeChips").querySelector('[data-v="local"]');
    el("modeChips").querySelectorAll(".chip").forEach((c) => c.classList.remove("on"));
    loc.classList.add("on");
    state.mode = "local";
  }
}

function layoutCanvas(canvas, ctx, h) {
  const w = canvas.clientWidth || 600;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.height = h + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}

function drawWave() {
  const { w, h } = layoutCanvas(wave, wctx, 96);
  wctx.clearRect(0, 0, w, h);
  const samples = state.decoded.samples;
  const bars = Math.min(240, Math.floor(w / 3));
  const per = Math.floor(samples.length / bars);
  wctx.fillStyle = "rgba(163,255,18,.55)";
  for (let i = 0; i < bars; i++) {
    let peak = 0;
    for (let j = 0; j < per; j++) peak = Math.max(peak, Math.abs(samples[i * per + j] || 0));
    const bh = Math.max(1, peak * h * 0.9);
    wctx.fillRect(i * (w / bars), (h - bh) / 2, Math.max(1, w / bars - 1.5), bh);
  }
}

function drawRoll(ratio) {
  if (!state.notes || !state.notes.length) return;
  const { w, h } = layoutCanvas(roll, rctx, 200);
  const dur = state.decoded ? state.decoded.duration : Math.max(...state.notes.map((n) => n.end));

  if (!rollLayer.dataset.drawn || rollLayer.dataset.w !== String(w)) {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    rollLayer.width = Math.round(w * dpr);
    rollLayer.height = Math.round(h * dpr);
    const c = rollLayer.getContext("2d");
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, w, h);

    let lo = 127, hi = 0;
    for (const n of state.notes) { lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi); }
    lo = Math.max(0, lo - 1); hi = Math.min(127, hi + 1);
    const rows = Math.max(8, hi - lo + 1);

    c.strokeStyle = "rgba(255,255,255,.04)";
    c.lineWidth = 1;
    for (let i = 0; i <= 8; i++) {
      const y = (h / 8) * i;
      c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke();
    }

    for (const n of state.notes) {
      const x = (n.start / dur) * w;
      const bw = Math.max(1.5, ((n.end - n.start) / dur) * w);
      const y = h - ((n.midi - lo + 1) / rows) * h;
      const bh = Math.max(2.5, h / rows - 1.4);
      c.fillStyle = "rgba(163,255,18,.88)";
      c.fillRect(x, y, bw, bh);
    }
    rollLayer.dataset.drawn = "1";
    rollLayer.dataset.w = String(w);
  }

  const dpr = Math.min(devicePixelRatio || 1, 2);
  rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  rctx.clearRect(0, 0, w, h);
  rctx.drawImage(rollLayer, 0, 0, w, h);

  const x = Math.max(0, Math.min(1, ratio || 0)) * w;
  rctx.fillStyle = "rgba(163,255,18,.12)";
  rctx.fillRect(0, 0, x, h);
  rctx.strokeStyle = "#a3ff12";
  rctx.lineWidth = 1.6;
  rctx.beginPath(); rctx.moveTo(x, 0); rctx.lineTo(x, h); rctx.stroke();
}

async function handleFile(file) {
  if (!file) return;
  if (!/\.(mp3|wav|m4a|flac|ogg)$/i.test(file.name)) {
    setHint("这个格式不支持，请上传 MP3 / WAV / M4A / FLAC / OGG。", true);
    return;
  }
  if (file.size > 30 * 1024 * 1024) {
    setHint("文件超过 30MB，先压缩一下再传。", true);
    return;
  }
  stopPlay();
  state.file = file;
  state.notes = null;
  state.midiBytes = null;
  rollLayer.dataset.drawn = "";
  el("result").hidden = true;
  el("fileInfo").hidden = false;
  el("fname").textContent = file.name;
  el("fmeta").textContent = (file.size / 1024 / 1024).toFixed(2) + " MB · 解析中…";

  el("settings").hidden = false;
  el("stage").hidden = false;
  el("drop").classList.add("filled");
  el("convert").disabled = false;
  setStep(2);

  try {
    state.decoded = await PitchForge.decode(file);
    el("fmeta").textContent =
      (file.size / 1024 / 1024).toFixed(2) + " MB · " + fmt(state.decoded.duration) + " · 22.05 kHz";
    el("waveMeta").textContent = fmt(state.decoded.duration) + " · 单声道";
    el("total").textContent = fmt(state.decoded.duration);
    el("sDur").textContent = fmtMm(state.decoded.duration);
    drawWave();
    el("rollMeta").textContent = "还没识别";
    setHint("音频已就绪，点「开始识别音符」。");
  } catch (e) {
    el("fmeta").textContent = (file.size / 1024 / 1024).toFixed(2) + " MB · 浏览器解不了这个编码";
    setHint("浏览器解码失败。若后端在线，可以切到「服务器」重试。", true);
    state.decoded = null;
  }
}

function stopPlay() {
  playing = false;
  el("play").classList.remove("playing");
  cancelAnimationFrame(raf);
  nodes.forEach((n) => { try { n.stop(); } catch (e) {} });
  nodes = [];
  el("playFill").style.width = "0%";
  drawRoll(0);
}

function tick() {
  if (!playing) return;
  const dur = state.decoded ? state.decoded.duration : 1;
  const t = audioCtx.currentTime - playStart;
  const ratio = Math.min(1, t / dur);
  drawRoll(ratio);
  el("cur").textContent = fmt(Math.min(t, dur));
  el("playFill").style.width = (ratio * 100) + "%";
  if (ratio >= 1) { stopPlay(); el("cur").textContent = fmt(0); return; }
  raf = requestAnimationFrame(tick);
}

function playNotes() {
  if (!state.notes) return;
  if (playing) { stopPlay(); return; }
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === "suspended") audioCtx.resume();
  const t0 = audioCtx.currentTime + 0.05;
  nodes = [];
  for (const n of state.notes) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "triangle";
    osc.frequency.value = 440 * Math.pow(2, (n.midi - 69) / 12);
    const vel = (n.velocity || 80) / 127;
    gain.gain.setValueAtTime(0.0001, t0 + n.start);
    gain.gain.exponentialRampToValueAtTime(0.16 * vel + 0.02, t0 + n.start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.min(n.end, n.start + 1.2));
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t0 + n.start);
    osc.stop(t0 + Math.min(n.end, n.start + 1.3));
    nodes.push(osc);
  }
  playStart = t0;
  playing = true;
  el("play").classList.add("playing");
  raf = requestAnimationFrame(tick);
}

el("play").addEventListener("click", playNotes);

async function transcribeLocal() {
  el("pLabel").textContent = "频谱分析中…";
  const res = await new Promise((resolve, reject) => {
    try {
      const out = PitchForge.transcribe(state.decoded.samples, {
        minNote: state.minNote,
        polyphony: state.polyphony
      }, (p) => {
        const pct = Math.round(p * 90);
        el("pPct").textContent = pct + "%";
        el("pFill").style.width = pct + "%";
      });
      resolve(out);
    } catch (e) { reject(e); }
  });
  el("pLabel").textContent = "生成 MIDI…";
  const bytes = PitchForge.writeMidi(res.notes, res.duration, 120);
  el("pPct").textContent = "100%";
  el("pFill").style.width = "100%";
  return { notes: res.notes, duration: res.duration, bytes };
}

async function transcribeServer() {
  el("pLabel").textContent = "上传到后端分析…";
  el("pFill").style.width = "30%";
  el("pPct").textContent = "30%";
  const fd = new FormData();
  fd.append("audio", state.file, state.file.name);
  fd.append("minNote", String(state.minNote));
  fd.append("polyphony", String(state.polyphony));
  const r = await fetch("api/transcribe", { method: "POST", body: fd });
  if (!r.ok) {
    let msg = "后端识别失败";
    try { msg = (await r.json()).error || msg; } catch (e) {}
    throw new Error(msg);
  }
  const j = await r.json();
  el("pFill").style.width = "100%";
  el("pPct").textContent = "100%";
  const bin = atob(j.midiBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { notes: j.notes, duration: j.duration, bytes };
}

el("convert").addEventListener("click", async () => {
  if (!state.file) return;
  const oldUrl = el("download").getAttribute("href");
  if (oldUrl && oldUrl.startsWith("blob:")) URL.revokeObjectURL(oldUrl);
  el("progress").hidden = false;
  el("result").hidden = true;
  el("pFill").style.width = "0%";
  el("pPct").textContent = "0%";
  el("convert").disabled = true;

  try {
    if (state.mode === "server" && !state.serverReady) state.mode = "local";
    if (state.mode === "local" && !state.decoded) throw new Error("浏览器解码失败，请切到服务器引擎");

    const out = state.mode === "server" ? await transcribeServer() : await transcribeLocal();
    if (!out.notes.length) throw new Error("没识别出音符，试试换成单乐器片段");

    state.notes = out.notes;
    state.midiBytes = out.bytes;

    let lo = 127, hi = 0;
    for (const n of out.notes) { lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi); }
    el("sNotes").textContent = out.notes.length;
    el("sRange").textContent = PitchForge.noteName(lo) + "–" + PitchForge.noteName(hi);
    el("sDur").textContent = fmtMm(out.duration);
    el("rollMeta").textContent = out.notes.length + " 个音符 · " + (state.mode === "server" ? "后端" : "浏览器");

    rollLayer.dataset.drawn = "";
    drawRoll(0);

    const name = (state.file ? state.file.name : "audio").replace(/\.(mp3|wav|m4a|flac|ogg)$/i, "") + ".mid";
    const url = URL.createObjectURL(new Blob([out.bytes], { type: "audio/midi" }));
    el("download").href = url;
    el("download").download = name;
    el("rName").textContent = name;
    el("rMeta").textContent = out.notes.length + " 音符 · " + (out.bytes.length / 1024).toFixed(1) + " KB · 120 BPM";
    el("result").hidden = false;
    el("pLabel").textContent = "完成";
    setHint("已生成 .mid，可以先播放试听，再下载。");
    setStep(3);
  } catch (e) {
    el("progress").hidden = true;
    setHint("识别失败：" + (e.message || "未知错误"), true);
  } finally {
    el("convert").disabled = false;
  }
});

el("pick").addEventListener("click", (e) => { e.stopPropagation(); el("file").click(); });
el("drop").addEventListener("click", (e) => {
  if (e.target.closest("#reset")) return;
  if (!el("fileInfo").hidden) return;
  el("file").click();
});
el("file").addEventListener("change", (e) => { handleFile(e.target.files[0]); e.target.value = ""; });

["dragenter", "dragover"].forEach((ev) =>
  el("drop").addEventListener(ev, (e) => { e.preventDefault(); el("drop").classList.add("hot"); })
);
["dragleave", "drop"].forEach((ev) =>
  el("drop").addEventListener(ev, (e) => { e.preventDefault(); el("drop").classList.remove("hot"); })
);
el("drop").addEventListener("drop", (e) => {
  const f = e.dataTransfer.files && e.dataTransfer.files[0];
  if (f) handleFile(f);
});

el("reset").addEventListener("click", (e) => {
  e.stopPropagation();
  stopPlay();
  state.file = null; state.decoded = null; state.notes = null; state.midiBytes = null;
  el("fileInfo").hidden = true;
  el("stage").hidden = true;
  el("settings").hidden = true;
  el("result").hidden = true;
  el("progress").hidden = true;
  el("convert").disabled = true;
  el("drop").classList.remove("filled");
  rollLayer.dataset.drawn = "";
  setStep(1);
  setHint("先上传一段音频。识别只提取音高与节奏，不会还原原始音色。");
});

addEventListener("resize", () => {
  if (state.decoded) drawWave();
  if (state.notes) { rollLayer.dataset.drawn = ""; drawRoll(playing ? 0 : 0); }
});

setStep(1);
checkServer();
