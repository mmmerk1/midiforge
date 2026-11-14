const el = (id) => document.getElementById(id);
const state = { file: null, parsed: null, pcm: null, buffer: null, timbre: "epiano", kbps: 192, mode: "local" };

let ctxAudio = null;
let source = null;
let playStart = 0;
let playing = false;
let raf = null;

const roll = el("roll");
const rctx = roll.getContext("2d");
let off = document.createElement("canvas");

function fmt(sec) {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return m + ":" + (s < 10 ? "0" : "") + s.toFixed(1);
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

chipGroup("timbreChips", (v) => { state.timbre = v; if (state.parsed) prepareAudio(); });
chipGroup("kbpsChips", (v) => { state.kbps = Number(v); });
chipGroup("modeChips", (v) => { state.mode = v; });

async function checkServer() {
  try {
    const r = await fetch("api/health", { cache: "no-store" });
    if (!r.ok) throw new Error("no");
    const j = await r.json();
    if (!j.ok) throw new Error("no");
    el("engine").classList.add("ok");
    el("engine").innerHTML = "<i></i>本机 + 服务器";
    const s = el("modeChips").querySelector('[data-v="server"]');
    if (s) s.disabled = false;
  } catch (e) {
    el("engine").innerHTML = "<i></i>纯本机模式";
  }
}

async function handleFile(file) {
  if (!file) return;
  if (!/\.(mid|midi)$/i.test(file.name)) {
    setHint("只认 .mid / .midi 文件，其它格式请先导出为 MIDI。", true);
    return;
  }
  if (file.size > 25 * 1024 * 1024) {
    setHint("文件超过 25MB，浏览器内存可能撑不住。", true);
    return;
  }
  state.file = file;
  state.buffer = await file.arrayBuffer();
  try {
    state.parsed = MidiCore.parseMidi(state.buffer);
  } catch (e) {
    setHint(e.message || "MIDI 解析失败", true);
    return;
  }
  if (!state.parsed.noteCount) {
    setHint("这个 MIDI 里没有可读的音符。", true);
    return;
  }
  el("fileInfo").hidden = false;
  el("fileInfo").querySelector(".fname").textContent = file.name;
  el("fmeta").textContent =
    (file.size / 1024).toFixed(1) + " KB · " +
    state.parsed.format + " 号格式 · " +
    state.parsed.tracks.length + " 轨 · " +
    fmt(state.parsed.duration);
  el("drop").classList.add("filled");
  prepareAudio();
}

function prepareAudio() {
  const p = state.parsed;
  const rendered = MidiCore.renderNotes(p.notes, { sampleRate: 44100, timbre: state.timbre, gain: 1 });
  state.pcm = rendered.pcm;
  el("stage").hidden = false;
  el("settings").hidden = false;
  el("convert").disabled = false;
  el("sNotes").textContent = p.noteCount;
  el("sTracks").textContent = p.tracks.length;
  el("sBpm").textContent = p.bpm;
  el("total").textContent = fmt(p.duration);
  el("cur").textContent = fmt(0);
  el("rollerMeta").textContent = p.tracks.slice(0, 3).map((t) => t.name).join(" / ") +
    (p.tracks.length > 3 ? " 等 " + p.tracks.length + " 轨" : "");
  el("result").hidden = true;
  el("progress").hidden = true;
  drawStatic();
  drawPlayhead(0);
  setStep(2);
  setHint("试听没问题就点「开始转换」，编码在本机完成。");
}

function layoutRoll() {
  const w = roll.clientWidth || 600;
  const h = w < 520 ? 170 : 230;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  roll.width = Math.round(w * dpr);
  roll.height = Math.round(h * dpr);
  roll.style.height = h + "px";
  rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  off.width = Math.round(w * dpr);
  off.height = Math.round(h * dpr);
}

let rollW = 0, rollH = 0;

function drawStatic() {
  layoutRoll();
  rollW = roll.clientWidth;
  rollH = roll.clientHeight;
  const c = off.getContext("2d");
  const dpr = Math.min(devicePixelRatio || 1, 2);
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, rollW, rollH);

  const notes = state.parsed.notes;
  const dur = state.parsed.duration || 1;
  let lo = 127, hi = 0;
  for (const n of notes) { lo = Math.min(lo, n.midi); hi = Math.max(hi, n.midi); }
  lo = Math.max(0, lo - 2); hi = Math.min(127, hi + 2);
  const rows = Math.max(8, hi - lo + 1);

  c.strokeStyle = "rgba(255,255,255,.045)";
  c.lineWidth = 1;
  for (let i = 0; i <= 12; i++) {
    const x = (rollW / 12) * i;
    c.beginPath(); c.moveTo(x, 0); c.lineTo(x, rollH); c.stroke();
  }
  for (let i = 0; i <= rows; i += Math.ceil(rows / 8)) {
    const y = (rollH / rows) * i;
    c.beginPath(); c.moveTo(0, y); c.lineTo(rollW, y); c.stroke();
  }

  for (const n of notes) {
    const x = (n.time / dur) * rollW;
    const w = Math.max(1.5, (n.duration / dur) * rollW);
    const y = rollH - ((n.midi - lo + 1) / rows) * rollH;
    const hh = Math.max(2.5, rollH / rows - 1.5);
    const isDrum = n.channel === 9;
    c.fillStyle = isDrum ? "rgba(255,92,43,.85)" : "rgba(163,255,18,.9)";
    c.fillRect(x, y, w, hh);
  }

  rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  rctx.clearRect(0, 0, rollW, rollH);
  rctx.drawImage(off, 0, 0, rollW, rollH);
}

