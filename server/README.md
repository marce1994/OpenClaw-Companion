# OpenClaw Companion - Voice Server

A complete, production-ready voice server stack for OpenClaw with integrated Speech-to-Text (Whisper), Text-to-Speech (Edge TTS or Kokoro), and seamless gateway integration.

## 🚀 Quick Start

Get the voice server running in under 5 minutes:

```bash
git clone https://github.com/marce1994/OpenClaw-Companion.git
cd OpenClaw-Companion/server
./setup.sh
```

The interactive setup script will:
- ✅ Check prerequisites (Docker, Docker Compose)
- ✅ Ask for your configuration (gateway URL, bot name, language)
- ✅ Generate `.env` file
- ✅ Pull Docker images
- ✅ Start all services
- ✅ Display connection information

**That's it!** Your voice server is ready to connect to OpenClaw Gateway.

---

## 📋 Requirements

### System Requirements

- **Docker**: v20.10+ (for Docker Compose v2)
- **Docker Compose**: v2.0+
- **RAM**: Minimum 2GB (recommended 4GB+)
- **Disk**: 5GB free space (for models and logs)

### Optional: GPU Support

For faster speech recognition and synthesis:

- **NVIDIA GPU**: with CUDA support
- **nvidia-docker**: runtime installed
- **VRAM**: 4GB+ recommended

### Network Requirements

- **Outbound**: 443 (https) for Edge TTS, 9000 (http) for Whisper
- **Port 3200**: WebSocket server (configurable)
- **Port 3443**: Secure WebSocket (optional, requires TLS)

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    OpenClaw Gateway                          │
│                                                              │
└────────────────────────┬────────────────────────────────────┘
                         │ WebSocket
                         ▼
┌─────────────────────────────────────────────────────────────┐
│                   Voice Server (Node.js)                     │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ • WebSocket handler                                  │   │
│  │ • Audio processing pipeline                          │   │
│  │ • Gateway communication                              │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────┬──────────────────────────────────────┬─────────────┘
          │ HTTP                                 │ HTTP
          ▼                                      ▼
    ┌──────────┐                           ┌──────────────┐
    │ Whisper  │◄──────────STT──────────┤ Voice Server │
    │ (Port 9000)                      └──────────────┘
    │          │
    │ • Speech Recognition              ┌──────────────┐
    │ • ASR Models: large-v3-turbo       │ Kokoro TTS   │
    │ • faster_whisper engine            │ (Port 5004)  │
    └──────────┘                      TTS │              │
                                       └──────────────┘
                                    or Edge TTS API
```

---

## 🔧 Configuration

### Automatic Setup (Recommended)

Run `./setup.sh` and answer the interactive prompts:

```bash
./setup.sh
```

The script will:
1. Verify Docker is installed and running
2. Ask for OpenClaw Gateway connection details
3. Configure bot name, owner, and language
4. Optionally enable GPU acceleration
5. Choose TTS engine (Edge or Kokoro)
6. Generate `.env` file with all settings
7. Start all Docker containers

### Manual Setup

If you prefer manual configuration:

1. **Copy environment template:**
   ```bash
   cp .env.example .env
   ```

2. **Edit `.env` with your settings:**
   ```bash
   nano .env
   ```

3. **Essential variables to set:**
   - `GATEWAY_WS_URL`: Your OpenClaw Gateway WebSocket URL (e.g., `ws://192.168.1.100:18789`)
   - `GATEWAY_TOKEN`: Authentication token from your gateway
   - `BOT_NAME`: Name of your voice assistant
   - `OWNER_NAME`: User's name

4. **Start services:**
   ```bash
   docker compose up -d
   ```

5. **Check status:**
   ```bash
   docker compose ps
   ```

---

## 📝 Environment Variables

### Required

| Variable | Description | Example |
|----------|-------------|---------|
| `GATEWAY_WS_URL` | OpenClaw Gateway WebSocket URL | `ws://192.168.1.100:18789` |
| `GATEWAY_TOKEN` | Authentication token | `your-token-here` |

### Optional but Recommended

| Variable | Default | Description |
|----------|---------|-------------|
| `BOT_NAME` | `jarvis` | Voice assistant name |
| `OWNER_NAME` | `Pablo` | Owner/user name |
| `LANGUAGE` | `es` | Language code (en, es, fr, de, it) |
| `TTS_ENGINE` | `edge` | TTS provider: `edge` or `kokoro` |
| `TTS_VOICE` | `es-AR-TomasNeural` | Text-to-speech voice |
| `AUTH_TOKEN` | Auto-generated | API authentication token |
| `GPU_ENABLED` | `false` | Enable GPU acceleration |

### Advanced

