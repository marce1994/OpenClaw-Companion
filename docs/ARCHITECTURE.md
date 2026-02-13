# OpenClaw Companion — Architecture

## Overview

OpenClaw Companion is a multi-platform voice & chat assistant client. All platforms connect to the same **WebSocket server** which handles AI, TTS, STT, and speaker identification.

```
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│   Android    │  │     Web      │  │   Desktop    │
│   (Kotlin)   │  │  (React/TS)  │  │  (KMP/JVM)   │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                 │
       └────────┬────────┘────────┬────────┘
                │   WebSocket     │
         ┌──────▼─────────────────▼──────┐
         │      Voice Server (Node.js)    │
         │  - Auth & session sync         │
         │  - STT (Whisper)               │
         │  - LLM (OpenClaw Gateway)      │
         │  - TTS (Kokoro/XTTS/Edge)      │
         │  - Speaker ID (Resemblyzer)    │
         │  - Web search (DuckDuckGo)     │
         └────────────────────────────────┘
```

## Shared Protocol (WebSocket)

All clients implement the same WebSocket message protocol. This is the **single source of truth** for cross-platform behavior.

### Connection

```
ws://<server>:<port>  (default: 3200)
```

### Authentication

Client sends on connect:
```json
{
  "type": "auth",
  "token": "<auth-token>",
  "sessionId": "<previous-session-id>",     // optional, for reconnection
  "lastServerSeq": <last-received-sseq>      // optional, for replay
}
```

Server responds:
```json
{
  "type": "auth_success",
  "sessionId": "<session-id>",
  "serverSeq": <current-server-seq>,
  "sseq": 1
}
```

### Client → Server Messages

| Type | Fields | Description |
|------|--------|-------------|
| `audio` | `data` (base64 PCM 16-bit 16kHz mono) | Voice audio chunk |
| `text` | `text` | Text chat message |
| `image` | `data` (base64), `mimeType`, `caption?` | Send image |
| `file` | `data` (base64), `filename`, `mimeType` | Send file |
| `cancel` | — | Cancel current AI response |
| `barge_in` | — | Interrupt AI speech |
| `clear_history` | — | Clear conversation history |
| `ping` | — | Keepalive |
| `ambient_audio` | `data` (base64) | Smart Listen ambient audio |
| `enroll_audio` | `data` (base64), `name` | Enroll speaker voice profile |
| `get_profiles` | — | List enrolled speaker profiles |
| `set_bot_name` | `name` | Change bot display name |

### Server → Client Messages

All server messages include `sseq` (server sequence number) for replay/sync.

| Type | Fields | Description |
|------|--------|-------------|
| `auth_success` | `sessionId`, `serverSeq` | Auth confirmed |
| `transcription` | `text` | STT result of user's audio |
| `response` | `text` | AI text response (may stream via multiple messages) |
| `response_end` | — | AI response complete |
| `audio` | `data` (base64 MP3/WAV), `format` | TTS audio |
| `emotion` | `emotion` | Detected emotion tag for avatar |
| `error` | `message` | Error message |
| `artifact` | `title`, `language`, `content` | Code/content artifact |
| `button` | `buttons` (array of `{text, callback_data}`) | Inline buttons |
| `profiles` | `profiles` (array) | Speaker profiles list |
| `stop_playback` | — | Client should stop playing audio |
| `pong` | — | Keepalive response |

### Session Sync & Reconnection

1. Client stores `sessionId` and `lastServerSeq` (highest `sseq` received)
2. On reconnect, client sends both in `auth` message
3. Server replays missed messages (up to 40) with `_replayed: true` flag
4. Client deduplicates replayed messages (skip if already received)

### Audio Format

- **Recording**: PCM 16-bit, 16kHz, mono (little-endian)
- **TTS output**: MP3 (Edge/Kokoro) or WAV (XTTS)

## Platform Implementation Guide

### What Each Client Must Implement

1. **WebSocket connection** with auth, reconnection, and session sync
2. **Audio recording** from microphone → PCM → base64 → send as `audio` messages
3. **Audio playback** of received TTS audio (MP3/WAV)
4. **Chat UI** with message bubbles, markdown rendering, inline buttons, artifacts
5. **Emotion display** — parse `[[emotion:tag]]` from responses for avatar animation
6. **Barge-in** — detect user wants to interrupt, send `barge_in`, stop playback
7. **Smart Listen** (optional) — continuous ambient listening with speaker ID

### Platform-Specific Notes

#### Android (Current)
- AudioRecord for mic, MediaPlayer for playback
- Foreground service for background operation
- OkHttp WebSocket client
- Markwon for markdown

#### Web (In Development)
- Web Audio API / MediaRecorder for mic
- HTMLAudioElement or Web Audio API for playback
- Native WebSocket API
- react-markdown or marked for markdown
- Echo cancellation via `echoCancellation: true` constraint (free!)

#### Desktop (Planned)
- javax.sound.sampled for mic/playback
- Ktor WebSocket client
- Transparent floating window with avatar
- System tray integration

## File Structure

```
projects/voice-assistant/
├── server/              # WebSocket server (shared backend)
│   ├── index.js         # Main server
│   ├── speaker_service.py
│   ├── Dockerfile
│   └── start.sh
├── android/             # Android client
│   └── app/src/main/
├── web/                 # Web client (React + TypeScript)
│   ├── src/
│   │   ├── hooks/       # useWebSocket, useAudio, etc.
│   │   ├── components/  # ChatMessage, Avatar, etc.
│   │   ├── protocol/    # Message types, serialization
│   │   └── App.tsx
│   └── package.json
├── docs/
│   └── ARCHITECTURE.md  # This file
└── .github/workflows/
    └── build.yml        # CI/CD
```

## Adding a New Platform

1. Read this document and the WebSocket protocol spec above
2. Implement auth + session sync
3. Implement audio recording in platform's native API
4. Implement audio playback
5. Build chat UI with markdown support
6. Add emotion parsing for avatar (optional)
7. Add Smart Listen (optional)
8. Add to CI/CD workflow

The server doesn't need any changes — all platforms use the same WebSocket API.
