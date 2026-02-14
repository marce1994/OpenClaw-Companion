# 🐾 OpenClaw Companion

Your AI, alive. Talk to an animated Live2D avatar through voice or text — Android, Web, and beyond. Powered by [OpenClaw](https://github.com/openclaw/openclaw).

<p align="center">
  <img src="preview.jpg" alt="OpenClaw Companion — Live2D voice assistant" width="300" />
</p>

## ✨ Features

- **Push-to-talk voice** — hold, speak, release
- **Streaming sentence-by-sentence TTS** — hear the first sentence while the AI is still generating
- **Emotion-reactive avatar** — 9 animated emotions (happy, sad, surprised, thinking, confused, laughing, neutral, angry, love)
- **Live2D avatars** — 7 animated models with dual display mode (orb / Live2D)
- **Barge-in** — interrupt the AI mid-response; partial context is preserved
- **Conversation memory** — 10-exchange sliding window, persists across reconnects
- **Smart Listen mode** — ambient always-on listening with wake word detection
- **Speaker identification** — auto-enrolls voices, recognizes speakers, prioritizes the owner
- **Vision & file analysis** — send images or text files for AI analysis
- **Web search** — automatic DuckDuckGo search integration for factual queries
- **Multiple TTS engines** — Kokoro (local GPU, ~460ms), Edge TTS (cloud, ~2300ms), XTTS v2 (local GPU, voice cloning)
- **Text chat with markdown** — full markdown rendering, code blocks as artifacts
- **Inline buttons** — interactive response options from the AI
- **File & image attachments** — send photos and documents for analysis
- **Works over Tailscale / LAN / WAN**
- **Headphone media button & lock screen support** (Android)

## Architecture

```
┌──────────────┐                              ┌──────────────────────────────────┐
│  Android App │◄──── WebSocket (WS/WSS) ────►│   Voice Server (Node.js)         │
│  or Web App  │   audio/text/images/files     │   Port 3200 (WS) / 3443 (WSS)   │
│              │◄── reply_chunk ──────────────│                                  │
│  • Voice     │◄── audio_chunk ─────────────│   ┌──────────────┐               │
│  • Avatar    │◄── buttons ─────────────────│   │ Speaker ID   │ (Python)      │
│  • Text chat │                              │   │ :3201        │               │
└──────────────┘                              │   │ + Web Search │               │
                                              │   └──────────────┘               │
                                              │          │                       │
                                              │          ▼                       │
                                              │   ┌──────────────┐              │
                                              │   │ Whisper ASR   │ :9000       │
                                              │   │ large-v3-turbo│              │
                                              │   └──────────────┘              │
                                              │          │                       │
                                              │          ▼                       │
                                              │   ┌──────────────────────┐      │
                                              │   │ OpenClaw Gateway      │      │
                                              │   │ HTTP or WebSocket     │      │
                                              │   │ :18789               │      │
                                              │   └──────────────────────┘      │
                                              │          │                       │
                                              │          ▼                       │
                                              │   ┌──────────────┐              │
                                              │   │ TTS Engine    │              │
                                              │   │ Kokoro :5004  │              │
                                              │   │ XTTS   :5002  │              │
                                              │   │ Edge (cloud)  │              │
                                              │   └──────────────┘              │
                                              └──────────────────────────────────┘
```

### Data Flow

1. **Voice input** → Client records PCM audio (16kHz mono) → encodes WAV → sends base64 over WebSocket
2. **Transcription** → Whisper ASR converts speech to text
3. **Speaker ID** → Resemblyzer identifies who's speaking (auto-enrolls new speakers)
4. **Web search** → If the query needs facts, DuckDuckGo results are injected as context
5. **LLM streaming** → OpenClaw Gateway streams response via SSE (HTTP) or native WebSocket
6. **Sentence splitting** → Response is split at sentence boundaries as tokens arrive
7. **Parallel TTS** → Each sentence is sent to TTS immediately (text + audio sent concurrently)
8. **Client playback** → Audio chunks play sequentially while text appears in real-time

## 🚀 Quick Start

### 1. Start Supporting Services

```bash
# Whisper ASR (speech recognition)
docker run -d --name whisper-asr \
  --gpus all \
  -p 9000:9000 \
  -e ASR_MODEL=large-v3-turbo \
  onerahmet/openai-whisper-asr-webservice:latest

# Kokoro TTS (optional, for fast local TTS)
docker run -d --name kokoro-tts \
  --gpus all \
  -p 5004:8080 \
  ghcr.io/remsky/kokoro-fastapi-gpu:v0.4.2
```

### 2. Build & Run Voice Server

```bash
cd server
docker build -t jarvis-voice-img .
docker run -d --name jarvis-voice \
  --network host \
  -e AUTH_TOKEN=my-secret-token \
  -e GATEWAY_TOKEN=your-gateway-token \
  -e TTS_ENGINE=kokoro \
  -v /tmp/speaker-profiles:/data/speakers \
  jarvis-voice-img
```

### 3. Install Client

**Android** — Build APK with Docker (no SDK needed):
```bash
cd android
docker build -f Dockerfile -t openclaw-companion-builder .
docker cp $(docker create openclaw-companion-builder):/app/app/build/outputs/apk/debug/app-debug.apk ./openclaw-companion.apk
```

**Web** — Build static site:
```bash
cd web
npm install && npm run build
# Deploy dist/ to any static host
```

### 4. Configure Client

Open Settings in the app and enter:
- **Server URL**: `ws://YOUR_SERVER_IP:3200` (or `wss://...` for TLS)
- **Auth Token**: the `AUTH_TOKEN` you set above

## 📂 Project Structure

```
├── server/                Voice bridge server (Node.js + Python)
│   ├── index.js           WebSocket server, LLM streaming, TTS
│   ├── speaker_service.py Speaker ID (Resemblyzer) + web search (DuckDuckGo)
│   ├── Dockerfile         Server container build
│   ├── start.sh           Entrypoint (starts Python + Node)
│   └── README.md          Detailed server setup & WebSocket protocol
├── android/               Android app (Kotlin)
│   ├── Dockerfile         Docker-based APK build
│   └── README.md          Android setup guide
├── web/                   Web client (React + TypeScript + Vite)
│   └── README.md          Web client setup guide
└── README.md              This file
```

## 📖 Documentation

- **[Server README](server/README.md)** — complete server setup, all environment variables, WebSocket protocol reference, troubleshooting
- **[Android README](android/README.md)** — Android app build, configuration, features
- **[Web README](web/README.md)** — web client build, deployment, TLS setup
- **[Architecture](../docs/ARCHITECTURE.md)** — system architecture and WebSocket protocol specification

## 📄 License

[MIT](LICENSE)

## 🔗 Links

- [OpenClaw](https://github.com/nichochar/openclaw) — the AI gateway this connects to
- [Whisper ASR](https://github.com/ahmetoner/whisper-asr-webservice) — speech recognition service
- [Kokoro TTS](https://github.com/remsky/Kokoro-FastAPI) — fast local TTS engine
- [XTTS v2](https://github.com/coqui-ai/TTS) — voice cloning TTS
- [Edge TTS](https://github.com/rany2/edge-tts) — cloud text-to-speech engine
