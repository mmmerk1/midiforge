const http = require("http");
const fs = require("fs");
const path = require("path");
const MidiCore = require("./midi-core.js");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const STATIC_FILES = new Set(["index.html", "styles.css", "app.js", "midi-core.js", "lame.min.js", "README.md"]);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({ "Access-Control-Allow-Origin": "*" }, headers || {}));
  res.end(body);
}

function convert(req, res) {
  const url = new URL(req.url, "http://localhost");
  const timbre = url.searchParams.get("timbre") || "epiano";
  const kbps = Math.max(32, Math.min(320, Number(url.searchParams.get("kbps")) || 192));
  const sampleRate = Number(url.searchParams.get("sr")) || 44100;

  const chunks = [];
  let size = 0;

  req.on("data", (c) => {
    size += c.length;
    if (size > 25 * 1024 * 1024) {
      send(res, 413, JSON.stringify({ error: "文件超过 25MB" }), { "Content-Type": "application/json" });
      req.destroy();
      return;
    }
    chunks.push(c);
  });

  req.on("end", () => {
    if (res.writableEnded) return;
    try {
      const buf = Buffer.concat(chunks);
      if (!buf.length) throw new Error("请求体为空");
      const parsed = MidiCore.parseMidi(new Uint8Array(buf).buffer);
      if (!parsed.noteCount) throw new Error("这个 MIDI 里没有音符");
      const rendered = MidiCore.renderNotes(parsed.notes, { sampleRate, timbre, gain: 1 });
      const mp3 = MidiCore.encodeMp3(rendered.pcm, sampleRate, kbps);
      const body = Buffer.from(mp3);
      send(res, 200, body, {
        "Content-Type": "audio/mpeg",
        "Content-Disposition": 'attachment; filename="converted.mp3"',
        "X-Note-Count": String(parsed.noteCount),
        "X-Duration": parsed.duration.toFixed(2),
        "X-Mp3-Bytes": String(body.length)
      });
    } catch (e) {
      send(res, 400, JSON.stringify({ error: e.message || "转换失败" }), { "Content-Type": "application/json" });
    }
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") {
    return send(res, 204, "", {
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
  }

  if (req.method === "GET" && req.url === "/api/health") {
    return send(res, 200, JSON.stringify({ ok: true, timbres: MidiCore.TIMBRES }), { "Content-Type": "application/json" });
  }

  if (req.method === "POST" && req.url.startsWith("/api/convert")) return convert(req, res);

  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method Not Allowed");

  const clean = decodeURIComponent(req.url.split("?")[0]);
  const name = clean === "/" ? "index.html" : clean.replace(/^\//, "");
  if (!STATIC_FILES.has(name)) return send(res, 404, "Not Found");
  const file = path.join(ROOT, name);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      file = path.join(ROOT, "index.html");
      if (!fs.existsSync(file)) return send(res, 404, "Not Found");
    }
    fs.readFile(file, (e, data) => {
      if (e) return send(res, 500, "Server Error");
      send(res, 200, data, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    });
  });
});

server.listen(PORT, () => {
  console.log("MIDI → MP3 server on http://localhost:" + PORT);
});
