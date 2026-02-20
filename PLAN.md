# PLAN.md — OpenClaw Companion Roadmap
*Updated: 2026-02-20*

## Sprint 1 — Critical Fixes (next session)

### 1.1 Meet Bot: Unmute on Join
- **Problem:** Bot joins muted, `/unmute` (Ctrl+D) doesn't work when host-muted
- **Fix:** Configure Puppeteer to join with mic already enabled. In `meet-joiner.js`, ensure mic is ON before clicking "Ask to join". If `data-is-muted="true"`, click the mic toggle button BEFORE joining
- **Files:** `meet-bot/src/meet-joiner.js`
- **Effort:** 30 min
- **Test:** Join a test meeting, verify audio plays without manual unmute

### 1.2 Meet Bot: AI Latency — Truncate Context
- **Problem:** 28s AI response when 654 transcripts accumulated. Claude gets overwhelmed
- **Fix:** Cap transcript history sent to AI at last 20 entries (not all). Summarize older context into a 2-line summary that updates every 50 transcripts
- **Files:** `meet-bot/src/ai-responder.js`
- **Effort:** 1 hour
- **Test:** Join meeting, talk for 30+ min, verify response time stays under 8s

### 1.3 Meet Bot: Speaker ID Blue Border
- **Problem:** CSS selectors for Meet's active speaker indicator are stale (Google obfuscates and rotates class names)
- **Fix:** Take a live DOM screenshot during a test meeting (`page.evaluate(() => document.body.innerHTML)`), find current selectors for speaking indicators. Update `_startSpeakerPoll()` in meet-joiner.js. Consider using `aria-label` attributes which are more stable than class names
- **Files:** `meet-bot/src/meet-joiner.js`
- **Effort:** 1.5 hours (need live meeting for DOM inspection)
- **Test:** Join meeting with 2+ people, verify speaker names appear in transcript logs

### 1.4 Voice App: Car Mode Validation
- **Problem:** All car mode fixes deployed but untested in real conditions
- **Fix:** N/A — needs Pablo to test in car
- **Validate:**
  - Whisper no longer hallucinates Russian/Icelandic
  - "Jarvis" wake word triggers response reliably
  - Transcripts appear in chat
  - Smart Listen doesn't stay in Idle
- **Effort:** 0 (testing only)

## Sprint 2 — Polish & Performance

### 2.1 Meet Bot: FPS Optimization
- **Problem:** Live2D renders at ~9fps despite captureStream(30)
- **Root cause:** PixiJS render loop is too heavy for 640x360 canvas + Live2D model in headless Chromium
- **Options:**
  a. Reduce canvas to 480x270 (less pixels to render)
  b. Skip frames (render every 2nd frame, still 15fps visible)
  c. Simplify Live2D model (fewer parameters/textures)
  d. Use `--disable-frame-rate-limit` Chrome flag
- **Files:** `meet-bot/src/live2d-canvas.js`
- **Effort:** 2 hours (investigation + implementation)
- **Target:** 20+ fps

### 2.2 Meet Bot: Emoji Bubbles Testing
- **Problem:** Implemented but never tested in real meeting
- **Fix:** Join a test meeting, trigger emotional responses, verify emoji bubbles appear on video feed
- **Files:** `meet-bot/src/live2d-canvas.js`
- **Effort:** 30 min (testing + tweaks)

### 2.3 Android: Emoji Bubbles Testing
- **Problem:** Implemented but untested on device
- **Fix:** Open app, trigger emotional responses, verify bubbles appear over Live2D
- **Files:** `android/app/src/main/java/com/openclaw/companion/live2d/Live2DView.kt`
- **Effort:** 30 min (testing + tweaks)

