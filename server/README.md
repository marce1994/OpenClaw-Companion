# OpenClaw Companion — Bridge Server

WebSocket server that bridges the Android app with Whisper ASR, OpenClaw gateway, and TTS. Streams AI responses sentence-by-sentence with parallel TTS generation for low-latency voice output.

## Prerequisites

- **Docker** and **Docker Compose** v2+
- **OpenClaw** gateway running with `chatCompletions` enabled
- A gateway auth token (from your OpenClaw config)

## Quick Start

```bash
# From the project root (not server/)
cp .env.example .env        # Edit with your GATEWAY_TOKEN and other settings
docker compose up -d         # CPU mode (works everywhere)
```

That's it. The server prints the auth token at startup:

```bash
docker compose logs voice-server | grep "Token:"
```

Enter that token in the Android app's settings along with your server URL.

### GPU Mode (NVIDIA)

```bash
docker compose -f docker-compose.yml -f docker-compose.gpu.yml up -d
```

Requires [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html).

### Without Docker

```bash
cd server
npm install
pip install edge-tts resemblyzer soundfile numpy scipy librosa duckduckgo-search torch --index-url https://download.pytorch.org/whl/cpu
python3 speaker_service.py &   # Speaker ID service on port 3201
node index.js                  # WebSocket server on port 3200
```

## Configuration Reference

All variables are set via environment or `.env` file. See [`.env.example`](../.env.example) for the full annotated list.