function drawPlayhead(ratio) {
  const dpr = Math.min(devicePixelRatio || 1, 2);
  rctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  rctx.clearRect(0, 0, rollW, rollH);
  rctx.drawImage(off, 0, 0, rollW, rollH);
  const x = Math.max(0, Math.min(1, ratio)) * rollW;
  rctx.fillStyle = "rgba(163,255,18,.14)";
  rctx.fillRect(0, 0, x, rollH);
  rctx.strokeStyle = "#a3ff12";
  rctx.lineWidth = 1.6;
  rctx.beginPath(); rctx.moveTo(x, 0); rctx.lineTo(x, rollH); rctx.stroke();
  rctx.shadowColor = "rgba(163,255,18,.8)";
  rctx.shadowBlur = 14;
  rctx.beginPath(); rctx.moveTo(x, 0); rctx.lineTo(x, rollH); rctx.stroke();
  rctx.shadowBlur = 0;
}

addEventListener("resize", () => { if (state.parsed) { drawStatic(); drawPlayhead(playing ? currentRatio() : 0); } });

function ensureAudio() {
  if (!ctxAudio) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctxAudio = new AC();
  }
  if (ctxAudio.state === "suspended") ctxAudio.resume();
}

function currentRatio() {
  if (!playing || !ctxAudio) return 0;
  const t = ctxAudio.currentTime - playStart;
  const d = state.parsed.duration || 1;
  return Math.min(1, t / d);
}

function tick() {
  if (!playing) return;
  const t = ctxAudio.currentTime - playStart;
  const d = state.parsed.duration || 1;
  const ratio = Math.min(1, t / d);
  drawPlayhead(ratio);
  el("cur").textContent = fmt(Math.min(t, d));
  el("playFill").style.width = (ratio * 100) + "%";
  if (ratio >= 1) { stopPlay(); el("cur").textContent = fmt(0); return; }
  raf = requestAnimationFrame(tick);
}

function stopPlay() {
  playing = false;
  el("play").classList.remove("playing");
  if (source) { try { source.stop(); } catch (e) {} source = null; }
  cancelAnimationFrame(raf);
  el("playFill").style.width = "0%";
  drawPlayhead(0);
}

