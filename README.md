# 🐾 OpenClaw Companion

Your AI, alive. Talk to an animated Live2D avatar through voice or text — Android, Web, and beyond. Powered by [OpenClaw](https://github.com/openclaw/openclaw).

<p align="center">
  <img src="preview.jpg" alt="OpenClaw Companion — Live2D voice assistant" width="300" />
</p>

## ✨ Features

- **Push-to-talk voice** — hold, speak, release
- **Streaming sentence-by-sentence TTS** — hear the first sentence while the AI is still generating
- **Emotion-reactive avatar** — 9 animated emotions (happy, sad, surprised, thinking, confused, laughing, neutral, angry, love)
- **Barge-in** — interrupt the AI mid-response; partial context is preserved
- **Conversation memory** — 10-exchange sliding window, persists across reconnects
- **Smart listen mode** — ambient always-on listening with wake word detection
- **Speaker identification** — recognizes enrolled voices, prioritizes the owner
- **Vision & file analysis** — send images or text files for AI analysis
- **Web search** — automatic search integration for factual queries
- **Multiple TTS engines** — Edge (cloud), Kokoro (local), XTTS (local + voice cloning)
- **Works over Tailscale / LAN / WAN**
- **Headphone media button & lock screen support**

## Architecture

```
┌─────────────────┐        WebSocket         ┌──────────────────────────────┐
│                 │◄────────────────────────►│  Voice Server (Node.js)      │
│  Android App    │   audio/text/images      │                              │
│                 │◄── reply_chunk ──────────│  ┌─────────────┐             │
│  • Voice input  │◄── audio_chunk ─────────│  │ Speaker ID  │ (Python)    │
│  • Avatar       │                          │  │ :3201       │             │
│  • Text chat    │                          │  └─────────────┘             │
└─────────────────┘                          │         │                    │
                                             │         ▼                    │
                                             │  ┌─────────────┐            │
                                             │  │ Whisper ASR │ :9000      │
                                             │  └─────────────┘            │
                                             │         │                    │
                                             │         ▼                    │
                                             │  ┌──────────────────┐       │
                                             │  │ OpenClaw Gateway │       │
                                             │  │ (LLM)            │       │
                                             │  └──────────────────┘       │
                                             │         │                    │
                                             │         ▼                    │
                                             │  ┌─────────────┐            │
                                             │  │ TTS Engine  │            │
                                             │  └─────────────┘            │
                                             └──────────────────────────────┘
```

## 🚀 Quick Start

### Server (Docker Compose)

```bash
cp .env.example .env          # Edit: set GATEWAY_TOKEN at minimum
docker compose up -d           # CPU mode — works everywhere
# docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d  # GPU mode
```

Get the auth token for the Android app:

```bash
docker compose logs voice-server | grep "Token:"
```

### Android App

**Option A — Docker build (no SDK needed):**
```bash
cd android
docker build -t openclaw-companion-apk .
docker run --rm openclaw-companion-apk > openclaw-companion.apk
```

**Option B — Android Studio:**
1. Open `android/` in Android Studio
2. Build → Build APK(s)

Install the APK, open Settings, enter your server URL (`ws://YOUR_IP:3200`) and auth token.

## ⚙️ Configuration

Copy `.env.example` to `.env` and edit. Key variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTH_TOKEN` | *(random)* | Shared secret for app ↔ server auth |
| `GATEWAY_URL` | `http://host.docker.internal:18789/...` | OpenClaw chat completions endpoint |
| `GATEWAY_TOKEN` | *(required)* | OpenClaw gateway bearer token |
| `TTS_ENGINE` | `edge` | TTS engine: `edge`, `kokoro`, or `xtts` |
| `TTS_VOICE` | `es-AR-TomasNeural` | Edge TTS voice name |
| `BOT_NAME` | `jarvis` | Wake word for smart-listen mode |
| `WHISPER_LANG` | `es` | Whisper transcription language |
| `ASR_MODEL` | `large-v3-turbo` | Whisper model size |

See [`.env.example`](.env.example) for the complete reference with descriptions.

## 📂 Project Structure

```
├── server/                Bridge server (Node.js + Python)
│   ├── index.js           WebSocket server & LLM streaming
│   ├── speaker_service.py Speaker identification (resemblyzer)
│   ├── Dockerfile         Server container build
│   └── README.md          Server docs & WebSocket protocol reference
├── android/               Android app (Kotlin)
├── docker-compose.yml     CPU deployment (default)
├── docker-compose.gpu.yml GPU override for NVIDIA
├── .env.example           Configuration template
└── README.md              This file
```

## 📖 Documentation

- **[Server README](server/README.md)** — setup, configuration, full WebSocket protocol reference, troubleshooting
- **[`.env.example`](.env.example)** — all environment variables with descriptions

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Commit your changes
4. Push and open a Pull Request

### Development

```bash
# Run server locally (without Docker)
cd server && npm install
node index.js

# Run Whisper separately
docker run -d -p 9000:9000 -e ASR_MODEL=base onerahmet/openai-whisper-asr-webservice:latest
```

## 📄 License

[MIT](LICENSE)

## 🔗 Links

- [OpenClaw](https://github.com/nichochar/openclaw) — the AI gateway this connects to
- [Whisper ASR](https://github.com/ahmetoner/whisper-asr-webservice) — speech recognition service
- [Edge TTS](https://github.com/rany2/edge-tts) — default text-to-speech engine
