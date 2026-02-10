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

### 1. Start the Bridge Server

```bash
cp .env.example .env
# Edit .env with your values

cd server
docker build -t openclaw-companion-server .
docker run -d -p 3200:3200 --env-file ../.env openclaw-companion-server
```

### 2. Build the Android APK

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

## 📡 WebSocket Protocol

The app communicates with the bridge server over WebSocket (JSON messages):

1. **Auth** — Client sends `{type: "auth", token: "..."}`, server responds `{type: "auth", status: "ok"}`
2. **Send audio** — `{type: "audio", data: "<base64 WAV>"}` → server transcribes, queries LLM, streams TTS back
3. **Send text** — `{type: "text", text: "..."}` → same flow, skips transcription
4. **Server streams back:**
   - `{type: "status", status: "transcribing|thinking|speaking|idle"}`
   - `{type: "transcript", text: "..."}` — what Whisper heard
   - `{type: "reply_chunk", text: "...", index: N, emotion: "..."}` — each sentence
   - `{type: "audio_chunk", data: "<base64 MP3>", index: N}` — TTS for each sentence
   - `{type: "stream_done"}` — all chunks sent

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