async function togglePlay() {
  if (playing) { stopPlay(); return; }
  if (!state.pcm) return;
  ensureAudio();
  const buffer = ctxAudio.createBuffer(1, state.pcm.length, 44100);
  buffer.copyToChannel(state.pcm, 0);
  source = ctxAudio.createBufferSource();
  source.buffer = buffer;
  source.connect(ctxAudio.destination);
  source.start();
  playStart = ctxAudio.currentTime;
  playing = true;
  el("play").classList.add("playing");
  raf = requestAnimationFrame(tick);
  setStep(3);
}

el("play").addEventListener("click", togglePlay);

el("pick").addEventListener("click", (e) => { e.stopPropagation(); el("file").click(); });
el("drop").addEventListener("click", (e) => {
  if (e.target.closest("#reset")) return;
  if (!el("fileInfo").hidden && e.target.closest(".drop-file")) return;
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
  if (f) { stopPlay(); handleFile(f); }
});

el("reset").addEventListener("click", (e) => {
  e.stopPropagation();
  stopPlay();
  state.file = null; state.parsed = null; state.pcm = null;
  el("fileInfo").hidden = true;
  el("stage").hidden = true;
  el("settings").hidden = true;
  el("result").hidden = true;
  el("progress").hidden = true;
  el("drop").classList.remove("filled");
  el("convert").disabled = true;
  setStep(1);
  setHint("转换只读音符数据，不会上传到任何服务器。");
  el("hint").style.color = "";
});

async function convertLocal() {
  el("progress").hidden = false;
  el("result").hidden = true;
  el("convert").disabled = true;
  el("pLabel").textContent = "合成波形…";
  const rendered = MidiCore.renderNotes(state.parsed.notes, { sampleRate: 44100, timbre: state.timbre, gain: 1 });
  el("pLabel").textContent = "LAME 编码中…";
  const mp3 = await MidiCore.encodeMp3Async(rendered.pcm, 44100, state.kbps, (p) => {
    const pct = Math.round(p * 100);
    el("pPct").textContent = pct + "%";
    el("pFill").style.width = pct + "%";
  });
  return new Blob([mp3], { type: "audio/mpeg" });
}

async function convertServer() {
  el("progress").hidden = false;
  el("result").hidden = true;
  el("convert").disabled = true;
  el("pLabel").textContent = "上传到本地服务转换…";
  el("pFill").style.width = "35%";
  el("pPct").textContent = "35%";
  const q = "?timbre=" + encodeURIComponent(state.timbre) + "&kbps=" + state.kbps;
  const r = await fetch("api/convert" + q, { method: "POST", body: state.buffer });
  if (!r.ok) {
    const t = await r.text();
    let msg = "服务器转换失败";
    try { msg = JSON.parse(t).error || msg; } catch (e) {}
    throw new Error(msg);
  }
  el("pFill").style.width = "100%";
  el("pPct").textContent = "100%";
  return r.blob();
}

el("convert").addEventListener("click", async () => {
  if (!state.parsed) return;
  const prevUrl = el("download").getAttribute("href");
  if (prevUrl && prevUrl.startsWith("blob:")) URL.revokeObjectURL(prevUrl);
  el("result").hidden = true;
  try {
    const blob = state.mode === "server" ? await convertServer() : await convertLocal();
    const name = (state.file ? state.file.name : "track.mid").replace(/\.(mid|midi)$/i, "") + ".mp3";
    const url = URL.createObjectURL(blob);
    el("download").href = url;
    el("download").download = name;
    el("rName").textContent = name;
    el("rMeta").textContent = (blob.size / 1024).toFixed(0) + " KB · " + state.kbps + " kbps · 44.1 kHz";
    el("result").hidden = false;
    el("pLabel").textContent = "完成";
    setHint("已生成，点「下载」保存到本地。");
    setStep(3);
  } catch (e) {
    el("progress").hidden = true;
    setHint("转换失败：" + (e.message || "未知错误"), true);
  } finally {
    el("convert").disabled = false;
  }
});

setStep(1);
checkServer();
