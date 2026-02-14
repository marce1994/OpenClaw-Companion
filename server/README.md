# OpenClaw Companion — Voice Server

WebSocket bridge server that connects clients (Android/Web) with Whisper ASR, OpenClaw Gateway (LLM), and TTS engines. Streams AI responses sentence-by-sentence with parallel TTS generation for low-latency voice output.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Supporting Services Setup](#supporting-services-setup)
- [Voice Server Setup](#voice-server-setup)
- [Environment Variables](#environment-variables)
- [TLS / WSS Setup](#tls--wss-setup)
- [Gateway WebSocket Integration](#gateway-websocket-integration)
- [Speaker Identification](#speaker-identification)
- [HTTP Endpoints](#http-endpoints)
- [WebSocket Protocol](#websocket-protocol)
- [Streaming Architecture](#streaming-architecture)
- [Running Without Docker](#running-without-docker)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

- **Docker** (for containerized deployment)
- **OpenClaw Gateway** running with chat completions enabled (default port `18789`)
- **GPU** (optional but recommended) — NVIDIA GPU with [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html) for Whisper, Kokoro, and XTTS
- **Network**: the voice server container runs with `--network host` to reach all local services

## Supporting Services Setup

The voice server depends on external services for ASR and TTS. Set these up first.

### 1. Whisper ASR (Speech Recognition)

Whisper transcribes user audio to text. The `large-v3-turbo` model gives the best accuracy.

```bash
docker run -d --name whisper-asr \
  --gpus all \
  -p 9000:9000 \
  -e ASR_MODEL=large-v3-turbo \
  onerahmet/openai-whisper-asr-webservice:latest
```

**CPU-only** (slower, no GPU required):
```bash
docker run -d --name whisper-asr \
  -p 9000:9000 \
  -e ASR_MODEL=small \
  onerahmet/openai-whisper-asr-webservice:latest
```

- GPU: ~2GB VRAM for `large-v3-turbo`, ~1GB for `small`
- CPU: ~3GB RAM for `large-v3-turbo`, ~1GB for `small`
- First request takes 30–60s while the model loads

The server auto-detects the Whisper API format (OpenAI-compatible `/v1/audio/transcriptions` or original `/asr`).

### 2. Kokoro TTS (Primary — Local GPU, ~460ms latency)

Kokoro is the fastest local TTS option. Recommended as the primary engine.

```bash
docker run -d --name kokoro-tts \
  --gpus all \
  -p 5004:8080 \
  ghcr.io/remsky/kokoro-fastapi-gpu:v0.4.2
```

- Requires NVIDIA GPU
- Port mapping: host `5004` → container `8080`
- Default voice: `em_alex` (configurable via `KOKORO_VOICE`)
- Supports Spanish pipeline

### 3. XTTS v2 (Optional — Voice Cloning, ~1000ms latency)

XTTS allows voice cloning from a reference audio sample.

```bash
docker run -d --name xtts-server \
  --gpus all \
  -p 5002:80 \
  ghcr.io/coqui-ai/xtts-streaming-server:latest
```

- Requires NVIDIA GPU
- Port mapping: host `5002` → container `80`
- Place a `reference.wav` file at `/tmp/reference.wav` inside the voice server container for voice cloning
- Slower than Kokoro but supports any voice

### 4. Edge TTS (Fallback — Cloud, ~2300ms latency)

Edge TTS requires no setup — it's built into the voice server container. It uses Microsoft's cloud TTS service and requires internet access. All TTS engines automatically fall back to Edge TTS on error.

---

## Voice Server Setup

### Build the Docker Image

```bash
cd server
docker build -t jarvis-voice-img .
```

### Run the Voice Server

```bash
docker run -d --name jarvis-voice \
  --network host \
  -e AUTH_TOKEN=my-secret-token \
  -e WHISPER_URL=http://127.0.0.1:9000/asr?language=es\&output=json \
  -e GATEWAY_TOKEN=your-openclaw-gateway-token \
  -e GATEWAY_URL=http://127.0.0.1:18789/v1/chat/completions \
  -e TTS_ENGINE=kokoro \
  -e TTS_VOICE=es-AR-TomasNeural \
  -e KOKORO_URL=http://127.0.0.1:5004 \
  -e KOKORO_VOICE=em_alex \
  -e XTTS_URL=http://127.0.0.1:5002 \
  -e BOT_NAME=jarvis \
  -e OWNER_NAME=User \
  -v /tmp/speaker-profiles:/data/speakers \
  jarvis-voice-img
```

**Key points:**
- `--network host` — required so the container can reach Whisper, Kokoro, XTTS, and OpenClaw Gateway on localhost
- `-v /tmp/speaker-profiles:/data/speakers` — persists speaker voice profiles across container restarts
- The server listens on port `3200` (WS) and optionally `3443` (WSS)

### Verify It's Running

```bash
# Check health
curl http://localhost:3200/health
# → {"status":"ok"}

# Get the auth token from logs (if auto-generated)
docker logs jarvis-voice 2>&1 | grep "Token:"
```

---

## Environment Variables

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3200` | WebSocket server port |
| `AUTH_TOKEN` | *(random)* | Shared secret for client authentication. Auto-generated and printed at startup if not set. |
| `WHISPER_URL` | `http://172.18.0.1:9000/asr?language=es&output=json` | Whisper ASR endpoint URL |
| `GATEWAY_URL` | `http://172.18.0.1:18789/v1/chat/completions` | OpenClaw HTTP chat completions endpoint |
| `GATEWAY_TOKEN` | *(required)* | Bearer token for the OpenClaw Gateway |
| `BOT_NAME` | `jarvis` | Wake word for Smart Listen mode (case-insensitive) |
| `OWNER_NAME` | `Pablo` | Name used for the auto-enrolled owner speaker profile |
| `SPEAKER_URL` | `http://127.0.0.1:3201` | Speaker ID service (internal, don't change) |

### TTS Engines

| Variable | Default | Description |
|----------|---------|-------------|
| `TTS_ENGINE` | `edge` | Active TTS engine: `edge`, `kokoro`, or `xtts` |
| `TTS_VOICE` | `es-AR-TomasNeural` | Edge TTS voice name ([browse voices](https://gist.github.com/BettyJJ/17cbaa1de96235a7f5773b8571a3ea95)) |
| `KOKORO_URL` | `http://127.0.0.1:5004` | Kokoro TTS server URL |
| `KOKORO_VOICE` | `em_alex` | Kokoro voice ID |
| `XTTS_URL` | `http://127.0.0.1:5002` | XTTS v2 streaming server URL |

### Gateway WebSocket Mode

| Variable | Default | Description |
|----------|---------|-------------|
| `USE_GATEWAY_WS` | `false` | Enable native WebSocket connection to OpenClaw Gateway (instead of HTTP) |
| `GATEWAY_WS_URL` | `ws://172.18.0.1:18789` | Gateway WebSocket URL |
| `GW_SESSION_KEY` | `voice` | Session key for the Gateway WS connection (separate from other channels) |

### TLS / WSS

| Variable | Default | Description |
|----------|---------|-------------|
| `TLS_CERT` | *(empty)* | Path to TLS certificate file (PEM) |
| `TLS_KEY` | *(empty)* | Path to TLS private key file (PEM) |
| `WSS_PORT` | `3443` | Port for the WSS (TLS) server |

### Speaker Identification (Python service)

| Variable | Default | Description |
|----------|---------|-------------|
| `SPEAKER_PROFILES_DIR` | `/data/speakers` | Directory for speaker profile `.npy` files |
| `SIMILARITY_THRESHOLD` | `0.70` | Minimum cosine similarity to identify a known speaker |
| `AUTO_ENROLL_THRESHOLD` | `0.65` | Minimum similarity for auto-enrollment samples |
| `OWNER_ENROLL_SAMPLES` | `3` | Number of audio samples to collect before auto-enrolling the owner |
| `SPEAKER_PORT` | `3201` | Internal HTTP port for the speaker service |

---

## TLS / WSS Setup

Web clients served over HTTPS (e.g., GitHub Pages) require a `wss://` connection. To enable WSS:

### Using Tailscale Certificates

```bash
# Generate certs for your Tailscale hostname
sudo tailscale cert your-machine.tail-scale.ts.net

# Mount certs into the container
docker run -d --name jarvis-voice \
  --network host \
  -e TLS_CERT=/certs/your-machine.tail-scale.ts.net.crt \
  -e TLS_KEY=/certs/your-machine.tail-scale.ts.net.key \
  -e WSS_PORT=3443 \
  -v /path/to/certs:/certs:ro \
  -v /tmp/speaker-profiles:/data/speakers \
  -e AUTH_TOKEN=my-secret-token \
  -e GATEWAY_TOKEN=your-gateway-token \
  -e TTS_ENGINE=kokoro \
  jarvis-voice-img
```

The server will listen on both:
- `ws://0.0.0.0:3200` (plain WebSocket)
- `wss://0.0.0.0:3443` (TLS WebSocket)

### Using Let's Encrypt or Custom Certs

Set `TLS_CERT` and `TLS_KEY` to the paths of your PEM certificate and key files. Mount them as a volume.

---

## Gateway WebSocket Integration

By default, the voice server uses HTTP POST to `GATEWAY_URL` for chat completions (SSE streaming). Optionally, it can connect as a native WebSocket client to the OpenClaw Gateway for richer integration:

```bash
-e USE_GATEWAY_WS=true \
-e GATEWAY_WS_URL=ws://127.0.0.1:18789 \
-e GW_SESSION_KEY=voice
```

**Benefits of Gateway WS mode:**
- Persistent session with the Gateway (separate "voice" session key)
- Support for proactive messages from the Gateway
- Native protocol v3 integration (JSON-RPC)
- Image attachments sent as base64 within the protocol

The voice server authenticates with `GATEWAY_TOKEN` and identifies as `OpenClaw Companion Voice Server` with operator role.

---

## Speaker Identification

The voice server includes an embedded Python microservice (port 3201) that uses [Resemblyzer](https://github.com/resemble-ai/Resemblyzer) for speaker identification.

### How It Works

1. **Auto-enrollment of owner**: The first person to speak is automatically enrolled as the owner (configured by `OWNER_NAME`). The system collects 3 audio samples to build a robust voice profile.
2. **Unknown speaker tracking**: Subsequent unknown speakers are assigned IDs (`Speaker_1`, `Speaker_2`, etc.) and auto-enrolled after 3 consistent samples.
3. **Self-introduction detection**: If someone says "my name is X" or "me llamo X", the system renames their profile automatically.
4. **Owner priority**: In Smart Listen mode, the owner's speech always triggers a response; other speakers must use the wake word.

### Speaker Profiles Volume

Speaker profiles are stored as `.npy` files in `/data/speakers`. Mount a host volume to persist them:

```bash
-v /tmp/speaker-profiles:/data/speakers
```

### Web Search

The speaker service also provides DuckDuckGo web search via `/search?q=query&max=5`. The voice server automatically detects when a user query needs web search results and injects them as context for the LLM.

---

## HTTP Endpoints

| Endpoint | Method | Auth | Description |
|----------|--------|------|-------------|
| `/health` | GET | No | Returns `{"status":"ok"}` |

---

## WebSocket Protocol

All messages are JSON over WebSocket on port 3200 (WS) or 3443 (WSS). The client must authenticate within 5 seconds of connecting.

### Authentication

```json
// Client → Server
{
  "type": "auth",
  "token": "my-secret-token",
  "sessionId": "optional-uuid",        // Resume existing session
  "lastServerSeq": 0,                  // Last received server sequence number
  "clientSeq": 0                       // Client sequence for dedup
}

// Server → Client
{
  "type": "auth",
  "status": "ok",
  "sessionId": "uuid",
  "serverSeq": 42
}
```

### Session Management

- Sessions persist across WebSocket reconnects for 5 minutes
- Pass `sessionId` and `lastServerSeq` in the auth message to resume
- Missed messages are automatically replayed on reconnect
- Up to 40 messages are buffered per session
- Conversation history (10 exchanges) persists within the session

### Client → Server Messages

| Type | Fields | Description |
|------|--------|-------------|
| `auth` | `token`, `sessionId?`, `lastServerSeq?`, `clientSeq?` | Authenticate and optionally resume session |
| `audio` | `data` (base64 WAV), `prefix?` | Voice recording for transcription + AI response |
| `ambient_audio` | `data` (base64 WAV) | Smart Listen mode audio (always-on mic) |
| `text` | `text`, `prefix?` | Text message to the AI |
| `image` | `data` (base64), `mimeType?`, `text?` | Image for vision analysis |
| `file` | `data` (base64), `name` | Text file for analysis (max 5MB, extensions: txt, md, json, csv, js, py, html, css, xml, yaml, yml, log) |
| `cancel` | — | Cancel current LLM generation |
| `barge_in` | — | Interrupt AI mid-response, stop client playback, save partial context |
| `clear_history` | — | Clear conversation memory |
| `replay` | — | Replay last audio response |
| `set_bot_name` | `name` | Change wake word for Smart Listen |
| `enroll_audio` | `data` (base64 WAV), `name`, `append?` | Manually enroll a speaker voice profile |
| `get_profiles` | — | List enrolled speaker profiles |
| `rename_speaker` | `oldName`, `newName` | Rename a speaker profile |
| `reset_speakers` | — | Delete all speaker profiles and reset enrollment |
| `set_tts_engine` | `engine` (`edge`/`kokoro`/`xtts`) | Switch TTS engine at runtime |
| `get_settings` | — | Get current server settings |
| `ping` | — | Keep-alive |

### Server → Client Messages

| Type | Fields | Description |
|------|--------|-------------|
| `auth` | `status`, `sessionId`, `serverSeq` | Authentication result |
| `status` | `status` | State machine: `transcribing` → `thinking` → `speaking` → `idle` |
| `transcript` | `text` | Whisper transcription of user speech |
| `reply_chunk` | `text`, `index`, `emotion` | One sentence of the AI response (text only) |
| `audio_chunk` | `data` (base64), `index`, `emotion`, `text` | TTS audio for one sentence |
| `stream_done` | — | All response chunks have been sent |
| `stop_playback` | — | Client should stop audio playback (barge-in) |
| `emotion` | `emotion` | Avatar emotion for the first sentence |
| `history_cleared` | — | Confirmation that history was cleared |
| `ambient_transcript` | `text`, `speaker`, `isOwner`, `isKnown` | Smart Listen transcription with speaker info |
| `smart_status` | `status` | Smart Listen state: `listening`, `transcribing` |
| `artifact` | `artifactType`, `content`, `language`, `title` | Code block extracted from response (>200 chars) |
| `buttons` | `options[]` (`{text, value}`) | Interactive button options from AI response |
| `settings` | `ttsEngine`, `ttsEngines[]`, `botName`, `ownerName` | Current server settings |
| `tts_engine` | `engine`, `status` | TTS engine change confirmation |
| `profiles` | `profiles[]`, `count`, `ownerEnrolled` | Speaker profile list |
| `enroll_result` | `status`, `speaker` or `message` | Speaker enrollment result |
| `rename_result` | `status`, `old`, `new` or `message` | Speaker rename result |
| `reset_result` | `status` | Speaker reset result |
| `error` | `message` | Error message |
| `pong` | — | Keep-alive response |

### Emotions

The AI tags each sentence with an emotion for avatar animation:

`happy`, `sad`, `surprised`, `thinking`, `confused`, `laughing`, `neutral`, `angry`, `love`

Emotions are extracted from `[[emotion:X]]` tags in the LLM output. If the LLM doesn't tag a sentence, keyword-based detection is used as fallback.

### Sequence Numbers

Every server message includes `sseq` (server sequence number). Clients track the last received `sseq` and send it as `lastServerSeq` on reconnect to receive missed messages.

---

## Streaming Architecture

```
Client (Android / Web)
    │
    ▼ WebSocket (base64 WAV audio)
┌───────────────────────────────────────────────────────────────┐
│  Voice Server (Node.js)                                       │
│                                                               │
│  Audio ──► Whisper ASR ──► Text                               │
│            (+ Speaker ID in parallel for ambient)             │
│                              │                                │
│                   ┌──────────┤                                │
│                   │   Web Search (if needed)                  │
│                   │   DuckDuckGo → inject context             │
│                   └──────────┤                                │
│                              ▼                                │
│  Text ──────────────► OpenClaw Gateway (SSE / WS streaming)   │
│                              │                                │
│                         token buffer                          │
│                              │                                │
│                    sentence boundary detected                 │
│                         ╱          ╲                           │
│                        ▼            ▼                          │
│                  reply_chunk    TTS engine                    │
│                  (immediate)   (parallel)                     │
│                        │            │                          │
│                        ▼            ▼                          │
│                  ◄── WebSocket ──► audio_chunk                │
│                                                               │
│  Barge-in ──► abort LLM + stop TTS + save partial context     │
└───────────────────────────────────────────────────────────────┘
```

**Key design decisions:**
- TTS runs in parallel per sentence — the client hears the first sentence while later ones are still being generated
- Sentence boundaries are detected by regex on `.!?` followed by whitespace or emotion tags
- Barge-in saves partial responses marked `[interrumpido]` so the AI has context
- All TTS engines fall back to Edge TTS on error

---

## Running Without Docker

```bash
cd server

# Install Node.js dependencies
npm install

# Install Python dependencies
pip install edge-tts resemblyzer soundfile numpy scipy librosa duckduckgo-search \
  torch --index-url https://download.pytorch.org/whl/cpu

# Start speaker ID service (background)
python3 speaker_service.py &

# Start voice server
AUTH_TOKEN=my-token GATEWAY_TOKEN=gw-token node index.js
```

---

## Troubleshooting

### "Connection refused" from voice server to Whisper
Whisper takes 30–60s to load the model on first start. Check:
```bash
docker logs whisper-asr
curl http://localhost:9000/docs  # Should show Swagger UI
```

### Auth token not working
If `AUTH_TOKEN` is not set, a random token is generated each restart. Set a fixed token or copy from logs:
```bash
docker logs jarvis-voice 2>&1 | grep "Token:"
```

### No speech detected / garbage transcriptions
- Verify Whisper is running: `curl http://localhost:9000/docs`
- Try a smaller model (`ASR_MODEL=base` or `small`) on CPU
- The server filters hallucinations (repeated words, mixed languages, nonsense patterns)

### TTS fails silently
- Edge TTS requires internet access
- Kokoro/XTTS require GPU and their respective containers running
- All engines fall back to Edge TTS on error — check logs for fallback messages

### Gateway connection errors
- Verify OpenClaw is running: `curl http://localhost:18789/health`
- Check `GATEWAY_TOKEN` matches your OpenClaw config
- With `--network host`, use `127.0.0.1` (not `host.docker.internal`)

### High memory usage
- Whisper `large-v3-turbo`: ~3GB RAM (CPU) or ~2GB VRAM (GPU)
- Resemblyzer voice encoder: ~500MB RAM
- Use `ASR_MODEL=small` for lower memory (~1GB)

### WSS not working
- Verify cert/key files exist and are readable
- Check `TLS_CERT` and `TLS_KEY` paths are correct inside the container
- Test: `curl -k https://localhost:3443/health`
