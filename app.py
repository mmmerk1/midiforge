import base64
import os
import tempfile

import numpy as np
import librosa
from flask import Flask, jsonify, request, send_from_directory

MAX_SECONDS = 180
SR = 22050
HOP = 256
FPS = SR / HOP
BPO = 24
FMIN_NOTE = 24          # C1
N_BINS = BPO * 6        # C1 ~ C7


def decode_audio(path, workdir=None):
    """用 ffmpeg 统一解码成 22.05k 单声道 wav，避开 libsndfile 的格式支持问题。"""
    import os
    import subprocess
    import tempfile

    if path.lower().endswith(".wav"):
        try:
            y, sr = librosa.load(path, sr=SR, mono=True)
            return y, sr
        except Exception:
            pass

    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False, dir=workdir)
    tmp.close()
    cmd = ["ffmpeg", "-y", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "wav", tmp.name]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 or not os.path.getsize(tmp.name):
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
        raise ValueError("音频解码失败，请换一个 MP3 / WAV 文件试试")
    y, sr = librosa.load(tmp.name, sr=SR, mono=True)
    try:
        os.unlink(tmp.name)
    except OSError:
        pass
    return y, sr


def load_audio(path, max_seconds=MAX_SECONDS):
    y, sr = decode_audio(path)
    if y.size == 0:
        raise ValueError("这个音频文件里没有声音")
    truncated = False
    limit = int(max_seconds * SR)
    if y.size > limit:
        y = y[:limit]
        truncated = True
    y = librosa.util.normalize(y)
    return y, sr, truncated


def _salience(y, sr):
    y_harm = librosa.effects.hpss(y)[0]
    cqt = np.abs(librosa.cqt(
        y=y_harm, sr=sr, hop_length=HOP,
        fmin=librosa.midi_to_hz(FMIN_NOTE),
        n_bins=N_BINS, bins_per_octave=BPO
    ))
    mag = cqt
    mag = mag / (np.max(mag) + 1e-9)
    return mag


def _peak_mask(mag):
    frames = mag.shape[1]
    mask = np.zeros_like(mag, dtype=bool)
    for b in range(mag.shape[0]):
        row = mag[b]
        local = np.convolve(row, np.ones(5) / 5, mode="same")
        mask[b] = (row > 0.045) & (row > local * 0.55)
    for f in range(frames):
        col = mag[:, f]
        k = 5
        if col.size > k:
            idx = np.argpartition(col, -k)[-k:]
            keep = np.zeros_like(col, dtype=bool)
            keep[idx] = True
            mask[:, f] &= keep
    return mask


def _runs(mask_bin, min_frames, max_gap=2):
    runs = []
    start = None
    gap = 0
    for i, v in enumerate(mask_bin):
        if v:
            if start is None:
                start = i
            gap = 0
        else:
            if start is not None:
                gap += 1
                if gap > max_gap:
                    if i - gap - start + 1 >= min_frames:
                        runs.append((start, i - gap - 1))
                    start = None
    if start is not None and len(mask_bin) - start >= min_frames:
        runs.append((start, len(mask_bin) - 1))
    return runs


def transcribe(path, min_note=0.05, threshold=0.045, polyphony=5):
    y, sr, truncated = load_audio(path)
    mag = _salience(y, sr)
    mask = _peak_mask(mag)
    if threshold and threshold > 0:
        mask &= mag > threshold

    min_frames = max(2, int(round(min_note * FPS)))
    notes = []
    for b in range(mask.shape[0]):
        for start, end in _runs(mask[b], min_frames):
            seg = mag[b, start:end + 1]
            conf = float(np.percentile(seg, 75))
            note = FMIN_NOTE + b * 12 / BPO
            midi = int(round(note))
            notes.append({
                "start": start / FPS,
                "end": (end + 1) / FPS,
                "midi": midi,
                "conf": conf,
                "bin": b,
            })

    notes = _drop_harmonics(notes, mag)
    notes = _limit_polyphony(notes, polyphony)
    notes = [n for n in notes if n["end"] - n["start"] >= min_note]
    notes.sort(key=lambda n: (n["start"], n["midi"]))

    for n in notes:
        n["velocity"] = int(max(30, min(120, 30 + n["conf"] * 130)))

    duration = float(len(y) / sr)
    return {
        "notes": notes,
        "duration": round(duration, 2),
        "noteCount": len(notes),
        "truncated": truncated,
        "sampleRate": sr,
    }


def _drop_harmonics(notes, mag):
    keep = []
    by_bin = {}
    for n in notes:
        by_bin.setdefault(n["bin"], []).append(n)

    for n in notes:
        lower = by_bin.get(n["bin"] - BPO)
        drop = False
        if lower:
            for L in lower:
                overlap = min(n["end"], L["end"]) - max(n["start"], L["start"])
                if overlap > 0:
                    span = min(n["end"] - n["start"], L["end"] - L["start"])
                    if overlap / max(span, 1e-6) > 0.6 and n["conf"] < L["conf"] * 0.42:
                        drop = True
                        break
        if not drop:
            keep.append(n)
    return keep


