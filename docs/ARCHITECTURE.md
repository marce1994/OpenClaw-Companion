# OpenClaw Companion — Architecture

System architecture and protocol specification for the OpenClaw Companion voice assistant.

## System Overview

![System Architecture Diagram](docs/images/architecture.png)

**Architecture Components:**

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
│  │  • Text chat │   │  • Text chat │   │  • Speaker detection         │    │
│  │  • 📱 Device │   │              │   │  • Transcript batching       │    │
│  │    commands  │   │              │   │  • Meeting memory export     │    │
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
│  │  • 🔊 Auto noise detection (quiet/     │             │                    │
│  │    noisy profiles with hysteresis)     │             │                    │
│  │  • 📱 Device command bridge (GPS,      │             │                    │
│  │    camera, system info, BT car mic)    │             │                    │
│  └──────┬─────────┬────────────┬──────────┘             │                    │
│         │         │            │                        │                    │
│         ▼         ▼            ▼                        │                    │
│  ┌──────────┐ ┌─────────┐ ┌──────────────┐             │                    │
│  │ Speaker  │ │whisper- │ │ TTS Engine   │◄────────────┘                    │
│  │ ID :3201 │ │fast STT │ │ Kokoro :5004 │ (shared by meet bot)            │
│  │ +Search  │ │ :9000   │ │ Edge (cloud) │                                 │
│  └──────────┘ └─────────┘ └──────────────┘                                  │
│                                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │  OpenClaw Gateway (WS native protocol v3)                            │    │
│  │  → LLM (Claude, GPT, Gemini, Ollama, etc.)                          │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────┘
```

## Docker Compose Services

### TTS Engine Performance Comparison

![TTS Latency Chart](https://quickchart.io/chart?w=700&h=400&c=%7B%22type%22%3A%20%22bar%22%2C%20%22data%22%3A%20%7B%22labels%22%3A%20%5B%22Kokoro%20%28GPU%29%22%2C%20%22XTTS%20v2%20%28GPU%29%22%2C%20%22Edge%20TTS%20%28Cloud%29%22%5D%2C%20%22datasets%22%3A%20%5B%7B%22label%22%3A%20%22Latency%20%28ms%29%22%2C%20%22data%22%3A%20%5B460%2C%201000%2C%202300%5D%2C%20%22backgroundColor%22%3A%20%5B%22rgba%2874%2C%20144%2C%20226%2C%200.8%29%22%2C%20%22rgba%2875%2C%20192%2C%2075%2C%200.8%29%22%2C%20%22rgba%28255%2C%20159%2C%2064%2C%200.8%29%22%5D%2C%20%22borderColor%22%3A%20%5B%22rgb%2874%2C%20144%2C%20226%29%22%2C%20%22rgb%2875%2C%20192%2C%2075%29%22%2C%20%22rgb%28255%2C%20159%2C%2064%29%22%5D%2C%20%22borderWidth%22%3A%202%7D%5D%7D%2C%20%22options%22%3A%20%7B%22title%22%3A%20%7B%22display%22%3A%20true%2C%20%22text%22%3A%20%22TTS%20Engine%20Latency%20Comparison%22%7D%2C%20%22scales%22%3A%20%7B%22yAxes%22%3A%20%5B%7B%22ticks%22%3A%20%7B%22beginAtZero%22%3A%20true%7D%2C%20%22title%22%3A%20%7B%22display%22%3A%20true%2C%20%22text%22%3A%20%22Latency%20%28ms%29%22%7D%7D%5D%7D%2C%20%22plugins%22%3A%20%7B%22datalabels%22%3A%20%7B%22display%22%3A%20true%2C%20%22align%22%3A%20%22top%22%2C%20%22anchor%22%3A%20%22end%22%2C%20%22font%22%3A%20%7B%22size%22%3A%2012%2C%20%22weight%22%3A%20%22bold%22%7D%7D%7D%7D%7D)

### Service Registry

| Service | Container | Image | Ports | GPU | Notes |
|---------|-----------|-------|-------|-----|-------|
| `voice-server` | `openclaw-voice-server` | Build `./server` | 3200, 3443 (host network) | No | Node.js + Python speaker ID on :3201 |
| `whisper-fast` | `whisper-fast` | `ghcr.io/speaches-ai/speaches:latest-cuda` | 9000→9000 | Yes (optional) | Custom minimal Python server wrapping faster-whisper. Replaces Speaches' default FastAPI; no Gradio overhead. GPU ~239ms, CPU ~2-3s per utterance. Model: `faster-whisper-large-v3-turbo` |
| `kokoro-tts` | `kokoro-fastapi` | `ghcr.io/remsky/kokoro-fastapi:latest-gpu` | 5004→8880 | Yes (optional) | ~330ms latency, OpenAI-compatible `/v1/audio/speech` API |
| `meet-bot` | `meet-bot` | Build `./meet-bot` | 3300 (host network) | No | Profile: `meet`. Puppeteer + PulseAudio + Live2D |
| `diarizer` | Build `./diarizer` | — | 3202 | Yes | Profile: `diarizer`. Pyannote-based speaker diarization |

### whisper-fast Server

Custom minimal Python HTTP server (`whisper-server/server.py`) that replaces the default Speaches FastAPI app. Mounted as a volume into the Speaches container image (which provides the faster-whisper runtime and CUDA libs). Features:

- OpenAI-compatible `/v1/audio/transcriptions` endpoint (verbose_json with segments)
- Language restriction to ES/EN only (auto-detect within those two)
- No FastAPI/Gradio/Swagger overhead — plain `http.server` for minimal latency
- Model: `Systran/faster-whisper-large-v3-turbo` cached locally, `HF_HUB_OFFLINE=1`

## Device Capabilities

The Android app reports device capabilities on connect. The voice server bridges these to the OpenClaw Gateway as tool calls:

- **System info** — battery, connectivity, storage
- **GPS location** — current coordinates
- **Camera** — take photos from front/back camera
- **Bluetooth car mic** — detect BT audio source for car mode

## Emoji Bubble Reactions

The LLM output includes `[[emotion:X]]` tags that control the Live2D avatar's facial expressions. Nine emotions supported: `happy`, `sad`, `surprised`, `thinking`, `confused`, `laughing`, `neutral`, `angry`, `love`.

Extraction pipeline:
1. LLM streams tokens → server detects `[[emotion:X]]` tags
2. Tags are extracted and sent as separate `emotion` field in `reply_chunk` / `audio_chunk`
3. Fallback: keyword-based emotion detection from Spanish text if LLM doesn't tag
4. Client animates Live2D model parameters based on emotion

## Car Mode / Noise Detection

Auto noise detection tracks ambient RMS over a 30-second rolling window (last 30 RMS values) with hysteresis:

- **Quiet → Noisy**: avg RMS > 500 (e.g., car engine, road noise) → sets `noiseTracker.isNoisy = true`
- **Noisy → Quiet**: avg RMS < 300 for 15+ consecutive readings → sets `noiseTracker.isNoisy = false`
- **Noisy profile effects**:
  - Require 4+ words in ambient transcripts (vs 3 in quiet)
  - Stricter Whisper confidence threshold: `avg_logprob < -0.5` (vs `-0.6`)
  - Smart Listen only responds to explicit bot name mentions (no opinion_request, wake_phrase, or question triggers)
  - Language filtering: only ES/EN accepted (rejects phantom detections)
- Profile switches are logged for debugging

## Gateway WebSocket Integration

The voice server connects to the OpenClaw Gateway via native WebSocket protocol v3:

1. Server connects to `GATEWAY_WS_URL`, receives `connect.challenge`
2. Sends `connect` with operator role and auth token
3. On `hello-ok`, sends `chat.send` RPCs with user messages
4. Streams `agent` events (lifecycle start → assistant deltas → lifecycle end)
5. Supports image attachments via base64 (auto-resized to fit 512KB WS frames)
6. Falls back to HTTP SSE `/v1/chat/completions` if WS is disabled

## Component Details

### Google Meet Bot (Node.js + Puppeteer)

Joins Google Meet calls as a participant with an animated Live2D avatar. Features Live2D camera injection, speaker detection, transcript batching, and meeting memory export.

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

### Connection Flow Diagram

![Connection Flow](docs/images/connection.png)

**Connection Sequence:**

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

**Data Processing Pipeline:**

![Data Flow Diagram](docs/images/dataflow.png)

**Smart Listen Audio Processing:**

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

### State Machine Diagram

![State Machine](docs/images/states.png)

**State Transitions:**

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
