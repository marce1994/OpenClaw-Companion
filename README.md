# 🐾 OpenClaw Companion

**Your AI, alive.** Talk to an animated Live2D avatar through voice or text — Android, Web, and Google Meet. Powered by [OpenClaw](https://github.com/openclaw/openclaw).

<p align="center">
  <img src="preview.jpg" alt="OpenClaw Companion — Live2D voice assistant" width="400" />
</p>

> **Self-hosted voice assistant with streaming TTS, speaker identification, emotion-reactive avatars, and Google Meet integration. Deploy on your own hardware with GPU support for fast transcription and local TTS.**

## 📑 Table of Contents

- [✨ Features](#-features)
- [🏗️ Architecture Overview](#-architecture-overview)
- [📦 Services](#-services)
- [🚀 Quick Start](#-quick-start)
- [🤖 Google Meet Bot](#-google-meet-bot)
- [📂 Project Structure](#-project-structure)
- [⚙️ Configuration](#-configuration)
- [🔧 Troubleshooting](#-troubleshooting)
- [📖 Documentation](#-documentation)

## ✨ Features

- **Push-to-talk voice** — hold, speak, release
- **Streaming TTS** — hear the first sentence while the AI is still thinking
- **Emotion-reactive Live2D avatars** — 9 emotions, 7 animated models, emoji bubble reactions
- **Smart Listen mode** — ambient always-on listening with wake word detection
- **Auto noise detection** — quiet/noisy profiles with hysteresis for car mode
- **Speaker identification** — auto-enrolls voices, recognizes who's speaking
- **Google Meet bot** — joins calls with Live2D avatar, speaker detection, transcript batching, meeting memory
- **Bilingual support** — auto-detects language (EN/ES), filters phantom language detections
- **Vision & file analysis** — send images or documents for AI analysis
- **Multiple TTS engines** — Kokoro (local GPU, ~460ms), Edge TTS (cloud, free)
- **Text chat with markdown** — code blocks, inline buttons, artifacts
- **Device capabilities** — system info, GPS, camera, Bluetooth car mic via Android bridge
- **Gateway WS integration** — native WebSocket protocol v3 with streaming + image attachments
- **Custom whisper-fast server** — minimal Python wrapper replacing Speaches' FastAPI (~239ms GPU)
- **Works over Tailscale / LAN / WAN**

## Architecture

```
┌──────────────┐                              ┌──────────────────────────────────┐
│  Android App │◄──── WebSocket (WS/WSS) ────►│   Voice Server (Node.js)         │
│  or Web App  │   audio/text/images           │   Port 3200 (WS) / 3443 (WSS)   │
└──────────────┘                              │   + Speaker ID (Python :3201)    │
                                              └──────────┬───────────────────────┘
                                                         │
┌──────────────┐                              ┌──────────▼───────────────────────┐
│  Google Meet │◄── Puppeteer + PulseAudio ──►│   Meet Bot (Node.js)             │
│  (browser)   │   audio capture/inject       │   Port 3300 (optional)           │
│              │◄── Live2D canvas stream       └──────────┬───────────────────────┘
└──────────────┘                                         │
                                              ┌──────────▼───────────────────────┐
                                              │   Shared Services                │
                                              │                                  │
                                              │   whisper-fast   (:9000)  ◄─ GPU  │
                                              │   Kokoro TTS    (:5004)  ◄─ GPU  │
                                              │   Diarizer      (:3202)  ◄─ GPU  │
                                              │   OpenClaw Gateway               │
                                              └──────────────────────────────────┘
```

### Data Flow

1. **Voice input** → Client records PCM audio → encodes WAV → sends base64 over WebSocket
2. **Transcription** → Speaches (faster-whisper) converts speech to text
3. **Speaker ID** → Resemblyzer identifies who's speaking
4. **LLM streaming** → OpenClaw Gateway streams response via WebSocket
5. **Sentence splitting** → Response split at sentence boundaries as tokens arrive
6. **Parallel TTS** → Each sentence sent to Kokoro/Edge TTS immediately
7. **Client playback** → Audio chunks play sequentially while text appears in real-time

## 🚀 Quick Start

### Prerequisites

- ✅ **Docker** with Docker Compose v2
- ✅ **OpenClaw Gateway** running ([setup guide](https://github.com/openclaw/openclaw))
- ⚡ Optional: **NVIDIA GPU** for faster STT (~239ms) and local TTS (~460ms)

### 🎯 Option 1: Interactive Setup (Recommended)

The fastest way to get started with automatic GPU detection:

```bash
git clone https://github.com/marce1994/OpenClaw-Companion.git
cd OpenClaw-Companion
chmod +x setup.sh
./setup.sh
```

The wizard guides you through:
- Configuration (Gateway token, auth secret)
- GPU detection
- `.env` file generation
- Service startup

### 🔧 Option 2: Manual Setup

```bash
git clone https://github.com/marce1994/OpenClaw-Companion.git
cd OpenClaw-Companion

# 1. Configure environment
cp .env.example .env
nano .env  # Set GATEWAY_TOKEN, AUTH_TOKEN, BOT_NAME

# 2. Start services (GPU mode)
docker compose up -d

# OR: CPU-only mode (slower STT/TTS)
docker compose -f docker-compose.cpu.yml up -d
```

### ✅ Verify Services

```bash
# Check status
docker compose ps

# View voice server logs
docker compose logs -f voice-server

# Health check
curl http://localhost:3200/health
```

### 🔗 Connect Your Client

| Client | Setup |
|--------|-------|
| **Android App** | Enter server URL `ws://YOUR_SERVER_IP:3200` + auth token in Settings |
| **Web Client** | `cd web && npm install && npm run dev` |
| **Google Meet Bot** | Enable with `docker compose --profile meet up -d` |

## 📦 Services

### ⚡ Performance Benchmarks

![Whisper Performance Comparison](https://quickchart.io/chart?w=700&h=400&c=%7B%22type%22%3A%20%22bar%22%2C%20%22data%22%3A%20%7B%22labels%22%3A%20%5B%22GPU%22%2C%20%22CPU%22%5D%2C%20%22datasets%22%3A%20%5B%7B%22label%22%3A%20%22Transcription%20Time%20%28seconds%29%22%2C%20%22data%22%3A%20%5B0.239%2C%202.5%5D%2C%20%22backgroundColor%22%3A%20%5B%22rgba%2875%2C%20192%2C%2075%2C%200.8%29%22%2C%20%22rgba%28255%2C%20159%2C%2064%2C%200.8%29%22%5D%2C%20%22borderColor%22%3A%20%5B%22rgb%2875%2C%20192%2C%2075%29%22%2C%20%22rgb%28255%2C%20159%2C%2064%29%22%5D%2C%20%22borderWidth%22%3A%202%7D%5D%7D%2C%20%22options%22%3A%20%7B%22title%22%3A%20%7B%22display%22%3A%20true%2C%20%22text%22%3A%20%22Whisper-Fast%20Performance%3A%20GPU%20vs%20CPU%22%7D%2C%20%22scales%22%3A%20%7B%22yAxes%22%3A%20%5B%7B%22ticks%22%3A%20%7B%22beginAtZero%22%3A%20true%7D%2C%20%22title%22%3A%20%7B%22display%22%3A%20true%2C%20%22text%22%3A%20%22Time%20%28seconds%29%22%7D%7D%5D%7D%2C%20%22plugins%22%3A%20%7B%22datalabels%22%3A%20%7B%22display%22%3A%20true%2C%20%22align%22%3A%20%22top%22%2C%20%22anchor%22%3A%20%22end%22%2C%20%22font%22%3A%20%7B%22size%22%3A%2012%2C%20%22weight%22%3A%20%22bold%22%7D%7D%7D%7D%7D)

### Service Registry

| Service | Port | Description | Required |
|---------|------|-------------|----------|
| `voice-server` | 3200/3443 | WebSocket bridge, TTS, speaker ID | ✅ Yes |
| `whisper-fast` | 9000 | Speech-to-text (custom minimal server + faster-whisper-large-v3-turbo) | ✅ Yes |
| `kokoro-tts` | 5004 | Text-to-speech (GPU, ~330ms) | ✅ Yes (or use Edge TTS) |
| `meet-bot` | 3300 | Google Meet bot with Live2D | Optional |
| `diarizer` | 3202 | Speaker diarization (pyannote) | Optional |

Enable optional services with Docker Compose profiles:

```bash
docker compose --profile meet up -d        # Enable Meet bot
docker compose --profile diarizer up -d    # Enable diarizer
```

## 🤖 Google Meet Bot

Joins your Google Meet calls as a participant with an animated Live2D avatar.

```bash
# Enable and start
docker compose --profile meet up -d

# Join a meeting
curl -X POST http://localhost:3300/join \
  -H 'Content-Type: application/json' \
  -d '{"meetLink":"https://meet.google.com/abc-defg-hij"}'
```

Features: Live2D avatar as camera, bilingual EN/ES, calendar auto-join. See [meet-bot/README.md](meet-bot/README.md).

## 📂 Project Structure

```
OpenClaw-Companion/
├── server/                   Voice server (Node.js + Python speaker ID)
│   ├── Dockerfile
│   ├── index.js              WebSocket server, LLM streaming, TTS
│   ├── speaker_service.py    Speaker ID (Resemblyzer) + web search
│   └── start.sh              Entrypoint (starts Python + Node)
├── meet-bot/                 Google Meet bot (Node.js + Puppeteer)
│   ├── Dockerfile
│   └── src/                  Meet joiner, audio pipeline, Live2D
├── diarizer/                 Speaker diarization service (Python)
├── android/                  Android app (Kotlin + Live2D)
├── web/                      Web client (React + TypeScript + Vite)
├── docker-compose.yml        GPU services (default)
├── docker-compose.cpu.yml    CPU-only services
├── setup.sh                  Interactive setup wizard
└── .env.example              Configuration template
```

## ⚙️ Configuration

All configuration is via environment variables in `.env`. See [`.env.example`](.env.example) for the full list with descriptions.

Key variables:

| Variable | Description |
|----------|-------------|
| `GATEWAY_WS_URL` | OpenClaw Gateway WebSocket URL |
| `GATEWAY_TOKEN` | Gateway authentication token |
| `AUTH_TOKEN` | Client ↔ server shared secret |
| `TTS_ENGINE` | `kokoro` (GPU) or `edge` (cloud) |
| `BOT_NAME` | Bot name / wake word |

## 🔧 Troubleshooting

### Services Won't Start

```bash
# Check all service logs
docker compose logs -f

# Check specific service
docker compose logs voice-server
docker compose ps
```

**Common fixes:**
- Verify Docker daemon is running: `docker ps`
- Check port conflicts: `netstat -tuln | grep 3200`
- Increase Docker memory limit (STT needs ~6GB)

### Slow Speech Transcription

⚡ **GPU is not being used**

```bash
# Verify GPU allocation
nvidia-smi

# Check Docker GPU access
docker run --rm --gpus all nvidia/cuda:11.8.0-runtime nvidia-smi
```

**Solution:** Use `docker-compose.yml` (GPU) instead of `docker-compose.cpu.yml`

### No Audio Response

🔇 **TTS engine isn't running**

```bash
# Check Kokoro health
curl http://localhost:5004/health

# View Kokoro logs
docker compose logs kokoro-tts
```

**Solution:** Enable fallback TTS in `.env`

```bash
TTS_ENGINE=edge  # Use cloud-based Edge TTS (slower but reliable)
```

### Can't Connect from Android

📱 **Connection refused / timeout**

```bash
# Verify voice server is accessible
curl http://YOUR_SERVER_IP:3200/health

# Check firewall
sudo ufw allow 3200/tcp
```

**Solutions:**
- Use your **LAN IP** (e.g., `192.168.1.100`), not `localhost`
- For remote access: use **Tailscale** or **WSS with TLS**
- Check that server is listening on all interfaces: `netstat -tuln | grep 3200`

## 📖 Documentation

### Core Documentation

| Doc | Description |
|-----|-------------|
| **[Architecture & Protocol](docs/ARCHITECTURE.md)** | System design, WebSocket protocol spec, data flow diagrams |
| **[Server Configuration](server/README.md)** | Voice server setup, environment variables, speaker ID |
| **[Meet Bot Setup](meet-bot/README.md)** | Google Meet integration, calendar auto-join, Live2D streaming |
| **[Android App](android/README.md)** | Building from source, Live2D integration, device capabilities |
| **[Web Client](web/README.md)** | Web app setup, React components, real-time streaming |

### Quick References

- **Roadmap:** [PLAN.md](PLAN.md) — Current sprints, completed features, backlog
- **Issues?** [Troubleshooting Guide](#-troubleshooting) above
- **Contributing:** Pull requests welcome! Check out open issues

---

## 📊 Performance Metrics

| Component | GPU | CPU | Fallback |
|-----------|-----|-----|----------|
| **Speech Recognition** | 239ms | 2.5s | Whisper model can handle both |
| **Text-to-Speech** | 460ms | N/A | Edge TTS (2.3s, cloud) |
| **Speaker ID** | — | ~100ms | Similarity matching |

All timings measured on NVIDIA RTX 4090 (GPU) and Intel i9 (CPU).

---

## 📄 License

MIT License — See [LICENSE](LICENSE) for details

---

**Made with ❤️ by the OpenClaw community. Deploy it, fork it, make it yours!**