def _limit_polyphony(notes, limit):
    if limit <= 0:
        return notes
    events = sorted({round(n["start"], 3) for n in notes})
    allowed = []
    for t in events:
        active = [n for n in notes if n["start"] <= t + 1e-6 < n["end"]]
        active.sort(key=lambda n: -n["conf"])
        allowed.extend(active[:limit])
    seen = set()
    out = []
    for n in notes:
        if id(n) in {id(a) for a in allowed} and id(n) not in seen:
            seen.add(id(n))
            out.append(n)
    return out


def _vlq(value):
    out = bytearray([value & 0x7F])
    value >>= 7
    while value:
        out.insert(0, (value & 0x7F) | 0x80)
        value >>= 7
    return bytes(out)


def write_midi(notes, duration=0, division=96, tempo_bpm=120):
    us_per_quarter = int(60000000 / tempo_bpm)
    ticks_per_second = division * tempo_bpm / 60.0

    track = bytearray()
    track += b"\x00\xff\x51\x03" + us_per_quarter.to_bytes(3, "big")
    track += b"\x00\xff\x58\x04\x04\x02\x18\x08"
    name = b"Transcribed"
    track += b"\x00\xff\x03" + _vlq(len(name)) + name

    events = []
    for i, n in enumerate(notes):
        ch = i % 8
        on = int(round(n["start"] * ticks_per_second))
        off = max(on + 1, int(round(n["end"] * ticks_per_second)))
        pitch = int(n["midi"]) & 0x7F
        vel = int(n["velocity"]) & 0x7F
        events.append((on, 1, bytes([0x90 | ch, pitch, vel])))
        events.append((off, 0, bytes([0x80 | ch, pitch, 0x40])))

    events.sort(key=lambda e: (e[0], e[1]))

    last = 0
    for tick, _order, payload in events:
        track += _vlq(max(0, tick - last)) + payload
        last = tick
    track += b"\x00\xff\x2f\x00"

    header = b"MThd" + (6).to_bytes(4, "big") + (1).to_bytes(2, "big") + (2).to_bytes(2, "big") + division.to_bytes(2, "big")
    return header + b"MTrk" + len(track).to_bytes(4, "big") + bytes(track)


ROOT = os.path.dirname(os.path.abspath(__file__))
ALLOWED = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".aiff", ".midi", ".mid"}
MAX_BYTES = 30 * 1024 * 1024

app = Flask(__name__, static_folder=None)


@app.after_request
def cors(resp):
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Allow-Methods"] = "GET,POST,OPTIONS"
    return resp


@app.get("/api/health")
def health():
    return jsonify({
        "ok": True,
        "engine": "librosa-cqt",
        "maxSeconds": MAX_SECONDS,
        "formats": sorted(ALLOWED),
    })


@app.route("/api/transcribe", methods=["POST", "OPTIONS"])
def api_transcribe():
    if request.method == "OPTIONS":
        return ("", 204)

    file = request.files.get("audio")
    if file is None or not file.filename:
        return jsonify({"error": "没有收到音频文件"}), 400

    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in ALLOWED:
        return jsonify({"error": "不支持该格式，请上传 MP3 / WAV / M4A / OGG / FLAC"}), 400

    payload = file.read()
    if not payload:
        return jsonify({"error": "文件是空的"}), 400
    if len(payload) > MAX_BYTES:
        return jsonify({"error": "文件超过 30MB"}), 413

    tmp = tempfile.NamedTemporaryFile(suffix=ext, delete=False)
    tmp.write(payload)
    tmp.close()

    try:
        min_note = float(request.form.get("minNote", 0.05))
        polyphony = int(request.form.get("polyphony", 5))
    except ValueError:
        return jsonify({"error": "参数格式不对"}), 400

    try:
        result = transcribe(tmp.name, min_note=max(0.02, min(0.5, min_note)), polyphony=max(1, min(8, polyphony)))
        midi = write_midi(result["notes"], result["duration"])
        return jsonify({
            "ok": True,
            "duration": result["duration"],
            "truncated": result["truncated"],
            "sampleRate": result["sampleRate"],
            "notes": [
                {
                    "start": round(n["start"], 3),
                    "end": round(n["end"], 3),
                    "midi": n["midi"],
                    "velocity": n["velocity"],
                }
                for n in result["notes"]
            ],
            "noteCount": result["noteCount"],
            "midiBase64": base64.b64encode(midi).decode("ascii"),
            "midiBytes": len(midi),
            "filename": os.path.splitext(file.filename)[0] + ".mid",
        })
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        app.logger.exception("transcribe failed")
        return jsonify({"error": "转换失败：" + str(e)}), 500
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


@app.get("/")
def index():
    return send_from_directory(ROOT, "index.html")


@app.get("/<path:name>")
def static_file(name):
    if name.startswith(".") or "/" in name:
        return ("Not Found", 404)
    path = os.path.join(ROOT, name)
    if not os.path.isfile(path):
        return ("Not Found", 404)
    return send_from_directory(ROOT, name)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
