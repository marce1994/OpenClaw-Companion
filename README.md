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

### 1. Start Whisper ASR

```bash
docker run -d --gpus all -p 9000:9000 \
  -v whisper-models:/root/.cache \
  -e ASR_MODEL=large-v3-turbo \
  -e ASR_ENGINE=faster_whisper \
  onerahmet/openai-whisper-asr-webservice:latest-gpu
```

### 2. Start the Bridge Server

```bash
cp .env.example .env
# Edit .env with your values

cd server
docker build -t openclaw-companion-server .
docker run -d -p 3200:3200 --env-file ../.env openclaw-companion-server
```

### 3. Build the Android APK

**With Docker (no SDK needed):**

```bash
cd android
docker build -t openclaw-companion-apk .
docker run --rm openclaw-companion-apk > openclaw-companion.apk
```

**With Android Studio:**

1. Open the `android/` directory in Android Studio
2. Sync Gradle
3. Build → Build APK(s)

Install the APK, open the app, go to Settings, and enter your server URL and auth token.

## ⚙️ Configuration

Environment variables for the bridge server:

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_TOKEN` | Random (printed at startup) | Shared secret for WebSocket auth |
| `WHISPER_URL` | `http://localhost:9000/asr?language=es&output=json` | Whisper ASR endpoint |
| `GATEWAY_URL` | `http://localhost:18789/v1/chat/completions` | OpenClaw chat completions endpoint |
| `GATEWAY_TOKEN` | — | Bearer token for the OpenClaw gateway |
| `TTS_VOICE` | `es-AR-TomasNeural` | Edge TTS voice ([list voices](https://gist.github.com/BettyJJ/17cbaa1de96235a7f5773b8571a3ea95)) |
| `BOT_NAME` | `jarvis` | Wake word for ambient/smart-listen mode |
| `SPEAKER_URL` | `http://127.0.0.1:3201` | Speaker identification service URL |
| `OWNER_NAME` | `Pablo` | Primary user name (for speaker identification) |

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
├── server/          Bridge server (Node.js + WebSocket)
├── android/         Android app (Kotlin)
├── .env.example     Server configuration template
└── PLAN.md          Development roadmap
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
