# OpenClaw Companion — Development Plan

> Last updated: 2026-02-09

---

## Identity

- **App name**: OpenClaw Companion
- **Package**: `com.openclaw.companion`
- **Bot name**: Configurable by user (default: "Assistant")

---

## MVP Features

### 1. Interaction Modes
- [x] **Push-to-talk** (hold button) — default mode, works on screen and headphones
- [ ] **Tap-to-talk + VAD** — tap to start, auto-detect end of speech (Silero VAD)
- [ ] **Continuous conversation** — call-style loop after each response
- [ ] **Configurable switch** between modes in settings
- [x] **Headphones**: physical button support (hold to record)
- [x] **Text mode** — keyboard input for noisy environments

### 2. Audio
- [x] **Streaming TTS** — response starts playing before full text is generated
- [ ] **Interruptions** — stop audio if user starts speaking
- [ ] **Sound feedback** — short tones on record start/stop
- [x] **Vibration** — haptic feedback on activation
- [ ] **Latency target** — <1s from end of speech to start of response

### 3. UI / Visual Design
- [x] **Dark theme** — dark background, clean layout
- [x] **Selectable animated avatars**:
  - 🐾 Cute mascot (blinks, reacts)
  - 👁️ Intelligent eye (Jarvis-style, futuristic)
  - 🔮 Pulsing orb (ChatGPT/Grok-style, minimalist)
- [x] **Animated states** per avatar:
  - Idle — gentle breathing / blinking
  - Listening — reacts to voice amplitude
  - Thinking — processing animation
  - Speaking — synced with audio response
  - Error — distinct visual indicator
- [x] **Lottie animations** — vector-based, lightweight, smooth
- [x] **Portrait lock** — fixed vertical orientation
- [x] **Minimal controls** visible: mic, keyboard, close
- [x] **Smooth transitions** between states

### 4. Session & Context
- [x] **Unified session with Telegram** — shares conversation context
- [ ] **Multi-turn context** — full history in session
- [ ] **Conversation history** — searchable past conversations screen
- [ ] **Real-time transcription** — optional toggle

### 5. Android Integration
- [ ] **Assist app** — register with `VoiceInteractionService`, long-press Home opens app
- [ ] **1x1 Widget** — mic button for quick activation
- [x] **Persistent notification** — quick access from notification bar
- [x] **Battery exclusion** — works with screen locked
- [x] **Wake lock** — keeps service active in background

### 6. Settings
- [x] Server URL
- [x] Auth token
- [ ] **Bot name** (customizable, used throughout UI)
- [x] **Avatar selector** (mascot / eye / orb)
- [ ] **Interaction mode** (push-to-talk / tap+VAD / continuous)
- [x] Auto-play responses
- [x] Vibration on/off
- [ ] Show real-time transcription on/off

---

## Technical Architecture

### Audio Pipeline
```
[Mic] → VAD (Silero, on-device) → PCM/WAV → WebSocket → Server
Server: Whisper STT → OpenClaw LLM (SSE) → Edge-TTS → WebSocket
WebSocket → [Speaker] + transcription in UI
```

### Stack
- **Android**: Kotlin, Lottie for animations, OkHttp WebSocket
- **Server**: Node.js, WebSocket bidirectional
- **STT**: Whisper ASR (container)
- **LLM**: OpenClaw gateway (chat/completions with SSE streaming)
- **TTS**: Edge-TTS (server-side, Microsoft neural voices)
- **VAD**: Silero VAD (Android on-device) — planned

---

## Implementation Phases

### Phase 1 — Foundation (v0.2) ✅ COMPLETE
1. Rename app to OpenClaw Companion
2. Fixed vertical orientation
3. Bot name field in settings
4. Push-to-talk with headphones (hold to record)
5. Improved sound feedback
6. Basic UI redesign (dark background, clean layout)

### Phase 2 — Avatars & Animations (v0.3) ✅ COMPLETE
1. Integrate Lottie
2. Implement pulsing orb (first avatar)
3. Animated states (idle/listening/thinking/speaking)
4. Avatar selector in settings (orb, then more)

### Phase 3 — VAD & Modes (v0.4) — PLANNED
1. Integrate Silero VAD on Android
2. Tap-to-talk mode with end-of-speech detection
3. Mode switch in settings
4. Continuous conversation mode

### Phase 4 — Streaming & Interruptions (v0.5) ✅ COMPLETE
1. SSE streaming from OpenClaw gateway
2. Sentence-by-sentence TTS generation
3. Parallel TTS + streaming to client
4. Reduced latency (2-4s improvement)

### Phase 5 — Android Integration (v0.6) — PLANNED
1. Register as Assist app
2. 1x1 Widget
3. Conversation history

### Phase 6 — Additional Avatars (v0.7) ✅ COMPLETE
1. Cute mascot avatar
2. Intelligent eye avatar
3. Custom sound design

### Phase 7 — Polish (v0.8) — PLANNED
- [ ] Headphones: toggle mode (one click to record, another to send)
- [ ] Polish skin colors
- [ ] Cute avatar: more expression when thinking
- [ ] Cute avatar: more expressive mouth when speaking (synced with audio)
- [ ] Swipe to cancel: adjust sensitivity

### Phase 8 — Live2D VTuber (v0.9) — PLANNED
- [ ] Integrate Live2D Cubism SDK (free for open source/individuals)
- [ ] Default model included in app
- [ ] Import custom `.moc3` models
- [ ] MotionSync — mouth sync with audio
- [ ] Model states: idle (blinking), listening (attentive), thinking, speaking
- [ ] Model selector in settings

---

## Nice-to-have (post-MVP)
- Wake word ("Hey [name]") with Picovoice
- Whisper mode (speak softly → respond softly)
- Brief mode (short responses)
- Quick Settings Tile
- Floating bubble (overlay)
- Share sheet integration
- Multimodal (send photos)
- Additional skins/themes
- Export conversations

---

## Notes
- Unified Telegram session works via `x-openclaw-session-key` header
- Server runs in Docker
- APK builds via Docker (no Android Studio required)
- SSE streaming + sentence chunking + parallel TTS is implemented and working

## Performance Benchmarks (2026-02-09)
- Whisper transcription: ~400ms
- LLM response (via OpenClaw): ~1-3s
- Edge-TTS generation: ~2s for typical response
- With streaming: first audio chunk arrives 2-4s sooner than non-streaming
