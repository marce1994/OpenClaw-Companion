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
- **Google Meet bot** — joins meetings with Live2D avatar, listens, responds when mentioned
- **Bilingual TTS** — auto-detects meeting/conversation language (EN/ES) and responds accordingly
- **Calendar auto-join** — automatically joins Google Meet calls from your calendar
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
└──────────────┘                              └──────────┬───────────────────────┘
                                                         │
┌──────────────┐                              ┌──────────▼───────────────────────┐
│  Google Meet │◄── Puppeteer + PulseAudio ──►│   Meet Bot (Node.js)             │
│  (browser)   │   audio capture/inject       │   Port 3300                      │
│              │◄── Live2D canvas stream       │   • Calendar auto-join (ICS)     │
└──────────────┘                              │   • Bilingual EN/ES auto-detect  │
                                              └──────────┬───────────────────────┘
                                                         │
                                              ┌──────────▼───────────────────────┐
                                              │   Shared Services                │
                                              │                                  │
                                              │   Whisper ASR (:9000)  ◄── GPU   │
                                              │   Kokoro TTS  (:5004)  ◄── GPU   │
                                              │   XTTS v2     (:5002)  ◄── GPU   │
                                              │   OpenClaw Gateway (:18789)      │
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

### Prerequisites
- **Docker** with Docker Compose v2 (included in Docker Desktop)
- **OpenClaw Gateway** running (locally or remote with valid token)
- **Linux/macOS** or **WSL2** on Windows
- Optional: **NVIDIA GPU** for faster Whisper and local TTS

### 1. Start the Voice Server (Automated)

The easiest way — run the interactive setup wizard:

```bash
cd server
chmod +x setup.sh
./setup.sh
```

This will:
- ✅ Check prerequisites (Docker, Docker Compose)
- ✅ Guide you through configuration (language, TTS engine, GPU)
- ✅ Generate `.env` with your settings
- ✅ Pull Docker images
- ✅ Start all services (Whisper ASR + Voice Server)
- ✅ Verify service health
- ✅ Display connection info

**Expected output:**
```
Your Voice Server is ready to connect to OpenClaw Gateway

Connection Information:
  WebSocket URL:    ws://localhost:3200
  Auth Token:       [your-token]
  
Services:
  Voice Server:     http://localhost:3200
  Whisper (STT):    http://localhost:9000
  Kokoro TTS:       http://localhost:5004 (if enabled)
```

### 2. Install & Configure Client

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
# Deploy dist/ to any static host (Netlify, Vercel, etc.)
```

### 3. Connect the Client

Open Settings in the app and enter:
- **Server URL**: `ws://YOUR_SERVER_IP:3200` (or `wss://...` for TLS)
- **Auth Token**: shown by setup.sh (or check: `docker compose logs voice-server | grep Token`)

### Troubleshooting

If setup fails, check the logs:
```bash
cd server
docker compose logs -f                 # All services
docker compose logs -f voice-server    # Just voice server
docker compose logs -f whisper         # Just Whisper ASR
```

For detailed setup instructions, see [**server/README.md**](server/README.md).

## 🤖 Google Meet Bot

An AI participant that joins your Google Meet calls with an animated Live2D avatar.

**Features:**
- Joins meetings as a guest named "Jarvis" (configurable)
- Live2D avatar rendered as camera feed (Mao, Hiyori, or Rice)
- Listens to all participants via PulseAudio virtual devices
- Responds when mentioned by name
- Auto-detects language (EN/ES) via Whisper and responds accordingly
- Bilingual TTS (Kokoro for speed, Edge as fallback)
- Meeting transcript saved as markdown
- Calendar auto-join from Google Calendar ICS feed

