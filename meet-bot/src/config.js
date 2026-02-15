const config = {
  whisperUrl: process.env.WHISPER_URL || 'http://127.0.0.1:9000/asr',
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
  chromePath: process.env.CHROME_PATH || '/usr/bin/chromium',
  meetingsDir: process.env.MEETINGS_DIR || '/data/meetings',
  // VAD
  vadThreshold: parseFloat(process.env.VAD_THRESHOLD || '0.01'),
  vadChunkMs: parseInt(process.env.VAD_CHUNK_MS || '2500', 10),
  // Hallucination filter
  hallucinationPatterns: [
    /^\.+$/,
    /^\s*$/,
    /^(Subtítulos|Subtitles|Thank you|Gracias|Music|Música|\[.*\]|♪)/i,
    /^(you|you\.|the|the\.|I|I\.)$/i,
  ],
};

module.exports = config;
