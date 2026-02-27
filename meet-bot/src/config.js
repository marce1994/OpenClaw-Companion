const config = {
  whisperUrl: process.env.WHISPER_URL || 'http://127.0.0.1:9000',
  whisperLang: process.env.WHISPER_LANG || 'es',
  gatewayWsUrl: process.env.GATEWAY_WS_URL || 'ws://127.0.0.1:18789',
  gatewayToken: process.env.GATEWAY_TOKEN || '',
  ttsEngine: process.env.TTS_ENGINE || 'kokoro',
  kokoroUrl: process.env.KOKORO_URL || 'http://127.0.0.1:5004',
  kokoroVoice: process.env.KOKORO_VOICE || 'em_alex',
  ttsVoice: process.env.TTS_VOICE || 'es-AR-TomasNeural',
  botName: process.env.BOT_NAME || 'Jarvis',
  meetPort: parseInt(process.env.MEET_PORT || '3300', 10),
  googleCookie: process.env.GOOGLE_COOKIE || '',
  gwSessionKey: process.env.GW_SESSION_KEY || 'meet',
  kokoroVoiceEn: process.env.KOKORO_VOICE_EN || 'bm_george',
  defaultLang: process.env.DEFAULT_LANG || 'es', // 'en' or 'es'
  chromePath: process.env.CHROME_PATH || '/usr/bin/chromium',
  meetingsDir: process.env.MEETINGS_DIR || '/data/meetings',
  live2dModel: process.env.LIVE2D_MODEL || 'wanko',
  live2dEnabled: process.env.LIVE2D_ENABLED !== 'false', // enabled by default
  // Calendar auto-join
  calendarIcsUrl: process.env.GOOGLE_CALENDAR_ICS || '',
  calendarRefreshHours: parseInt(process.env.CALENDAR_REFRESH_HOURS || '6', 10),
  calendarJoinBeforeSec: parseInt(process.env.CALENDAR_JOIN_BEFORE_SEC || '60', 10),
  // Audio recording (always on for post-meeting summary)
  recordAudio: process.env.RECORD_AUDIO !== 'false', // ON by default
  // Auto-leave after N minutes without transcriptions
  silenceAutoLeaveMins: parseInt(process.env.SILENCE_AUTO_LEAVE_MINS || '5', 10),
  // VAD
  vadThreshold: parseFloat(process.env.VAD_THRESHOLD || '0.01'),
  vadChunkMs: parseInt(process.env.VAD_CHUNK_MS || '1500', 10),
  // Hallucination filter
  hallucinationPatterns: [
    /^\.+$/,
    /^\s*$/,
    /^(Subtítulos|Subtitles|Thank you|Gracias|Music|Música|\[.*\]|♪)/i,
    /^(you|you\.|the|the\.|I|I\.)$/i,
  ],
};

module.exports = config;
