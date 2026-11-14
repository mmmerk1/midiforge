# MidiForge · MIDI 转 MP3

把 `.mid` 拖进来，浏览器里合成波形、LAME 编码，直接下载 MP3。

## 两种运行方式

**纯前端**
解析、合成、MP3 编码全在浏览器完成，文件不离开本机。

**前后端（自带 Node 服务）**

```bash
node server.js          # 默认 3000 端口
```

- `GET /` 静态页面
- `GET /api/health` 返回服务状态
- `POST /api/convert?timbre=epiano&kbps=192&sr=44100` 请求体为 MIDI 二进制，返回 `audio/mpeg`

页面右上角会显示「本机 + 服务器」，转换位置切到「服务器」就走这个接口。

## 文件

| 文件 | 作用 |
|---|---|
| `index.html` / `styles.css` / `app.js` | 界面、交互、播放与导出 |
| `midi-core.js` | MIDI 解析、合成、MP3 编码（浏览器与 Node 共用） |
| `lame.min.js` | LAME 编码器（本地内置，不走 CDN） |
| `server.js` | 零依赖 Node HTTP 服务，提供转换接口 |
| `.gitlab-ci.yml` | Pages 构建：把静态文件拷进 `public/` |

## 支持的 MIDI

格式 0 / 1，PPQ 时间格式，tempo 变速事件会按时间轴换算；轨道 10（通道 9）按打击乐处理。

## 说明

MIDI 只记录音符与力度，不含真实录音。导出的 MP3 是「用内置合成器重新演奏」的结果，音色可在界面上切换。
