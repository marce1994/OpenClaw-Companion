# OpenClaw Companion — Architecture

System architecture and protocol specification for the OpenClaw Companion voice assistant.

## System Overview

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                             CLIENT LAYER                                     │
│                                                                              │
│  ┌──────────────┐   ┌──────────────┐   ┌───────────────────────────────┐    │
│  │  Android App │   │  Web Client  │   │  Google Meet Bot              │    │
│  │  (Kotlin)    │   │  (React/TS)  │   │  (Puppeteer + PulseAudio)    │    │
│  │              │   │              │   │                               │    │
│  │  • Live2D    │   │  • Live2D    │   │  • Join Meet as participant   │    │
│  │  • PTT voice │   │  • PTT voice │   │  • Live2D avatar as camera   │    │
│  │  • Smart     │   │  • Smart     │   │  • Bilingual EN/ES           │    │
│  │    Listen    │   │    Listen    │   │  • Calendar auto-join        │    │
│  │  • Text chat │   │  • Text chat │   │  • Respond when mentioned    │    │
│  └──────┬───────┘   └──────┬───────┘   └──────────────┬──────────────┘    │
│         │                  │                           │                    │
│         └────────┬─────────┘                           │                    │
│                  │ WS :3200 / WSS :3443                │ direct             │
└──────────────────┼─────────────────────────────────────┼────────────────────┘
                   │                                     │
┌──────────────────┼─────────────────────────────────────┼────────────────────┐
│                  ▼           VOICE SERVER               │                    │
│  ┌────────────────────────────────────────┐             │                    │
│  │  Node.js WebSocket Server (:3200)      │             │                    │
│  │  • Auth & session mgmt (seq IDs)       │             │                    │
│  │  • Sentence-boundary detection         │             │                    │
│  │  • Emotion/artifact/button extraction  │             │                    │
│  │  • Parallel TTS per sentence           │             │                    │
│  │  • Barge-in & cancellation             │             │                    │
│  │  • Conversation history (10 exchanges) │             │                    │
│  │  • Auto web search injection           │             │                    │
│  └──────┬─────────┬────────────┬──────────┘             │                    │
│         │         │            │                        │                    │
│         ▼         ▼            ▼                        │                    │
│  ┌──────────┐ ┌─────────┐ ┌──────────────┐             │                    │
│  │ Speaker  │ │ Whisper │ │ TTS Engine   │◄────────────┘                    │
│  │ ID :3201 │ │ ASR     │ │ Kokoro :5004 │ (shared by meet bot)            │
│  │ +Search  │ │ :9000   │ │ XTTS   :5002 │                                 │
│  └──────────┘ └─────────┘ │ Edge (cloud) │                                 │
│                           └──────────────┘                                  │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │  OpenClaw Gateway (:18789)                                           │    │
│  │  HTTP: /v1/chat/completions | WS: native protocol v3                 │    │
│  │  → LLM (Claude, GPT, Gemini, local models via Ollama, etc.)         │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Component Details

### Google Meet Bot (Node.js + Puppeteer)

Joins Google Meet calls as a participant with an animated Live2D avatar.