**Quick start:**
```bash
cd meet-bot
docker build -t meet-bot .
docker run -d --name meet-bot --network host \
  -e GATEWAY_WS_URL=ws://127.0.0.1:18789 \
  -e GATEWAY_TOKEN=your-token \
  -e BOT_NAME=Jarvis \
  -e LIVE2D_MODEL=Mao \
  meet-bot

# Join a meeting
curl -X POST http://localhost:3300/join \
  -H 'Content-Type: application/json' \
  -d '{"meetLink":"https://meet.google.com/abc-defg-hij"}'
```

**Optional: Calendar auto-join** — add `-e GOOGLE_CALENDAR_ICS=<your-private-ics-url>` to automatically join meetings from your Google Calendar.

See [**meet-bot/README.md**](meet-bot/README.md) for full documentation.

## 📂 Project Structure

```
openclaw-companion/
├── server/                          Voice bridge server (Node.js + Python)
│   ├── setup.sh                     🚀 Interactive setup wizard (START HERE)
│   ├── docker-compose.yml           Services definition (Whisper + Voice Server)
│   ├── Dockerfile                   Voice server container image
│   ├── index.js                     WebSocket server, LLM streaming, TTS
│   ├── speaker_service.py           Speaker ID (Resemblyzer) + web search
│   ├── start.sh                     Entrypoint (starts Python + Node services)
│   ├── package.json                 Node.js dependencies
│   ├── .env.example                 Configuration template
│   └── README.md                    📖 Detailed server docs & API reference
├── meet-bot/                        Google Meet bot
│   ├── Dockerfile                   Container image (Chromium + PulseAudio + Xvfb)
│   ├── src/
│   │   ├── index.js                 HTTP API + event wiring
│   │   ├── meet-joiner.js           Puppeteer Meet login/join
│   │   ├── audio-pipeline.js        PulseAudio capture/inject
│   │   ├── transcriber.js           VAD + Whisper ASR
│   │   ├── ai-responder.js          Gateway WS + bilingual TTS
│   │   ├── live2d-canvas.js         Live2D avatar → WebRTC camera
│   │   ├── calendar-sync.js         ICS feed → auto-join scheduler
│   │   ├── meeting-memory.js        Transcript storage
│   │   └── config.js                Environment config
│   ├── public/live2d/               Live2D model assets
│   └── scripts/                     Entrypoint + audio setup
├── android/                         Android app (Kotlin)
│   ├── Dockerfile                   Docker-based APK build
│   ├── build.gradle                 App configuration
│   └── README.md                    📖 Android setup & build guide
├── web/                             Web client (React + TypeScript + Vite)
│   ├── vite.config.ts               Build configuration
│   ├── src/components/              React components
│   └── README.md                    📖 Web client setup & deployment guide
├── docs/
│   └── ARCHITECTURE.md              📖 Full architecture & protocol spec
├── PLAN.md                          📖 Development roadmap
└── README.md                        This file
```

## 📖 Documentation

**Quick Navigation:**
- 👉 **Just starting?** → Run `server/setup.sh` (recommended for first-time setup)
- 🔧 **Server configuration?** → See [**server/README.md**](server/README.md)
  - All environment variables
  - WebSocket protocol reference
  - Troubleshooting & health checks
  - Advanced TLS setup
- 📱 **Building the Android app?** → See [**android/README.md**](android/README.md)
- 🌐 **Building the web client?** → See [**web/README.md**](web/README.md)
- 🏗️ **Want to understand the architecture?** → See [Architecture](#architecture) above

## 📄 License

[MIT](LICENSE)

## 🔗 Links

- [OpenClaw](https://github.com/nichochar/openclaw) — the AI gateway this connects to
- [Whisper ASR](https://github.com/ahmetoner/whisper-asr-webservice) — speech recognition service
- [Kokoro TTS](https://github.com/remsky/Kokoro-FastAPI) — fast local TTS engine
- [XTTS v2](https://github.com/coqui-ai/TTS) — voice cloning TTS
- [Edge TTS](https://github.com/rany2/edge-tts) — cloud text-to-speech engine
