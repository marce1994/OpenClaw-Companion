# Bridge Server

A Node.js WebSocket server that bridges the Android app with Whisper ASR, an OpenClaw gateway, and Edge TTS. It streams AI responses sentence-by-sentence with parallel TTS generation for low-latency voice output.

## How It Works

1. Android app connects via WebSocket and authenticates
2. App sends audio (WAV) or text
3. Server transcribes audio with Whisper ASR
4. Server streams the transcribed text to OpenClaw gateway via SSE (`stream: true`)
5. As LLM tokens arrive, the server accumulates them until a sentence boundary (`.` `!` `?`)
6. Each complete sentence is sent to Edge TTS in parallel
7. Text chunks and audio chunks are streamed back to the app as they're ready
8. App starts playing audio while the LLM is still generating

This streaming approach reduces perceived latency by 2-4 seconds compared to waiting for the full response.

## Setup

### Docker

```bash
docker build -t openclaw-companion-server .
docker run -d -p 3200:3200 \
  -e AUTH_TOKEN="your-secret-token" \
  -e WHISPER_URL="http://host.docker.internal:9000/asr?language=es&output=json" \
  -e GATEWAY_URL="http://host.docker.internal:18789/v1/chat/completions" \
  -e GATEWAY_TOKEN="your-gateway-token" \
  -e TTS_VOICE="es-AR-TomasNeural" \
  openclaw-companion-server
```

### Direct (Node.js 18+)

```bash
npm install
export AUTH_TOKEN="your-secret-token"
export WHISPER_URL="http://localhost:9000/asr?language=es&output=json"
export GATEWAY_URL="http://localhost:18789/v1/chat/completions"
export GATEWAY_TOKEN="your-gateway-token"
export TTS_VOICE="es-AR-TomasNeural"
node index.js
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3200` | Server listen port |
| `AUTH_TOKEN` | Random (printed at startup) | Shared secret for client auth |
| `WHISPER_URL` | `http://172.18.0.1:9000/asr?language=es&output=json` | Whisper ASR endpoint |
| `GATEWAY_URL` | `http://172.18.0.1:18789/v1/chat/completions` | OpenClaw chat completions endpoint |
| `GATEWAY_TOKEN` | — | Bearer token for the OpenClaw gateway |
| `TTS_VOICE` | `es-AR-TomasNeural` | Edge TTS voice name |

## HTTP Endpoints

### `GET /health`

Returns `{"status":"ok"}` — use for connectivity checks. No auth required.

## WebSocket Protocol

All WebSocket messages are JSON. The client must authenticate within 5 seconds or the connection is closed.

### Client → Server

#### `auth` — Authenticate
```json
{"type": "auth", "token": "your-secret-token"}
```

#### `audio` — Send voice recording
```json
{"type": "audio", "data": "<base64-encoded WAV>", "prefix": "optional context"}
```

#### `text` — Send text message
```json
{"type": "text", "text": "What's the weather like?", "prefix": "optional context"}
```

#### `cancel` — Cancel current response
```json
{"type": "cancel"}
```

#### `replay` — Replay last audio response
```json
{"type": "replay"}
```

#### `ping` — Keep-alive
```json
{"type": "ping"}
```

### Server → Client

#### `auth` — Authentication result
```json
{"type": "auth", "status": "ok"}
```

#### `status` — Processing state change
```json
{"type": "status", "status": "transcribing"}
```
Valid statuses: `transcribing`, `thinking`, `speaking`, `idle`

#### `transcript` — Speech-to-text result
```json
{"type": "transcript", "text": "What's the weather like?"}
```

#### `reply_chunk` — One sentence of the AI response
```json
{"type": "reply_chunk", "text": "It's sunny today!", "index": 0, "emotion": "happy"}
```

#### `audio_chunk` — TTS audio for one sentence
```json
{"type": "audio_chunk", "data": "<base64 MP3>", "index": 0, "emotion": "happy", "text": "It's sunny today!"}
```

#### `stream_done` — All chunks sent
```json
{"type": "stream_done"}
```

#### `emotion` — Detected emotion (sent with first sentence)
```json
{"type": "emotion", "emotion": "happy"}
```
Valid emotions: `happy`, `sad`, `surprised`, `thinking`, `confused`, `laughing`, `neutral`, `angry`, `love`

#### `error` — Error message
```json
{"type": "error", "message": "No speech detected"}
```

#### `pong` — Keep-alive response
```json
{"type": "pong"}
```

## TTS

The server uses [edge-tts](https://github.com/rany2/edge-tts) to generate speech using Microsoft Edge's neural voices. TTS runs server-side so the Android app doesn't need any TTS engine.

Browse available voices: `edge-tts --list-voices`

## Streaming Architecture

```
OpenClaw Gateway (SSE) ──tokens──► Sentence Buffer ──sentence──► Edge TTS ──MP3──► WebSocket
                                        │                           │
                                        ▼                           ▼
                                   reply_chunk                 audio_chunk
                                   (immediate)               (parallel gen)
```

Sentences are detected at `.` `!` `?` boundaries. TTS generation for each sentence runs in parallel with LLM streaming, so the client receives audio for sentence N while sentences N+1, N+2... are still being generated.