**Modules:**
- `meet-joiner.js` — Puppeteer browser automation. Launches Chromium on Xvfb, navigates to Meet, enters name, clicks join, handles admission wait, detects meeting end.
- `audio-pipeline.js` — PulseAudio virtual audio routing. `parec` captures Meet audio from `meet_capture.monitor`, `paplay` injects TTS audio into `tts_output` (which feeds Chrome's virtual mic).
- `transcriber.js` — VAD (energy-based RMS) + Whisper ASR. Buffers audio until speech ends, sends to Whisper, emits transcripts with auto-detected language.
- `ai-responder.js` — Gateway WebSocket client. Detects bot name mentions, sends contextual prompts to OpenClaw, handles streaming response, generates bilingual TTS (Kokoro primary, Edge fallback).
- `live2d-canvas.js` — Injects PixiJS + pixi-live2d-display into the Meet page. Renders Live2D model on a hidden canvas, captures stream at 30fps, replaces WebRTC video track via `RTCPeerConnection.sender.replaceTrack()`. Lip sync during TTS playback.
- `calendar-sync.js` — Fetches private ICS feed on startup + every N hours, parses VEVENT blocks for Google Meet links, schedules precise `setTimeout` timers to auto-join/leave.
- `meeting-memory.js` — Stores transcript entries with timestamps and speakers, exports as markdown.

**Audio Architecture:**
```
┌─────────────────────────────────────────────────────────┐
│  PulseAudio (inside container)                          │
│                                                         │
│  ┌─────────────┐     ┌───────────────┐                 │
│  │ meet_capture │────►│ parec capture │──► Whisper ASR  │
│  │ (null sink)  │     │ (s16le 16kHz) │                 │
│  └─────────────┘     └───────────────┘                 │
│  ▲ default sink                                         │
│  │ Chrome outputs here                                  │
│                                                         │
│  ┌─────────────┐     ┌───────────────┐                 │
│  │ tts_output   │◄────│ paplay inject │◄── TTS audio   │
│  │ (null sink)  │     └───────────────┘                 │
│  └──────┬──────┘                                        │
│         │ .monitor                                      │
│         ▼                                               │
│  ┌─────────────┐                                        │
│  │ virtual_mic  │ ◄── default source                    │
│  │ (remap)      │     Chrome picks this up as mic       │
│  └─────────────┘                                        │
└─────────────────────────────────────────────────────────┘
```

**Live2D Camera Injection:**
1. Before navigating to Meet: `page.evaluateOnNewDocument()` overrides `getUserMedia` to capture video stream reference and intercept `RTCPeerConnection.addTrack()` for video senders.
2. After joining Meet: PixiJS + pixi-live2d-display loaded from CDN, Live2D model loaded from local server (`http://localhost:3300/live2d/`), rendered on a hidden canvas.
3. `canvas.captureStream(30)` provides a MediaStream. Video track replaces WebRTC sender track via `sender.replaceTrack()`.
4. Lip sync driven by `speaking-start`/`speaking-end` events from AI responder.

**Environment Variables:**
| Variable | Default | Description |
|----------|---------|-------------|
| `GATEWAY_WS_URL` | `ws://127.0.0.1:18789` | OpenClaw Gateway WebSocket |
| `GATEWAY_TOKEN` | (required) | Gateway auth token |
| `WHISPER_URL` | `http://127.0.0.1:9000/asr` | Whisper ASR endpoint |
| `TTS_ENGINE` | `kokoro` | TTS engine: `kokoro` or `edge` |
| `KOKORO_URL` | `http://127.0.0.1:5004` | Kokoro TTS endpoint |
| `KOKORO_VOICE` | `em_alex` | Spanish voice |
| `KOKORO_VOICE_EN` | `af_heart` | English voice |
| `TTS_VOICE` | `es-AR-TomasNeural` | Edge TTS voice (fallback) |
| `BOT_NAME` | `Jarvis` | Bot display name + wake word |
| `LIVE2D_MODEL` | `Mao` | Live2D model: `Mao`, `Hiyori`, `Rice` |
| `LIVE2D_ENABLED` | `true` | Enable Live2D avatar as camera |
| `DEFAULT_LANG` | `es` | Default language (`en` or `es`) |
| `GOOGLE_CALENDAR_ICS` | (empty) | Private ICS URL for auto-join |
| `CALENDAR_REFRESH_HOURS` | `6` | ICS refresh interval |
| `CALENDAR_JOIN_BEFORE_SEC` | `60` | Join N seconds before event |
| `GW_SESSION_KEY` | `meet` | Gateway session prefix |
| `MEET_PORT` | `3300` | HTTP API port |

---

### Voice Server (Node.js)

The central bridge that orchestrates all services. Single container running both Node.js and Python.

**Responsibilities:**
- WebSocket server for client connections (WS + optional WSS)
- Authentication with shared token
- Session management with reconnect support (5-min TTL, 40-message buffer)
- Audio routing to Whisper ASR
- Text routing to OpenClaw Gateway (HTTP SSE or native WebSocket)
- Sentence-boundary detection in streaming LLM output
- Parallel TTS generation per sentence
- Emotion tag extraction and fallback keyword detection
- Code artifact extraction (>200 char code blocks)
- Button extraction (`[[buttons:opt1|opt2]]` syntax)
- Web search auto-detection and result injection
- Conversation history (sliding window of 10 exchanges)
- Barge-in handling with partial response preservation

### Speaker Identification Service (Python)

Embedded HTTP microservice using Resemblyzer for voice biometrics.

**Capabilities:**
- Speaker embedding extraction from WAV audio
- Cosine similarity matching against stored profiles
- Auto-enrollment: first speaker → owner (after 3 samples)
- Unknown speaker tracking and auto-enrollment
- Self-introduction detection ("my name is X" / "me llamo X")
- Profile management: enroll, rename, reset
- DuckDuckGo web search endpoint

### TTS Engines

| Engine | Type | Latency | GPU | Voice Cloning | Fallback |
|--------|------|---------|-----|---------------|----------|
| **Kokoro** | Local | ~460ms | Required | No | → Edge |
| **Edge** | Cloud | ~2300ms | No | No | — |
| **XTTS v2** | Local | ~1000ms | Required | Yes | → Edge |

All engines produce audio that's sent as base64 in `audio_chunk` messages. Engine is switchable at runtime via WebSocket.

---

## WebSocket Protocol Specification

### Connection Flow

```
Client                              Server
  │                                    │
  │──── WebSocket Connect ────────────►│
  │                                    │
  │──── auth {token, sessionId?} ─────►│
  │                                    │
  │◄─── auth {status, sessionId} ─────│
  │◄─── [replayed missed messages] ───│
  │                                    │
  │──── audio/text/image ─────────────►│
  │                                    │
  │◄─── status {transcribing} ────────│
  │◄─── transcript {text} ────────────│
  │◄─── status {thinking} ────────────│
  │◄─── status {speaking} ────────────│
  │◄─── emotion {emotion} ────────────│
  │◄─── reply_chunk {text, idx, emo} ─│
  │◄─── audio_chunk {data, idx, emo} ─│
  │◄─── reply_chunk {text, idx, emo} ─│
  │◄─── audio_chunk {data, idx, emo} ─│
  │◄─── buttons {options[]} ──────────│
  │◄─── stream_done ──────────────────│
  │◄─── status {idle} ────────────────│
  │                                    │
  │──── barge_in ─────────────────────►│
  │◄─── stop_playback ────────────────│
  │◄─── status {idle} ────────────────│
```

### Message Sequence Numbers

Every server → client message includes `sseq` (server sequence number, monotonically increasing). On reconnect, the client sends `lastServerSeq` to receive missed messages.

Client → server messages can include `cseq` for deduplication. The server tracks the last seen `cseq` per session and skips duplicates.

### Smart Listen Flow

```
Client                              Server
  │                                    │
  │──── ambient_audio {data} ─────────►│
  │                                    │
  │◄─── smart_status {transcribing} ──│
  │                                    │  ┌─ Whisper + Speaker ID (parallel)
  │                                    │  │
  │◄─── ambient_transcript ───────────│  │  {text, speaker, isOwner, isKnown}
  │                                    │
  │  [if wake word detected or owner]  │
  │                                    │
  │◄─── transcript {[Speaker] text} ──│
  │◄─── status {thinking} ────────────│
  │◄─── ... (normal response flow) ───│
  │                                    │
  │  [if no trigger]                   │
  │◄─── smart_status {listening} ─────│
```

### State Machine

```
idle ──► transcribing ──► thinking ──► speaking ──► idle
  ▲                                        │
  └──────────── barge_in / cancel ─────────┘
```

### Complete Message Reference

#### Client → Server

| Type | Required Fields | Optional Fields | Description |
|------|----------------|-----------------|-------------|
| `auth` | `token` | `sessionId`, `lastServerSeq`, `clientSeq` | Authenticate |
| `audio` | `data` (base64 WAV) | `prefix` | Voice → transcribe → respond |
| `ambient_audio` | `data` (base64 WAV) | | Smart Listen audio |
| `text` | `text` | `prefix` | Text message |
| `image` | `data` (base64) | `mimeType`, `text` | Image for vision |
| `file` | `data` (base64), `name` | | Text file for analysis |
| `cancel` | | | Cancel generation |
| `barge_in` | | | Interrupt + stop playback |
| `clear_history` | | | Clear conversation memory |
| `replay` | | | Replay last audio |
| `set_bot_name` | `name` | | Change wake word |
| `enroll_audio` | `data` (base64 WAV), `name` | `append` | Enroll speaker |
| `get_profiles` | | | List speakers |
| `rename_speaker` | `oldName`, `newName` | | Rename speaker |
| `reset_speakers` | | | Reset all profiles |
| `set_tts_engine` | `engine` | | Switch TTS engine |
| `get_settings` | | | Get server config |
| `ping` | | | Keep-alive |

#### Server → Client

| Type | Fields | Description |
|------|--------|-------------|
| `auth` | `status`, `sessionId`, `serverSeq` | Auth result |
| `status` | `status` | State: `transcribing`, `thinking`, `speaking`, `idle` |
| `transcript` | `text` | User speech transcription |
| `reply_chunk` | `text`, `index`, `emotion` | AI response sentence (text) |
| `audio_chunk` | `data` (base64), `index`, `emotion`, `text` | AI response sentence (audio) |
| `stream_done` | | All chunks sent |
| `stop_playback` | | Stop audio (barge-in) |
| `emotion` | `emotion` | First sentence emotion |
| `history_cleared` | | History cleared confirmation |
| `ambient_transcript` | `text`, `speaker`, `isOwner`, `isKnown` | Smart Listen transcript |
| `smart_status` | `status` | Smart Listen state |
| `artifact` | `artifactType`, `content`, `language`, `title` | Code block artifact |
| `buttons` | `options[]` (`{text, value}`) | Interactive buttons |
| `settings` | `ttsEngine`, `ttsEngines[]`, `botName`, `ownerName` | Server settings |
| `tts_engine` | `engine`, `status` | TTS engine change result |
| `profiles` | `profiles[]`, `count`, `ownerEnrolled` | Speaker profiles |
| `enroll_result` | `status`, `speaker`/`message` | Enrollment result |
| `rename_result` | `status`, `old`, `new`/`message` | Rename result |
| `reset_result` | `status` | Reset result |
| `error` | `message` | Error |
| `pong` | | Keep-alive response |

### Emotion Values

```
happy | sad | surprised | thinking | confused | laughing | neutral | angry | love
```

Embedded in LLM output as `[[emotion:X]]` tags. Extracted by the server and sent in `reply_chunk` / `audio_chunk` / `emotion` messages.