### Core

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3200` | WebSocket server port |
| `AUTH_TOKEN` | *(random)* | Shared secret for client auth. Printed at startup if auto-generated. |
| `GATEWAY_URL` | `http://host.docker.internal:18789/v1/chat/completions` | OpenClaw chat completions endpoint |
| `GATEWAY_TOKEN` | *(required)* | Bearer token for the OpenClaw gateway |
| `WHISPER_URL` | `http://whisper-asr:9000/asr?language=es&output=json` | Whisper ASR endpoint (auto-set by Docker Compose) |
| `BOT_NAME` | `jarvis` | Wake word for ambient/smart-listen mode |
| `OWNER_NAME` | `User` | Primary user name for speaker identification |
| `SPEAKER_URL` | `http://127.0.0.1:3201` | Speaker ID service (same container, don't change) |

### TTS Engines

Set `TTS_ENGINE` to one of the following:

#### `edge` (default) — Microsoft Edge TTS
- **Pros:** Free, no setup, good quality, ~300-800ms latency
- **Cons:** Requires internet, limited voice customization

| Variable | Default | Description |
|----------|---------|-------------|
| `TTS_VOICE` | `es-AR-TomasNeural` | Voice name ([browse voices](https://gist.github.com/BettyJJ/17cbaa1de96235a7f5773b8571a3ea95)) |

#### `kokoro` — Kokoro TTS (local GPU)
- **Pros:** Fastest local option (~400ms on RTX 3090), no internet needed
- **Cons:** Requires GPU, separate container

| Variable | Default | Description |
|----------|---------|-------------|
| `KOKORO_URL` | `http://host.docker.internal:5004` | Kokoro TTS server URL |
| `KOKORO_VOICE` | `em_alex` | Voice ID |

#### `xtts` — Coqui XTTS v2 (local GPU)
- **Pros:** Voice cloning from reference audio, no internet needed
- **Cons:** Slowest (~1000ms first chunk on RTX 3090), requires GPU

| Variable | Default | Description |
|----------|---------|-------------|
| `XTTS_URL` | `http://host.docker.internal:5002` | XTTS streaming server URL |

> All TTS engines fall back to Edge TTS on error.

## HTTP Endpoints

### `GET /health`
Returns `{"status":"ok"}`. No auth required. Use for health checks.

## WebSocket Protocol

All messages are JSON over WebSocket on port 3200. The client must authenticate within 5 seconds.

### Session Management

Sessions persist across reconnects. Pass `sessionId` and `lastServerSeq` in the auth message to resume. Missed messages are replayed automatically. Sessions expire after 5 minutes of inactivity.

### Client → Server

| Type | Fields | Description |
|------|--------|-------------|
| `auth` | `token`, `sessionId?`, `lastServerSeq?`, `clientSeq?` | Authenticate |
| `audio` | `data` (base64 WAV), `prefix?` | Voice recording for transcription + response |
| `ambient_audio` | `data` (base64 WAV) | Always-listening mode audio |
| `text` | `text`, `prefix?` | Text message |
| `image` | `data` (base64), `mimeType?`, `text?` | Image for vision analysis |
| `file` | `data` (base64), `name` | Text file for analysis (max 5MB) |
| `cancel` | — | Cancel current generation |
| `barge_in` | — | Interrupt AI mid-response, stop playback |
| `clear_history` | — | Clear conversation memory |
| `replay` | — | Replay last audio response |
| `set_bot_name` | `name` | Change wake word |
| `enroll_audio` | `data` (base64 WAV), `name`, `append?` | Enroll speaker voice profile |
| `get_profiles` | — | List enrolled speakers |
| `ping` | — | Keep-alive |

### Server → Client

| Type | Fields | Description |
|------|--------|-------------|
| `auth` | `status`, `sessionId`, `serverSeq` | Auth result |
| `status` | `status` | State: `transcribing` → `thinking` → `speaking` → `idle` |
| `transcript` | `text` | What Whisper heard |
| `reply_chunk` | `text`, `index`, `emotion` | One sentence of the AI response |
| `audio_chunk` | `data` (base64), `index`, `emotion`, `text` | TTS audio for one sentence |
| `stream_done` | — | All chunks sent |
| `stop_playback` | — | Stop audio (barge-in) |
| `history_cleared` | — | Conversation memory cleared |
| `emotion` | `emotion` | Avatar emotion (first sentence) |
| `ambient_transcript` | `text`, `speaker`, `isOwner`, `isKnown` | Ambient transcription |
| `smart_status` | `status` | Ambient status (`listening`, `transcribing`) |
| `artifact` | `artifactType`, `content`, `language`, `title` | Code blocks |
| `buttons` | `options[]` | Interactive buttons |
| `error` | `message` | Error |
| `pong` | — | Keep-alive response |

### Emotions

Valid emotion tags: `happy`, `sad`, `surprised`, `thinking`, `confused`, `laughing`, `neutral`, `angry`, `love`

### Conversation History

The server keeps a sliding window of the last 10 exchanges per session. History persists across reconnects via `sessionId`. Barge-in saves partial responses marked `[interrumpido]`.

## Streaming Architecture

```
Client (Android)
    │
    ▼ WebSocket (audio/text)
┌───────────────────────────────────────────────────────────┐
│  Voice Server                                             │
│                                                           │
│  Audio ──► Whisper ASR ──► Text                           │
│                              │                            │
│                              ▼                            │
│  Text ──────────────► OpenClaw Gateway (SSE streaming)    │
│                              │                            │
│                         token buffer                      │
│                              │                            │
│                    sentence boundary detected              │
│                         ╱          ╲                       │
│                        ▼            ▼                      │
│                  reply_chunk    TTS engine                 │
│                  (immediate)   (parallel)                  │
│                        │            │                      │
│                        ▼            ▼                      │
│                  ◄── WebSocket ──► audio_chunk             │
└───────────────────────────────────────────────────────────┘
```

## Troubleshooting

### "Connection refused" from voice-server to whisper-asr
Whisper takes 30-60s to load the model on first start. Check:
```bash
docker compose logs whisper-asr
```

### Auth token not working
If `AUTH_TOKEN` is empty in `.env`, a random token is generated each restart. Set a fixed token or copy from logs:
```bash
docker compose logs voice-server | grep "Token:"
```

### No speech detected / garbage transcriptions
- Check Whisper is running: `curl http://localhost:9000/docs`
- Try a smaller model (`ASR_MODEL=base`) if running on CPU
- Ensure audio is valid WAV format

### TTS fails silently
Edge TTS requires internet access. If running offline, switch to `kokoro` or `xtts`.

### Gateway connection errors
- Verify OpenClaw is running: `curl http://localhost:18789/health`
- Check `GATEWAY_TOKEN` matches your OpenClaw config
- On Linux, `host.docker.internal` may not resolve — use your machine's LAN IP instead

### High memory usage
- Whisper `large-v3-turbo` needs ~3GB RAM (CPU) or ~2GB VRAM (GPU)
- Use `ASR_MODEL=small` for lower memory (~1GB)
- Speaker profiles grow with enrollment — check `/data/speakers` volume