| Variable | Default | Description |
|----------|---------|-------------|
| `WHISPER_URL` | `http://whisper:9000/asr?language=es&output=json` | STT service URL |
| `KOKORO_URL` | `http://kokoro-tts:8080` | Kokoro TTS service URL |
| `WHISPER_WORKERS` | `1` | Whisper parallel workers |
| `LOG_LEVEL` | `info` | Logging verbosity |
| `DEBUG` | `false` | Debug mode |

---

## 🎤 Supported Languages & Voices

### Edge TTS (Default)

Supports 160+ voice options across 80+ languages:

- **English**: `en-US-AriaNeural`, `en-GB-SoniaNeural`
- **Spanish**: `es-AR-TomasNeural`, `es-ES-AlvaroNeural`
- **French**: `fr-FR-DeniseNeural`, `fr-CA-JeanNeural`
- **German**: `de-DE-ConradNeural`, `de-AT-KlausNeural`
- **Italian**: `it-IT-IsabellaNeural`, `it-IT-DiegoNeural`
- **Portuguese**: `pt-BR-FranciscaNeural`, `pt-PT-FernandoNeural`
- **Japanese**: `ja-JP-AzukiNeural`, `ja-JP-NaokiNeural`
- **Mandarin**: `zh-CN-YunxiNeural`, `zh-TW-HsiaoChenNeural`

**Whisper STT** supports 99 languages through the `large-v3-turbo` model.

---

## 🚀 Running the Services

### Start Services

```bash
# Interactive setup (recommended for first run)
./setup.sh

# Or manual start
docker compose up -d
```

### Check Service Status

```bash
docker compose ps
```

Expected output:
```
NAME                       STATUS
openclaw-voice-server      Up (healthy)
openclaw-whisper          Up (healthy)
openclaw-kokoro-tts       Up (healthy)
```

### View Logs

```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f voice-server
docker compose logs -f whisper
docker compose logs -f kokoro-tts
```

### Stop Services

```bash
docker compose down
```

### Restart Services

```bash
docker compose restart
```

---

## 🔌 Connecting to OpenClaw Gateway

After the voice server starts, it will automatically:

1. Connect to your OpenClaw Gateway via WebSocket
2. Register as a voice assistant service
3. Listen for audio streams from gateway clients
4. Process speech and send responses back

### Debug Connection

Check voice server logs for gateway connection status:

```bash
docker compose logs voice-server | grep -i "gateway\|connect"
```

Expected log lines:
```
✅ Connected to Gateway at ws://gateway:18789
✅ Registered as voice assistant: jarvis
🎤 Ready to receive audio
```

---

## 🔐 Security Considerations

### Authentication

- **Voice Server API**: Protected by `AUTH_TOKEN` (randomly generated)
- **Gateway Connection**: Protected by `GATEWAY_TOKEN`

Keep tokens secure and rotate them periodically.

### TLS/WSS (Optional)

To enable secure WebSocket connections:

1. Generate certificates:
   ```bash
   mkdir -p certs
   openssl req -x509 -newkey rsa:4096 -keyout certs/server.key -out certs/server.crt -days 365 -nodes
   ```

2. Update `.env`:
   ```bash
   TLS_CERT_PATH=./certs/server.crt
   TLS_KEY_PATH=./certs/server.key
   ```

3. Restart services:
   ```bash
   docker compose restart voice-server
   ```

### Network Security

- Run Docker with `network_mode: host` (configurable)
- Restrict port access with firewall rules
- Use strong authentication tokens
- Monitor logs for unauthorized access

---

## 🐛 Troubleshooting

### Services Won't Start

Check prerequisites:
```bash
docker --version        # Should be 20.10+
docker compose version  # Should be v2+
docker ps               # Should return active containers
```

### Whisper Not Responding

```bash
# Check Whisper logs
docker compose logs whisper

# Restart Whisper
docker compose restart whisper

# Wait for it to download models (first run can take 5+ minutes)
docker compose logs -f whisper | grep -i "downloaded\|loaded"
```

### Voice Server Fails to Connect to Gateway

1. Verify `GATEWAY_WS_URL` is correct:
   ```bash
   echo $GATEWAY_WS_URL
   ```

2. Test gateway connectivity:
   ```bash
   curl -v ws://<gateway-host>:18789
   ```

3. Check `GATEWAY_TOKEN` is valid:
   ```bash
   docker compose logs voice-server | grep -i "token\|auth"
   ```

### Audio Quality Issues

- Adjust `AUDIO_BUFFER_SECONDS` (default: 5)
- Increase `WHISPER_WORKERS` if CPU allows
- Check network latency to gateway

### High GPU Memory Usage

For GPU systems with limited VRAM:

