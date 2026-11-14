# PitchForge · MP3 → MIDI

把 MP3 / WAV / M4A / FLAC / OGG 里的旋律识别成音符，导出标准 `.mid`。

## 两种识别引擎

| 引擎 | 位置 | 说明 |
|---|---|---|
| 服务器 | `app.py` | Flask + librosa，CQT 频谱峰值追踪 + 谐波剔除，效果更好，需要跑 Python 服务 |
| 浏览器内 | `midi-core.js` | 页面里的 FFT 峰值追踪，零依赖，GitHub Pages 这类纯静态托管也能用 |

页面启动时请求 `api/health`：连得上后端就默认用服务器引擎，连不上就自动切浏览器引擎并把服务器选项置灰。

## 跑后端

```bash
pip install -r requirements.txt
python3 app.py          # 默认 5000，PORT=5050 python3 app.py 可改端口
```

依赖 ffmpeg（解码 MP3/M4A/FLAC）。浏览器打开 `http://127.0.0.1:5000/` 即可，前端由 Flask 直接托管。

## 接口

`GET /api/health` → `{ok, engine, maxSeconds, formats}`

`POST /api/transcribe`（multipart）

- `audio`：音频文件，≤30MB，≤180 秒
- `minNote`：最短音符，秒，默认 0.05
- `polyphony`：同时发声上限，1–8，默认 5

返回 `{ok, duration, truncated, sampleRate, notes[], noteCount, midiBase64, midiBytes, filename}`。

## 结构

```
index.html      页面
styles.css      样式
app.js          交互：解码 / 波形 / 识别 / 卷帘 / 试听 / 下载
midi-core.js    浏览器内 FFT 转录 + MIDI 写入（window.PitchForge）
app.py          后端：解码 / 频谱转录 / MIDI 写入 / Flask 路由
requirements.txt
testdata/       测试素材（test.mp3 / test.mid）
```

## 参数

采样率 22050，帧长 2048，跳 256（≈86 帧/秒），音高格子 1/4 半音（48/八度），MIDI 分辨率 96 tick/拍，默认 120 BPM。

## 限制

适合单乐器旋律、钢琴独奏、清唱、简单和弦。鼓组密集或多乐器混录时音符会粘连，属于频谱转录的固有限制。
