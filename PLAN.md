# OpenClaw Companion — Development Plan

> Last updated: 2026-02-15

---

## Identity

- **App name**: OpenClaw Companion
- **Package**: `com.openclaw.companion`
- **Repo**: https://github.com/marce1994/OpenClaw-Companion
- **Bot name**: Configurable by user (default: "Assistant")

---

## Platforms

| Platform | Status | Stack |
|----------|--------|-------|
| **Android** | ✅ Production | Kotlin, Live2D, OkHttp WebSocket |
| **Web** | ✅ Production | React + TypeScript + Vite, PixiJS Live2D |
| **Google Meet Bot** | 🚧 Phase 1 | Node.js, Puppeteer, PulseAudio, Live2D |
| **Windows Desktop** | 📋 Planned | KMP + Compose Desktop, floating avatar |
| **iOS** | 📋 Planned | KMP / Swift |

---

## Completed Features

### Core
- [x] Push-to-talk voice (hold button)
- [x] Streaming sentence-by-sentence TTS
- [x] 9 animated emotions (happy, sad, surprised, thinking, confused, laughing, neutral, angry, love)
- [x] 7 Live2D avatars with dual mode (orb / Live2D immersive)
- [x] Barge-in (interrupt AI mid-response)
- [x] Conversation memory (10-exchange sliding window)
- [x] Text chat with full markdown rendering
- [x] Code blocks extracted as viewable artifacts
- [x] Inline interactive buttons from AI
- [x] File & image attachments for analysis
- [x] Headphone media button & lock screen support (Android)
- [x] Works over Tailscale / LAN / WAN

### Smart Listen (v2)
- [x] Ambient always-on listening with wake word detection
- [x] Speaker identification (auto-enroll, recognize, owner priority)
- [x] AMBIENT state with breathing orb animation
- [x] Floating subtitle overlay (5s auto-hide, not chat bubbles)
- [x] Segment accumulation (2s buffer before sending)
- [x] Audio source auto-fallback (VOICE_COMMUNICATION → MIC)
- [x] RMS debug indicator
- [x] Auto-fade for unresponded smart listen messages
- [x] Echo cancellation (3-layer: Android AEC + Whisper filtering + TTS pause)

### TTS
- [x] Kokoro TTS — local GPU, ~460ms, bilingual EN/ES
- [x] Edge TTS — cloud fallback, ~2300ms
- [x] XTTS v2 — local GPU, voice cloning capable
- [x] Runtime engine switching (from app settings or WS command)
- [x] Automatic fallback chain (Kokoro → Edge)

### Web Search
- [x] Auto-detect search intent in ES/EN
- [x] DuckDuckGo integration (no API key needed)

### Infrastructure
- [x] Docker Compose setup with interactive wizard (`setup.sh`)
- [x] GitHub Actions CI/CD (auto-version, APK + Web build, Release, GitHub Pages)
- [x] WSS/TLS via Tailscale HTTPS certificates
- [x] Gateway WebSocket native integration (protocol v3)
- [x] Session sync with sequence IDs and reconnect buffer

### Google Meet Bot (Phase 1)
- [x] Join Meet as guest with Puppeteer + Chromium
- [x] Audio capture via PulseAudio virtual devices
- [x] Whisper transcription with auto language detection
- [x] Respond when bot name mentioned
- [x] Bilingual TTS (Kokoro EN + ES, auto-switch)
- [x] Meeting transcript with markdown export
- [x] Calendar auto-join via private ICS feed
- [x] Live2D avatar injection as camera feed (implemented, not yet tested)
- [x] Lip sync animation during TTS
- [x] HTTP API (join/leave/status/transcript)

---

## In Progress

### Google Meet Bot — Testing & Polish
- [ ] End-to-end test with Live2D camera in real Meet
- [ ] Bot-to-bot automated testing
- [ ] Google Calendar API integration (create meetings)
- [ ] Meeting summary generation

### Smart Listen v2 Testing
- [ ] End-to-end test of 6 improvements (commit `b421957`)

---

## Planned

### Phase Next — Windows Desktop
- [ ] KMP + Compose Desktop
- [ ] Floating transparent avatar window (desktop pet)
- [ ] Always-on-top, click-through background
- [ ] System tray integration

### Phase Next — iOS
- [ ] KMP shared module or native Swift
- [ ] Live2D avatar
- [ ] Voice interaction

### Optimization
- [ ] TTS latency target: ~460ms → ~200ms
- [ ] XTTS voice cloning with Pablo's voice
- [ ] Whisper optimization for Meet (multi-speaker)

### Polish
- [ ] Android Assist app (long-press Home)
- [ ] 1x1 home screen widget
- [ ] Conversation history search
- [ ] Usage stats screen (tokens, costs, model info)
- [ ] Wake word via Picovoice (offline)
- [ ] Container reuse for call summaries / enhanced memory

---

## Technical Architecture

### Voice Server
```
Client (Android/Web) ←→ Voice Server (Node.js :3200/:3443) ←→ OpenClaw Gateway (:18789)
                              ↕                                        ↕
                        Whisper ASR (:9000)                       LLM (Claude, etc.)
                        Speaker ID (:3201)
                        TTS (Kokoro :5004 / XTTS :5002 / Edge cloud)
```

### Meet Bot
```
Google Meet (browser) ←→ Puppeteer + Chromium (Xvfb :99)
                              ↕
                        PulseAudio virtual devices
                        parec (capture) → Whisper → AI Responder → TTS → paplay (inject)
                              ↕
                        OpenClaw Gateway (WS protocol v3)
                        Live2D canvas → getUserMedia override → WebRTC video track
                        Calendar Sync (ICS feed → setTimeout timers)
```

---

## Performance Benchmarks

| Component | Latency | Notes |
|-----------|---------|-------|
| Whisper ASR | ~470ms | large-v3-turbo, RTX 3090 |
| Kokoro TTS | ~460ms | GPU, bilingual EN/ES |
| Edge TTS | ~2300ms | Cloud fallback |
| XTTS v2 | ~1000ms first chunk | GPU, streaming, voice cloning |
| LLM (Claude) | ~1-3s | Via OpenClaw Gateway |
| Full pipeline | ~3-5s | Voice → text → AI → audio |
