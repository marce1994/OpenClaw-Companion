# Google Meet Bot

An AI participant that joins Google Meet calls with an animated Live2D avatar, listens to conversations, and responds when mentioned.

## Features

- **Join as guest** — no Google account required (host must admit)
- **Live2D avatar** — animated character rendered as camera feed (Mao, Hiyori, Rice)
- **Bilingual** — auto-detects language (EN/ES) via Whisper and responds accordingly
- **Wake word** — responds when mentioned by name (default: "Jarvis")
- **Meeting summary** — request a summary anytime ("Jarvis, resumen")
- **Transcript export** — saves full transcript as markdown
- **Calendar auto-join** — fetches Google Calendar ICS feed and joins meetings automatically
- **Lip sync** — avatar mouth animates during speech

## Quick Start

### Prerequisites
- Docker
- OpenClaw Gateway running
- Whisper ASR container running
- Kokoro TTS container running (optional, Edge TTS as fallback)

### Build & Run

```bash
docker build -t meet-bot .

docker run -d --name meet-bot --network host \
  -e GATEWAY_WS_URL=ws://127.0.0.1:18789 \
  -e GATEWAY_TOKEN=your-gateway-token \
  -e BOT_NAME=Jarvis \
  meet-bot
```

### Join a Meeting

```bash
# Join
curl -X POST http://localhost:3300/join \
  -H 'Content-Type: application/json' \
  -d '{"meetLink":"https://meet.google.com/abc-defg-hij"}'

# Check status
curl http://localhost:3300/status

# Get transcript
curl http://localhost:3300/transcript

# Leave
curl -X POST http://localhost:3300/leave
```

## Configuration

All configuration via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `GATEWAY_WS_URL` | `ws://127.0.0.1:18789` | OpenClaw Gateway WebSocket URL |
| `GATEWAY_TOKEN` | (required) | Gateway authentication token |
| `WHISPER_URL` | `http://127.0.0.1:9000/asr` | Whisper ASR endpoint |
| `BOT_NAME` | `Jarvis` | Display name in Meet + wake word |
| `TTS_ENGINE` | `kokoro` | TTS engine: `kokoro` or `edge` |
| `KOKORO_URL` | `http://127.0.0.1:5004` | Kokoro TTS endpoint |
| `KOKORO_VOICE` | `em_alex` | Spanish TTS voice |
| `KOKORO_VOICE_EN` | `af_heart` | English TTS voice |
| `TTS_VOICE` | `es-AR-TomasNeural` | Edge TTS fallback voice |
| `DEFAULT_LANG` | `es` | Default language (`en` or `es`) |
| `LIVE2D_MODEL` | `Mao` | Avatar model: `Mao`, `Hiyori`, `Rice` |
| `LIVE2D_ENABLED` | `true` | Show Live2D avatar as camera |
| `GOOGLE_CALENDAR_ICS` | (empty) | Private ICS URL for calendar auto-join |
| `CALENDAR_REFRESH_HOURS` | `6` | How often to refresh calendar |
| `CALENDAR_JOIN_BEFORE_SEC` | `60` | Join N seconds before event starts |
| `GW_SESSION_KEY` | `meet` | Gateway session key prefix |
| `MEET_PORT` | `3300` | HTTP API port |

## Calendar Auto-Join

To have the bot automatically join your scheduled meetings:

1. Go to **Google Calendar** → **Settings** → your calendar
2. Scroll to **"Secret address in iCal format"**
3. Copy the URL
4. Add it as an environment variable:

```bash
-e GOOGLE_CALENDAR_ICS="https://calendar.google.com/calendar/ical/your-email/private-key/basic.ics"
```

The bot will:
- Fetch the ICS once on startup and every 6 hours
- Schedule timers for each upcoming event with a Google Meet link
- Auto-join 60 seconds before the meeting starts
- Auto-leave when the meeting ends (or when the calendar event ends)

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  Docker Container (meet-bot)                                   │
│                                                                │
│  Xvfb :99 ──► Chromium (Puppeteer)                            │
│                    │                                           │
│                    ├──► Google Meet page                       │
│                    │       • getUserMedia override             │
│                    │       • Live2D canvas → captureStream     │
│                    │       • RTCPeerConnection track replace   │
│                    │                                           │
│  PulseAudio:       │                                           │
│    meet_capture ◄──┘ (Meet audio output → default sink)       │
│    tts_output  ──► virtual_mic (TTS → Chrome's mic input)     │
│                                                                │
│  Node.js:                                                      │
│    HTTP API :3300                                              │
│    ├── meet-joiner.js    (Puppeteer automation)                │
│    ├── audio-pipeline.js (parec/paplay)                        │
│    ├── transcriber.js    (VAD + Whisper)                       │
│    ├── ai-responder.js   (Gateway WS + TTS)                   │
│    ├── live2d-canvas.js  (avatar injection)                    │
│    ├── calendar-sync.js  (ICS → timers)                       │
│    └── meeting-memory.js (transcript)                          │
└────────────────────────────────────────────────────────────────┘
```

## HTTP API

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/join` | Join a meeting. Body: `{"meetLink":"https://meet.google.com/..."}` |
| `POST` | `/leave` | Leave current meeting |
| `GET` | `/status` | Bot state, current meeting, transcript count |
| `GET` | `/transcript` | Full meeting transcript |
| `GET` | `/health` | Health check |

## How It Works

1. **Join**: Puppeteer launches Chromium on Xvfb, navigates to Meet, enters bot name, clicks join, waits for admission.
2. **Audio capture**: PulseAudio routes Meet's audio output to a null sink. `parec` captures from its monitor source.
3. **Transcription**: Audio chunks are sent to Whisper ASR. Language is auto-detected per segment.
4. **Trigger detection**: When the bot's name is mentioned in a transcript, the AI responder activates.
5. **AI response**: Recent transcript context is sent to OpenClaw Gateway via WebSocket. Response streams back.
6. **TTS**: Response text is converted to speech using Kokoro (or Edge fallback) in the detected language.
7. **Audio injection**: TTS audio is played into the `tts_output` sink via `paplay`. The `virtual_mic` (remap of `tts_output.monitor`) feeds Chrome as its microphone input.
8. **Live2D**: After joining, PixiJS + pixi-live2d-display is injected into the Meet page. The Live2D canvas stream replaces the WebRTC video track, showing the animated avatar to other participants.

## License

[MIT](../LICENSE)
