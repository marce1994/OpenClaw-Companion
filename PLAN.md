# PLAN.md — OpenClaw Companion Roadmap
*Updated: 2026-02-22*

## Sprint 5 — Multi-Meeting Architecture (CURRENT)

### 5.1 Whisper Concurrency (no scaling needed)
- **Goal:** Handle 3+ concurrent STT requests without Docker scaling
- **Solution:** CTranslate2 natively supports `num_workers=N` — multiple CUDA streams sharing model weights
- **Change:** One line in whisper-fast: `model = WhisperModel(..., num_workers=3)`
- **VRAM:** ~5-6GB total (shared weights) vs 13.2GB if 3 containers
- **Zero cold start, zero extra containers**
- **Files:** `whisper-server/server.py`
- **Effort:** 30 min (change + benchmark)

### 5.2 Meet Orchestrator (in Voice Server)
- **Goal:** Voice server manages meet workers on demand via Docker API
- **Scope:** ONLY manages meet worker containers. No GPU service scaling.
- **Endpoints:**
  ```
  POST /meetings/join    {meetUrl, botName?}  → spawn worker → return meetingId
  GET  /meetings                              → list active meetings
  POST /meetings/:id/leave                    → graceful leave + summary
  DELETE /meetings/:id                        → force kill worker
  ```
- **Implementation:**
  - New `orchestrator.js` module in voice server
  - Uses Docker API (`/var/run/docker.sock`) to run/stop containers
  - Tracks active meetings in memory (Map of meetingId → container info)
  - Max concurrent meetings: configurable (default 3, ~1GB RAM each)
  - Health check: ping workers every 30s, restart if dead
- **Files:** `server/index.js`, `server/orchestrator.js` (new)
- **Effort:** 4 hours

### 5.3 Meet Worker Isolation
- **Goal:** Each meeting = isolated container with unique session
- **Per worker container:**
  - Name: `meet-worker-{shortId}`
  - Image: `meet-bot:v6` (same image for all)
  - Gateway session: `meet-{shortId}` (unique per meeting)
  - Own PulseAudio + Chromium + Xvfb (isolated audio)
  - Connects to shared Whisper (:9000) and Kokoro (:5004)
  - `--network host` (access localhost services)
- **Lifecycle:**
  1. Orchestrator runs container with env vars
  2. Worker joins meeting, transcribes, responds
  3. Meeting ends → auto-summary to Telegram → worker signals orchestrator
  4. Orchestrator removes container
- **Files:** `meet-bot/` (minor: accept MEET_URL env var for auto-join on start)
- **Effort:** 2 hours

### 5.4 Calendar Auto-Join via Orchestrator
- **Goal:** Move calendar logic from meet-bot to orchestrator
- **Flow:**
  1. Orchestrator fetches ICS feed on startup + every 5 min
  2. Schedules timers for upcoming meetings
  3. Timer fires → spawns worker with meet URL
  4. Worker joins, does its thing, dies
- **Config:** `GOOGLE_CALENDAR_ICS` env var on voice server
- **Files:** `server/orchestrator.js`
- **Effort:** 2 hours

### 5.5 Telegram Control
- **Goal:** Pablo controls meetings from Telegram via natural language
- **Examples:**
  - "Unite a esta meeting: meet.google.com/abc" → orchestrator joins
  - "Cuántas meetings hay?" → list active
  - "Salí de la meeting abc" → leave + summary
- **Implementation:** AI parses intent → calls orchestrator API internally
- **Files:** `server/orchestrator.js` (HTTP endpoints already cover this)
- **Effort:** 1 hour

### 5.6 Summary Delivery
- **Goal:** All summaries go to Pablo's Telegram with meeting context
- **Already implemented** in meet-bot (auto-summary on leave)
- **Change:** Include meeting URL/name in summary header to distinguish multiple meetings
- **Effort:** 30 min

### Sprint 5 Total Effort: ~10 hours

---

## Completed Sprints

<details>
<summary>Sprint 1-4 ✅ (completed 2026-02-20)</summary>

#### Sprint 1 — Critical Fixes ✅
- [x] Meet Bot: Unmute on Join
- [x] Meet Bot: AI Context Truncation (20 entries + rolling summary)
- [x] Meet Bot: Speaker ID Blue Border
- [x] Voice App: Car Mode Fixes (6 patches)

#### Sprint 2 — Polish & Performance ✅
- [x] Meet Bot: FPS Optimization (480x270 + frame rate unlimit)
- [x] Meet Bot: Emoji Bubbles
- [x] Android: Emoji Bubbles
- [x] Meet Bot: Clean Image v5

#### Sprint 3 — Infrastructure ✅
- [ ] Re-enable Heartbeat (blocked on OpenRouter credits)
- [x] Docs Update (ARCHITECTURE.md + README.md)
- [x] CI Test Stabilization

#### Sprint 4 — Features ✅
- [x] Auto Noise Detection (30s rolling window, hysteresis)
- [x] Meet Bot: Audio Recording for Debug
- [x] Meet Bot: Auto-Summary on Leave

</details>

---

## Backlog (no timeline)

- [ ] **OpenClaw Companion as Product** — 1-click self-hosted deploy, onboarding wizard, cloud API fallbacks, integrations (Trello/Notion/Slack)
- [ ] Windows desktop app (KMP + Compose Desktop, floating avatar)
- [ ] Raspberry Pi offline voice assistant
- [ ] XTTS voice cloning with Pablo's voice
- [ ] iOS app
- [ ] Google Calendar API (create meetings, not just join)
- [ ] udev rule for eGPU auto enable/disable
- [ ] Meet bot: screen share analysis (OCR/vision)
- [ ] Voice app: usage stats screen (tokens, costs)
- [ ] Voice app: conversation export/share
- [ ] Re-enable heartbeat (blocked on OpenRouter credits)
- [ ] Demo video for community engagement

## Workflow
1. Edit code in repo (`projects/voice-assistant/`)
2. Git commit + push to `main`
3. GitHub Actions auto-builds APK + web
4. Docker rebuild when stable
