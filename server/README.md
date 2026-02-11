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

### Whisper ASR (GPU)

```bash
docker run -d --gpus all -p 9000:9000 \
  -v whisper-models:/root/.cache \
  -e ASR_MODEL=large-v3-turbo \
  -e ASR_ENGINE=faster_whisper \
  onerahmet/openai-whisper-asr-webservice:latest-gpu
```

### Voice Server (Docker)

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
| `WHISPER_URL` | `http://172.18.0.1:9000/asr?language=es&output=json` | Whisper ASR endpoint (supports both `/asr` and `/v1/audio/transcriptions`) |
| `GATEWAY_URL` | `http://172.18.0.1:18789/v1/chat/completions` | OpenClaw chat completions endpoint |
| `GATEWAY_TOKEN` | — | Bearer token for the OpenClaw gateway |
| `TTS_VOICE` | `es-AR-TomasNeural` | Edge TTS voice name |
| `BOT_NAME` | `jarvis` | Wake word for ambient/smart-listen mode |
| `SPEAKER_URL` | `http://127.0.0.1:3201` | Speaker identification service URL |
| `OWNER_NAME` | `Pablo` | Name of the primary user (for speaker identification) |

## HTTP Endpoints

### `GET /health`

Returns `{"status":"ok"}` — use for connectivity checks. No auth required.

## WebSocket Protocol

All WebSocket messages are JSON. The client must authenticate within 5 seconds or the connection is closed.

### Session Management

Sessions persist across WebSocket reconnects. Pass `sessionId` and `lastServerSeq` in the auth message to resume a session. Missed messages are replayed automatically. Sessions expire after 5 minutes of inactivity.

### Client → Server

#### `auth` — Authenticate
```json
{"type": "auth", "token": "your-secret-token", "sessionId": "optional-uuid", "lastServerSeq": 0}
```

#### `audio` — Send voice recording
```json
{"type": "audio", "data": "<base64-encoded WAV>", "prefix": "optional context"}
```

#### `ambient_audio` — Send ambient/always-listening audio
```json
{"type": "ambient_audio", "data": "<base64-encoded WAV>"}
```

#### `text` — Send text message
```json
{"type": "text", "text": "What's the weather like?", "prefix": "optional context"}
```

#### `image` — Send image for vision analysis
```json
{"type": "image", "data": "<base64>", "mimeType": "image/jpeg", "text": "What's in this photo?"}
```

#### `file` — Send text file for analysis
```json
{"type": "file", "data": "<base64>", "name": "code.py"}
```

#### `cancel` — Cancel current response
```json
{"type": "cancel"}
```

#### `barge_in` — Interrupt AI mid-response
```json
{"type": "barge_in"}
```
Aborts the current LLM stream, tells the client to stop audio playback, and saves the partial response to conversation history (marked as `[interrumpido]`). Use when the user starts speaking while the AI is still responding.

#### `clear_history` — Clear conversation memory
```json
{"type": "clear_history"}
```
Clears all conversation history for the current session. The server responds with `history_cleared`.

#### `replay` — Replay last audio response
```json
{"type": "replay"}
```

#### `set_bot_name` — Change wake word
```json
{"type": "set_bot_name", "name": "friday"}
```

#### `enroll_audio` — Enroll speaker voice profile
```json
{"type": "enroll_audio", "data": "<base64 WAV>", "name": "Pablo", "append": false}
```

#### `get_profiles` — List enrolled speaker profiles
```json
{"type": "get_profiles"}
```

#### `ping` — Keep-alive
```json
{"type": "ping"}
```

### Server → Client

#### `auth` — Authentication result
```json
{"type": "auth", "status": "ok", "sessionId": "uuid", "serverSeq": 42}
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

#### `stop_playback` — Stop audio playback (barge-in)
```json
{"type": "stop_playback"}
```
Sent when a barge-in occurs. The client should immediately stop playing any queued audio.

#### `history_cleared` — Conversation history cleared
```json
{"type": "history_cleared"}
```

#### `emotion` — Detected emotion (sent with first sentence)
```json
{"type": "emotion", "emotion": "happy"}
```
Valid emotions: `happy`, `sad`, `surprised`, `thinking`, `confused`, `laughing`, `neutral`, `angry`, `love`

#### `ambient_transcript` — Ambient mode transcription
```json
{"type": "ambient_transcript", "text": "...", "speaker": "Pablo", "isOwner": true, "isKnown": true}
```

#### `smart_status` — Ambient mode status
```json
{"type": "smart_status", "status": "listening"}
```

#### `artifact` — Code block or large content
```json
{"type": "artifact", "artifactType": "code", "content": "...", "language": "python", "title": "python code"}
```

#### `buttons` — Interactive button options
```json
{"type": "buttons", "options": [{"text": "Yes", "value": "yes"}, {"text": "No", "value": "no"}]}
```

#### `error` — Error message
```json
{"type": "error", "message": "No speech detected"}
```

#### `pong` — Keep-alive response
```json
{"type": "pong"}
```

## Conversation History

The server maintains a sliding window of the last 10 exchanges (user + assistant message pairs) per connection. This gives the AI multi-turn context without unbounded memory growth.

- History is included in every LLM request as preceding messages
- History persists across WebSocket reconnects via the session store (tied to `sessionId`)
- Sessions expire after 5 minutes of no connection
- Send `clear_history` to reset the conversation
- Barge-in saves the partial response to history (marked `[interrumpido]`) so the AI knows it was cut off

## Barge-in

Barge-in lets the user interrupt the AI mid-response:

1. Client detects the user started speaking while audio is playing
2. Client sends `{"type": "barge_in"}`
3. Server aborts the LLM stream and saves the partial response to history
4. Server sends `{"type": "stop_playback"}` to tell the client to stop audio
5. Server sends `{"type": "status", "status": "idle"}`
6. Client can now send the new audio/text as usual

The partial response is recorded in history as `"... [interrumpido]"` so the AI understands it was cut off.

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
