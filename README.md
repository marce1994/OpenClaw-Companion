# 🐾 OpenClaw Companion

Open-source voice assistant app for [OpenClaw](https://github.com/openclaw/openclaw). Talk to your AI assistant via voice or text from your Android phone.

```
┌──────────────┐         ┌──────────────────┐         ┌─────────────────┐
│  Android App │◄──WS──►│  Bridge Server   │────────►│  Whisper STT    │
│              │         │  (Node.js)       │────────►│  OpenClaw GW    │
│  • Voice     │         │                  │────────►│  Edge TTS       │
│  • Text      │         │  Streams back    │         └─────────────────┘
│  • Playback  │         │  sentence-by-    │
└──────────────┘         │  sentence audio  │
                         └──────────────────┘
```

## ✨ Features

- **Push-to-talk voice** — hold the button, speak, release to send
- **Text input** — type messages for noisy environments
- **SSE streaming with sentence-by-sentence TTS** — hear the first sentence while the AI is still generating the rest
- **Emotion detection** — avatar reacts to the mood of the response
- **Barge-in** — interrupt the AI mid-response by speaking; partial context is preserved
- **Conversation memory** — maintains last 10 exchanges for multi-turn context, persists across reconnects
- **Replay last response** — tap to hear the last answer again
- **Works over Tailscale / LAN / WAN** — connect from anywhere
- **Headphone media button** — trigger recording via wired/Bluetooth headset
- **Lock screen support** — works with screen off via foreground service

## 📋 Prerequisites

| Component | Description |
|-----------|-------------|
| **OpenClaw** | An OpenClaw instance with `chatCompletions` enabled |
| **Whisper ASR** | A Whisper STT container (e.g. [whisper-asr-webservice](https://github.com/ahmetoner/whisper-asr-webservice)) |
| **Docker** | For building and running the server (and optionally the APK) |

## 🚀 Quick Start

### 1. Start the server (Docker Compose)

```bash
cp .env.example .env
# Edit .env — you MUST set GATEWAY_URL and GATEWAY_TOKEN

# CPU (works everywhere):
docker compose up -d

# GPU (NVIDIA, much faster transcription):
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d
```

That's it! The server is now running on port 3200.

### 2. Build the Android APK

**With Docker (no Android SDK needed):**

```bash
cd android
docker build -t openclaw-companion-apk .
docker create --name apk-tmp openclaw-companion-apk
docker cp apk-tmp:/project/app/build/outputs/apk/debug/app-debug.apk ./openclaw-companion.apk
docker rm apk-tmp
```

**With Android Studio:**

1. Open the `android/` directory in Android Studio
2. Sync Gradle
3. Build → Build APK(s)

### 3. Connect

Install the APK, open the app, go to Settings, and enter:
- **Server URL:** `ws://YOUR-SERVER-IP:3200`
- **Auth token:** the `AUTH_TOKEN` from your `.env`

## ⚙️ Configuration

All configuration is done via environment variables in `.env`. See [`.env.example`](.env.example) for the full reference.

**Required:**

| Variable | Description |
|----------|-------------|
| `GATEWAY_URL` | OpenClaw chat completions endpoint (e.g. `http://host.docker.internal:18789/v1/chat/completions`) |
| `GATEWAY_TOKEN` | Bearer token for the OpenClaw gateway |
| `AUTH_TOKEN` | Shared secret between the Android app and server |

**Optional (have sensible defaults):**

| Variable | Default | Description |
|----------|---------|-------------|
| `TTS_ENGINE` | `edge` | TTS engine: `edge` (cloud), `kokoro` (local GPU), `xtts` (local GPU) |
| `TTS_VOICE` | `es-AR-TomasNeural` | Edge TTS voice ([list voices](https://gist.github.com/BettyJJ/17cbaa1de96235a7f5773b8571a3ea95)) |
| `ASR_MODEL` | `small` (CPU) / `large-v3-turbo` (GPU) | Whisper model |
| `ASR_LANGUAGE` | `es` | Speech recognition language |
| `BOT_NAME` | `assistant` | Wake word for Smart Listen mode |
| `OWNER_NAME` | `User` | Primary user name for speaker identification |

## 📡 WebSocket Protocol

The app communicates with the bridge server over WebSocket (JSON messages). Sessions persist across reconnects.

**Client → Server:**
- `auth` — authenticate with token and optional session ID
- `audio` / `text` / `image` / `file` — send input for processing
- `ambient_audio` — always-listening mode audio
- `barge_in` — interrupt AI mid-response (aborts LLM, stops playback)
- `clear_history` — clear conversation memory
- `cancel` — cancel current generation
- `ping` — keep-alive

**Server → Client:**
- `status` — state changes (`transcribing` → `thinking` → `speaking` → `idle`)
- `transcript` — what Whisper heard
- `reply_chunk` + `audio_chunk` — streamed sentence-by-sentence with TTS
- `stream_done` — all chunks sent
- `stop_playback` — stop audio (sent on barge-in)
- `history_cleared` — conversation memory cleared
- `emotion` — avatar emotion tag
- `error` — error message

See [server/README.md](server/README.md) for the full protocol reference.

## 📂 Project Structure

```
├── docker-compose.yml   One-command server setup
├── .env.example         Configuration template
├── server/              Bridge server (Node.js + Python)
│   ├── index.js         WebSocket server & TTS
│   ├── speaker_service.py  Speaker identification (Resemblyzer)
│   ├── Dockerfile
│   └── README.md        Server docs & protocol reference
├── android/             Android app (Kotlin)
│   ├── app/src/main/    App source code
│   └── Dockerfile       APK build without Android Studio
├── PLAN.md              Development roadmap
└── LICENSE              MIT
```

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes
4. Push to the branch and open a Pull Request

## 📄 License

[MIT](LICENSE)

## 🔗 Links

- [OpenClaw](https://github.com/openclaw/openclaw) — the AI gateway this app connects to