### 2.4 Meet Bot: Clean Image Rebuild (v6)
- **Problem:** Accumulated docker cp changes may be lost if container is recreated
- **Fix:** All code is now in repo. Build fresh image from Dockerfile:
  ```bash
  cd meet-bot && docker build -t meet-bot:v6 .
  docker rm -f meet-bot
  docker run -d --name meet-bot --network host \
    -e GATEWAY_WS_URL=ws://127.0.0.1:18789 \
    -e GATEWAY_TOKEN=<token> \
    -e WHISPER_URL=http://127.0.0.1:9000 \
    -e KOKORO_URL=http://127.0.0.1:5004 \
    -e KOKORO_VOICE=em_alex \
    -e KOKORO_VOICE_EN=bm_george \
    -e BOT_NAME=Jarvis \
    -e LIVE2D_MODEL=wanko \
    -e GW_SESSION_KEY=meet \
    -e AUTO_LEAVE_ALONE_MS=300000 \
    -e VAD_CHUNK_MS=1500 \
    meet-bot:v6
  ```
- **Effort:** 30 min
- **Blocked by:** 2.1 and 2.2 (do after FPS + emoji fixes are stable)

## Sprint 3 — Infrastructure

### 3.1 Re-enable Heartbeat
- **Problem:** Heartbeat disabled since OpenRouter credits ran out
- **Fix:** Check OpenRouter balance, if refilled set `heartbeat.every: "60m"` in config
- **Blocked by:** OpenRouter credits
- **Effort:** 5 min

### 3.2 Docs Update
- **Problem:** ARCHITECTURE.md outdated — missing whisper-fast, device capabilities, emoji bubbles, car mode fixes
- **Fix:** Update ARCHITECTURE.md, README.md, and PLAN.md
- **Files:** `docs/ARCHITECTURE.md`, `README.md`
- **Effort:** 1 hour

### 3.3 CI Test Stabilization
- **Problem:** test-setup.yml may still have issues (docker-compose.yml references GPU images)
- **Fix:** Verify CI passes on latest push. If still failing, create a `docker-compose.ci.yml` that only has voice-server (no GPU deps)
- **Effort:** 30 min

## Sprint 4 — New Features

### 4.1 Auto Noise Detection (Car Mode)
- **Problem:** VAD thresholds are static. Car noise needs different thresholds than quiet room
- **Fix:** Track ambient RMS over 30s rolling window. If avg RMS > threshold, switch to "noisy" profile (higher VAD, stricter word filter). Switch back when quiet
- **Files:** `server/index.js` (server-side noise tracker already partially implemented)
- **Effort:** 2 hours

### 4.2 Meet Bot: Audio Recording for Debug
- **Problem:** Can't replay/debug audio issues after meetings
- **Fix:** Save raw audio chunks to `/data/meetings/<id>/audio/` alongside transcript. Configurable via `RECORD_AUDIO=true` env var
- **Files:** `meet-bot/src/audio-pipeline.js`, `meet-bot/src/transcriber.js`
- **Effort:** 2 hours

### 4.3 Meet Bot: Summary Auto-send
- **Problem:** Meeting summaries only available if manually requested
- **Fix:** Auto-generate and send summary to Telegram when meeting ends (auto-leave trigger). Use the 654-entry transcript that's already saved
- **Files:** `meet-bot/src/index.js`, `meet-bot/src/meeting-memory.js`
- **Effort:** 1.5 hours

## Backlog (no timeline)

- [ ] Windows desktop app (KMP + Compose Desktop, floating avatar)
- [ ] Raspberry Pi offline voice assistant
- [ ] XTTS voice cloning with Pablo's voice
- [ ] iOS app
- [ ] Google Calendar API integration (create meetings, not just join)
- [ ] udev rule for eGPU auto enable/disable
- [ ] Meet bot: support multiple simultaneous meetings
- [ ] Meet bot: screen share analysis (OCR/vision)
- [ ] Voice app: usage stats screen (tokens, costs)
- [ ] Voice app: conversation export/share

## Workflow Reminder
1. Edit code in repo (`projects/voice-assistant/`)
2. Git commit + push to `main`
3. GitHub Actions auto-builds APK + web
4. For meet-bot: `docker cp` for quick iteration, then rebuild image when stable
5. For voice server: `docker cp` + restart, or rebuild via docker-compose
