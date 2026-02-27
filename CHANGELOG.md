# Changelog

## [Unreleased] — 2026-02-27

### Added
- **Summary Worker** (`summary-worker/`): Ephemeral post-meeting container that checks relevance, diarizes audio via WhisperX, generates structured summaries with Gemini Flash, sends to Telegram, and ingests into Cognee knowledge graph.
- **WhisperX API** (`whisperx/`): Ephemeral GPU container for diarized transcription using WhisperX + pyannote speaker diarization. REST API with `/transcribe` endpoint.
- **Orchestrator mode for meet-bot**: Auto-join from `MEETING_URL` env var on startup; `process.exit(0)` after leaving so container exit triggers summary worker.
- **Summary config template**: `server/summary-config.example.json` for API keys (OpenRouter, Telegram, HuggingFace, Cognee).
- **Meeting data volume mount**: `/tmp/meetings:/tmp/meetings` in docker-compose for meeting data persistence.

### Fixed
- **`getActiveSpeakers` crash** in meet-bot: Wrapped in try/catch with optional chaining. This was causing ALL transcripts to fail before reaching the AI.
- **Meet joiner "getting ready" detection**: Avoids clicking dialogs during admission wait state. Added debug logging for visible buttons.
- **Orchestrator `MEETINGS_HOST_DIR` default**: Changed from `/home/node/.openclaw/workspace/meetings` (container path) to `/tmp/meetings` (host path), fixing meeting data being lost.

### Security
- Added `server/summary-config.json` to `.gitignore` to prevent committing API keys and tokens.