1. Reduce workers:
   ```bash
   WHISPER_WORKERS=1 docker compose up -d
   ```

2. Switch to CPU mode:
   ```bash
   GPU_ENABLED=false docker compose up -d
   ```

---

## 📊 Performance Tuning

### CPU-Only Deployment

Reduce memory footprint:

```bash
# In .env
GPU_ENABLED=false
WHISPER_WORKERS=1
WHISPER_IMAGE=onerahmet/openai-whisper-asr-webservice:latest
KOKORO_IMAGE=ghcr.io/remsky/kokoro-fastapi-cpu:latest
```

### GPU Deployment

For maximum performance:

```bash
# In .env
GPU_ENABLED=true
WHISPER_WORKERS=2
WHISPER_IMAGE=onerahmet/openai-whisper-asr-webservice:latest-gpu
KOKORO_IMAGE=ghcr.io/remsky/kokoro-fastapi-gpu:latest
WHISPER_RUNTIME=nvidia
KOKORO_RUNTIME=nvidia
```

### Memory Constraints

If running on low-RAM systems:

```bash
# Disable Kokoro TTS (if using Edge TTS)
docker compose down kokoro-tts

# Update docker-compose.yml to comment out kokoro-tts service
```

---

## 🔄 Updating

### Update Images

```bash
docker compose pull
docker compose up -d
```

### Check for Updates

```bash
# Check latest available versions
docker pull onerahmet/openai-whisper-asr-webservice:latest --dry-run
```

---

## 📚 Manual Setup (Advanced)

### 1. Create Directory Structure

```bash
mkdir -p voice-server/data/speakers
cd voice-server
```

### 2. Create Required Files

- Copy `docker-compose.yml`
- Copy `.env.example` as `.env` and edit
- Create `Dockerfile` for voice-server application

### 3. Build and Run

```bash
docker compose build
docker compose up -d
```

### 4. Monitor Startup

```bash
docker compose logs -f
```

---

## 🛠️ Development

### Local Testing

```bash
# Build custom voice-server image
docker compose build voice-server

# Run with local source code (requires volume mount in docker-compose.yml)
docker compose up -d
```

### Debugging

Enable debug mode in `.env`:

```bash
DEBUG=true
LOG_LEVEL=debug
```

Restart services:

```bash
docker compose restart voice-server
```

View detailed logs:

```bash
docker compose logs -f voice-server
```

---

## 📄 License

This project is part of the OpenClaw Companion ecosystem.

---

## 🤝 Support

For issues and questions:

1. Check the [Troubleshooting](#-troubleshooting) section
2. Review service logs: `docker compose logs -f`
3. Check the [OpenClaw documentation](https://github.com/marce1994/OpenClaw)
4. Open an issue on GitHub

---

## 🎯 Features

✅ **Production-Ready**: Tested and battle-hardened configuration  
✅ **Multiple Languages**: 80+ languages via Whisper STT  
✅ **Flexible TTS**: Choice between Edge (free) and Kokoro (local)  
✅ **GPU-Optimized**: Automatic GPU detection and optimization  
✅ **Easy Setup**: Interactive setup script with configuration wizard  
✅ **Health Checks**: Automatic service health monitoring  
✅ **Logging**: Comprehensive debug and production logging  
✅ **Scalable**: Supports up to 100 concurrent connections  
✅ **Secure**: Token-based authentication and optional TLS  
✅ **Remote Gateway**: Works with gateway on different machines  

---

**Created**: 2024  
**Last Updated**: February 2026  
**Version**: 2.0.0

---

## Post-Meeting Summary Pipeline

The voice server orchestrator manages an automated post-meeting processing pipeline:

### Flow
1. **Meet bot exits** → orchestrator detects container death
2. **Relevance check** → Gemini Flash evaluates if meeting is worth summarizing
3. **WhisperX diarization** → ephemeral GPU container processes full audio with speaker attribution
4. **Speaker mapping** → AI maps `SPEAKER_XX` labels to real names from participant list
5. **Summary generation** → Gemini Flash creates structured meeting summary
6. **Delivery** → Summary sent to Telegram + saved to memory files + indexed in Cognee knowledge graph

### Configuration

Copy `summary-config.example.json` to `summary-config.json` and fill in your credentials:

```bash
cp summary-config.example.json summary-config.json
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MEETINGS_HOST_DIR` | `/tmp/meetings` | **Host** path for meeting data persistence (must be a real host path, not container path) |
| `MEET_BOT_IMAGE` | `meet-bot:latest` | Docker image for meet bot workers |

> ⚠️ `MEETINGS_HOST_DIR` must be a path on the Docker **host**, not inside a container. The orchestrator passes this to `docker run` as a bind mount.
