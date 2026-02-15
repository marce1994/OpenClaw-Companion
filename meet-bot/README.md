# Meet Bot — Google Meet AI Assistant

A bot that joins Google Meet calls, transcribes the conversation in real-time, and responds when addressed by name. Reuses the existing voice-assistant stack (Whisper STT, Kokoro TTS, OpenClaw Gateway).

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Meet Bot Container (network_mode: host)        │
│                                                 │
│  Chromium (Puppeteer) ──► Google Meet           │
│       │          ▲                              │
│       │ audio    │ audio                        │
│       ▼          │                              │
│  PulseAudio                                     │
│  ├─ meet_capture ─► parec ─► Transcriber        │
│  │                              │               │
│  │                    Whisper (127.0.0.1:9000)   │
│  │                              │               │
│  │                    AI Responder               │
│  │                    ├─ Gateway WS (18789)      │
│  │                    └─ TTS (Kokoro/Edge)       │
│  │                              │               │
│  └─ tts_output ◄── audio inject ┘               │
│     (virtual mic)                               │
└─────────────────────────────────────────────────┘
```

## Prerequisites

- Docker
- Running voice-assistant stack (Whisper, Kokoro TTS, OpenClaw Gateway)
- Google account cookies for Meet authentication

## Quick Start

```bash
# Build
docker build -t meet-bot .

# Run (uses host network to access voice services)
docker run -d --name meet-bot \
  --network host \
  -e GATEWAY_TOKEN=your-token \
  -e GOOGLE_COOKIE='[{"name":"__Secure-1PSID","value":"...","domain":".google.com"}]' \
  -v /data/meetings:/data/meetings \
  meet-bot

# Join a meeting
curl -X POST http://localhost:3300/join \
  -H 'Content-Type: application/json' \
  -d '{"meetLink": "https://meet.google.com/abc-defg-hij", "botName": "Jarvis"}'

# Check status
curl http://localhost:3300/status

# Get transcript
curl http://localhost:3300/transcript

# Leave meeting
curl -X POST http://localhost:3300/leave
```

## Getting Google Cookies

The bot needs Google account cookies to join Meet calls (not as a guest).

### Method 1: Browser Extension
1. Install "EditThisCookie" or "Cookie-Editor" extension
2. Go to `https://meet.google.com` and sign in
3. Export all cookies as JSON
4. Set `GOOGLE_COOKIE` env var with the JSON

### Method 2: Manual (Chrome DevTools)
1. Open Meet in Chrome, sign in
2. DevTools → Application → Cookies → `https://meet.google.com`
3. Export key cookies: `__Secure-1PSID`, `__Secure-3PSID`, `SID`, `HSID`, `SSID`, `APISID`, `SAPISID`
4. Format as JSON array:
```json
[
  {"name": "__Secure-1PSID", "value": "...", "domain": ".google.com"},
  {"name": "SID", "value": "...", "domain": ".google.com"}
]
```

**Note:** Cookies expire. You'll need to re-export periodically.

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `WHISPER_URL` | `http://127.0.0.1:9000/asr` | Whisper STT endpoint |
| `WHISPER_LANG` | `es` | Whisper language code |
| `GATEWAY_WS_URL` | `ws://127.0.0.1:18789` | OpenClaw Gateway WebSocket |
| `GATEWAY_TOKEN` | | Gateway auth token |
| `TTS_ENGINE` | `kokoro` | TTS engine: `kokoro` or `edge` |
| `KOKORO_URL` | `http://127.0.0.1:5004` | Kokoro TTS endpoint |
| `KOKORO_VOICE` | `em_alex` | Kokoro voice name |
| `TTS_VOICE` | `es-AR-TomasNeural` | Edge TTS voice (fallback) |
| `BOT_NAME` | `Jarvis` | Bot name / trigger keyword |
| `MEET_PORT` | `3300` | HTTP API port |
| `GOOGLE_COOKIE` | | Google cookies JSON |
| `GW_SESSION_KEY` | `meet` | Gateway session prefix |
| `MEETINGS_DIR` | `/data/meetings` | Transcript save directory |
| `VAD_THRESHOLD` | `0.01` | Voice activity detection RMS threshold |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/join` | Join a meeting. Body: `{ meetLink, botName? }` |
| `POST` | `/leave` | Leave current meeting |
| `GET` | `/status` | Current bot state |
| `GET` | `/transcript` | Current meeting transcript |
| `GET` | `/health` | Health check |

## In-Meeting Commands

Say these during a meeting:
- **"Jarvis"** (or configured bot name) — triggers AI response to recent context
- **"resumen"** / **"summary"** — generates a verbal summary of the meeting so far

## Meeting Transcripts

Transcripts are saved as markdown files at `/data/meetings/YYYY-MM-DDTHH-MM-topic.md` when a meeting ends.

## Phase 2 Roadmap

- [ ] Live2D avatar as virtual camera feed (v4l2loopback)
- [ ] Speaker diarization
- [ ] Automatic meeting summary sent to Telegram
- [ ] Google Calendar integration (auto-join scheduled meetings)
- [ ] Chat message reading/sending within Meet
