const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { WebSocketServer, WebSocket } = require('ws');
let sharp;
try { sharp = require('sharp'); } catch { sharp = null; }

// ─── Configuration ───────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3200', 10);
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'jarvis-voice-' + crypto.randomBytes(8).toString('hex');
const WHISPER_URL = process.env.WHISPER_URL || 'http://127.0.0.1:9000/asr?language=es&output=json';
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:18789/v1/chat/completions';
const GATEWAY_WS_URL = process.env.GATEWAY_WS_URL || 'ws://127.0.0.1:18789';
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || '';
const USE_GATEWAY_WS = process.env.USE_GATEWAY_WS === 'true'; // Default: off until debugged
const TTS_VOICE = process.env.TTS_VOICE || 'es-AR-TomasNeural';
let TTS_ENGINE = process.env.TTS_ENGINE || 'edge'; // 'edge', 'xtts', or 'kokoro'
const XTTS_URL = process.env.XTTS_URL || 'http://127.0.0.1:5002';
const KOKORO_URL = process.env.KOKORO_URL || 'http://127.0.0.1:5004';
const KOKORO_VOICE = process.env.KOKORO_VOICE || 'em_alex';
const BOT_NAME = (process.env.BOT_NAME || 'jarvis').toLowerCase();
const SPEAKER_URL = process.env.SPEAKER_URL || 'http://127.0.0.1:3201';
const OWNER_NAME = process.env.OWNER_NAME || 'Pablo';

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const TEXT_FILE_EXTENSIONS = new Set(['txt', 'md', 'json', 'csv', 'js', 'py', 'html', 'css', 'xml', 'yaml', 'yml', 'log']);
const MAX_CONTEXT_LINES = 20;
const MAX_CONVERSATION_HISTORY = 10; // Max exchanges (user+assistant pairs) to keep
const MSG_BUFFER_SIZE = 40;
const SESSION_TTL = 5 * 60 * 1000;

console.log(`🎙️ Voice WS server starting on port ${PORT}`);
console.log(`🔑 Token: ${AUTH_TOKEN}`);

// ─── Session Management ─────────────────────────────────────────────────────

/** Global session store: sessionId → session state (survives reconnects) */
const sessions = new Map();

/**
 * Get or create a persistent session by ID.
 * Sessions survive WebSocket disconnects for SESSION_TTL.
 */
function getOrCreateSession(sessionId) {
  if (sessions.has(sessionId)) {
    const s = sessions.get(sessionId);
    if (s._expireTimer) { clearTimeout(s._expireTimer); s._expireTimer = null; }
    return s;
  }
  const s = {
    sendBuffer: [],
    sseq: 0,
    lastClientSeq: 0,
    ambientContext: [],
    botName: null,
    conversationHistory: [],
  };
  sessions.set(sessionId, s);
  return s;
}

function expireSession(sessionId) {
  const s = sessions.get(sessionId);
  if (s) {
    s._expireTimer = setTimeout(() => sessions.delete(sessionId), SESSION_TTL);
  }
}

/** Restore session state onto a WebSocket connection */
function syncWsWithSession(ws, session) {
  ws._sseq = session.sseq;
  ws._sendBuffer = session.sendBuffer;
  ws._ambientContext = session.ambientContext;
  ws._conversationHistory = session.conversationHistory;
  if (session.botName) ws._botName = session.botName;
}

/** Save WebSocket state back to persistent session */
function saveWsToSession(ws, session) {
  session.sseq = ws._sseq || 0;
  session.sendBuffer = ws._sendBuffer || [];
  session.ambientContext = ws._ambientContext || [];
  session.conversationHistory = ws._conversationHistory || [];
  if (ws._botName) session.botName = ws._botName;
}

// ─── WebSocket Helpers ──────────────────────────────────────────────────────

/**
 * Send a JSON message over WebSocket with sequence tracking and buffering.
 * Important messages are buffered for replay on reconnect.
 */
function send(ws, obj) {
  try {
    if (!ws._sseq) ws._sseq = 0;
    if (!ws._sendBuffer) ws._sendBuffer = [];

    ws._sseq++;
    obj.sseq = ws._sseq;

    // Buffer important messages (skip ephemeral ones)
    const ephemeral = ['pong', 'smart_status'].includes(obj.type);
    if (!ephemeral) {
      ws._sendBuffer.push(obj);
      if (ws._sendBuffer.length > MSG_BUFFER_SIZE) {
        ws._sendBuffer = ws._sendBuffer.slice(-MSG_BUFFER_SIZE);
      }
    }

    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  } catch (e) { /* connection may have closed */ }
}

function httpReq(url, opts, body) {
  return new Promise((resolve, reject) => {
    const r = http.request(url, opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

// ─── Speaker Identification ─────────────────────────────────────────────────

// P1-8: Reset speaker profiles to avoid contamination between sessions (meet bot vs voice app)
async function resetSpeakerProfiles() {
  try {
    const resp = await fetch(`${SPEAKER_URL}/reset`, { method: 'POST' });
    if (resp.ok) console.log('🔄 Speaker profiles reset for new voice session');
    else console.warn('⚠️ Speaker profile reset failed:', resp.status);
  } catch (e) {
    console.error('Speaker reset error:', e.message);
  }
}

async function identifySpeaker(wavBuffer) {
  try {
    const resp = await fetch(`${SPEAKER_URL}/identify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: wavBuffer,
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch (e) {
    console.error('Speaker ID error:', e.message);
    return null;
  }
}

async function enrollSpeaker(wavBuffer, name, append = false) {
  try {
    const endpoint = append ? '/enroll_append' : '/enroll';
    const resp = await fetch(`${SPEAKER_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Speaker-Name': name,
      },
      body: wavBuffer,
    });
    if (!resp.ok) return null;
    return await resp.json();
  } catch (e) {
    console.error('Enroll error:', e.message);
    return null;
  }
}

async function getSpeakerProfiles() {
  try {
    const resp = await fetch(`${SPEAKER_URL}/profiles`);
    return await resp.json();
  } catch (e) {
    return { profiles: [], count: 0 };
  }
}

async function renameSpeaker(oldName, newName) {
  try {
    const resp = await fetch(`${SPEAKER_URL}/rename`, {
      method: 'POST',
      headers: { 'X-Old-Name': oldName, 'X-New-Name': newName },
    });
    return await resp.json();
  } catch (e) {
    console.error('Rename error:', e.message);
    return null;
  }
}

/**
 * Detect self-introductions like "me llamo X", "soy X", "my name is X".
 * Returns the detected name or null.
 */
function detectIntroduction(text) {
  const patterns = [
    /(?:me llamo|mi nombre es|soy)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/i,
    /(?:my name is|i'?m|call me)\s+([A-Z][a-z]+)/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[1];
  }
  return null;
}

// ─── Web Search ─────────────────────────────────────────────────────────────

async function webSearch(query, maxResults = 5) {
  try {
    const url = `${SPEAKER_URL}/search?q=${encodeURIComponent(query)}&max=${maxResults}`;
    const resp = await fetch(url);
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.results || [];
  } catch (e) {
    console.error('Search error:', e.message);
    return null;
  }
}

// ─── Transcription (Whisper) ────────────────────────────────────────────────
// Supports both OpenAI-compatible (/v1/audio/transcriptions) and original (/asr) APIs.
// The server auto-detects which one is available on first call.
// Compatible with whisper-large-v3-turbo (same HTTP API, faster model).

let _whisperApi = null; // 'original' or 'openai'

async function transcribe(audio) {
  const boundary = '----Boundary' + crypto.randomBytes(8).toString('hex');

  // Try OpenAI-compatible API first (faster-whisper), then fall back to original
  if (_whisperApi !== 'original') {
    try {
      const baseUrl = WHISPER_URL.replace(/\/asr.*$/, '');
      const url = baseUrl + '/v1/audio/transcriptions';
      const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`);
      const whisperModel = process.env.WHISPER_MODEL || 'Systran/faster-whisper-large-v3-turbo';
      const modelPart = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${whisperModel}`);
      // No language param → auto-detect (restricted to es/en in whisper-fast server)
      const fmtPart = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json`);
      const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
      const body = Buffer.concat([header, audio, modelPart, fmtPart, footer]);
      const res = await httpReq(url, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
      }, body);
      if (res.status === 200) {
        if (_whisperApi !== 'openai') { _whisperApi = 'openai'; console.log('🎤 Using OpenAI-compatible Whisper API'); }
        const parsed = JSON.parse(res.body.toString());
        const text = parsed.text || '';
        const lang = parsed.language || '';
        
        // Filter: only accept Spanish and English
        if (lang && lang !== 'es' && lang !== 'en') {
          console.log(`🚫 Non-es/en language filtered: "${text}" (lang=${lang})`);
          return '';
        }
        
        // Filter by confidence (verbose_json has segments with avg_logprob)
        if (parsed.segments && parsed.segments.length > 0) {
          const seg = parsed.segments[0];
          const logprob = seg.avg_logprob ?? 0;
          const noSpeech = seg.no_speech_prob ?? 0;
          if (logprob < -0.6) {
            console.log(`🚫 Low confidence filtered: "${text}" (logprob=${logprob.toFixed(2)})`);
            return '';
          }
          if (noSpeech > 0.5) {
            console.log(`🚫 No-speech filtered: "${text}" (no_speech=${noSpeech.toFixed(2)})`);
            return '';
          }
        }
        
        return text;
      }
    } catch (e) {
      if (_whisperApi === 'openai') throw e;
    }
  }

  // Original API (/asr) — use output=json for confidence data
  const whisperUrl = WHISPER_URL.includes('output=') ? WHISPER_URL : WHISPER_URL + '&output=json';
  const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio_file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`);
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, audio, footer]);
  const res = await httpReq(whisperUrl, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
  }, body);
  if (_whisperApi !== 'original') { _whisperApi = 'original'; console.log('🎤 Using original Whisper API (/asr)'); }
  const parsed = JSON.parse(res.body.toString());
  
  // Check segment confidence to filter Whisper hallucinations
  if (parsed.segments && parsed.segments.length > 0) {
    const seg = parsed.segments[0];
    const logprob = seg.avg_logprob ?? 0;
    const compression = seg.compression_ratio ?? 1;
    const noSpeech = seg.no_speech_prob ?? 0;
    // Low confidence hallucination: low logprob + very short duration + low compression
    if (logprob < -0.5 && compression < 0.8) {
      console.log(`🚫 Whisper hallucination filtered: "${parsed.text}" (logprob=${logprob.toFixed(2)}, compression=${compression.toFixed(2)}, no_speech=${noSpeech.toFixed(4)})`);
      return '';
    }
    // Also filter if avg_logprob is very low (model very uncertain)
    if (logprob < -0.8) {
      console.log(`🚫 Whisper low confidence filtered: "${parsed.text}" (logprob=${logprob.toFixed(2)})`);
      return '';
    }
  }
  
  return parsed.text || '';
}

/** Filter out Whisper hallucinations and garbage transcriptions */
function isGarbageTranscription(text) {
  const t = text.trim();
  if (t.length < 2) return true;
  
  // Common Whisper hallucinations on background noise/silence
  const hallucinations = /^[\s¡!¿?]*(?:gracias|suscr[íi]bete|thanks|thank you|subscribe|like and subscribe|subtitulos|subt[íi]tulos realizados|amara\.org|www\.|http|música|aplausos|risas|\[.*\]|\(.*\))[\s.!¡¿?]*$/i;
  if (hallucinations.test(t)) return true;
  
  // Very short + common hallucination words
  const shortHallucinations = /^[\s¡!¿?]*(?:sí|no|ok|ay|ah|oh|uh|eh|mm|hmm|gracias|hola|adiós|bye|chau)[\s.!¡¿?]*$/i;
  if (shortHallucinations.test(t) && t.length < 15) return true;
  
  const words = t.split(/\s+/);
  if (words.length < 2) return false;
  const nonsense = /(?:psychiatric|exchange|itísmo|oxpor|lunar bar|virgen hay una casa)/i;
  if (nonsense.test(t)) return true;
  const unique = new Set(words.map(w => w.toLowerCase()));
  if (words.length > 8 && unique.size / words.length < 0.4) return true;
  // Repetitive short phrases (e.g. "Gracias. Gracias. Gracias.")
  if (words.length >= 2 && unique.size <= 2) return true;
  // Mixed languages (Spanish + random English = likely hallucination)
  const englishWords = t.match(/\b(?:the|is|are|was|were|have|has|this|that|with|from|they|their|there|which|would|could|should|about|been|into|than|just|over|also|after|before|between|through)\b/gi);
  const spanishWords = t.match(/\b(?:que|los|las|del|por|una|con|para|como|más|pero|hay|está|son|tiene|puede|este|esta|ese|esa|todo|muy|bien|sin|sobre|entre)\b/gi);
  if (englishWords && spanishWords && englishWords.length > 2 && spanishWords.length > 2) return true;
  return false;
}

// ─── TTS Engine ─────────────────────────────────────────────────────────────

/**
 * Generate TTS audio from text.
 * Supports three engines via TTS_ENGINE env var:
 * - 'edge': Edge TTS (cloud, free, good quality, ~300-800ms)
 * - 'xtts': Coqui XTTS v2 (local GPU, voice cloning, ~1000ms first chunk on RTX 3090)
 * - 'kokoro': Kokoro TTS (local GPU, fastest, ~400ms on RTX 3090, no voice cloning)
 * @returns {Buffer} Audio data (MP3 for edge, WAV for xtts/kokoro)
 */
async function generateTTS(text, { outputFormat = 'wav' } = {}) {
  if (TTS_ENGINE === 'kokoro') return generateTTS_Kokoro(text, outputFormat);
  if (TTS_ENGINE === 'xtts') return generateTTS_XTTS(text);
  return generateTTS_Edge(text);
}

/** Edge TTS — cloud-based, uses edge-tts CLI */
function generateTTS_Edge(text) {
  const ttsFile = `/tmp/tts-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const textFile = `${ttsFile}.txt`;
  fs.writeFileSync(textFile, text);
  try {
    execSync(`edge-tts --voice "${TTS_VOICE}" --file "${textFile}" --write-media "${ttsFile}.mp3" 2>/dev/null`, { timeout: 30000 });
  } finally {
    try { fs.unlinkSync(textFile); } catch (e) { /* ignore */ }
  }
  const data = fs.readFileSync(`${ttsFile}.mp3`);
  try { fs.unlinkSync(`${ttsFile}.mp3`); } catch (e) { /* ignore */ }
  return data;
}

/** XTTS v2 — local GPU, voice cloning via xtts-streaming-server */
function generateTTS_XTTS(text) {
  try {
    const payload = JSON.stringify({
      text,
      language: 'es',
      speaker_wav: '/tmp/reference.wav',
      stream: false,
    });
    const url = new URL('/tts', XTTS_URL);
    const res = execSync(`curl -s --max-time 30 -X POST "${url.href}" -H "Content-Type: application/json" -d '${payload.replace(/'/g, "'\\''")}'`, {
      timeout: 35000,
      maxBuffer: 10 * 1024 * 1024,
    });
    // XTTS returns raw WAV audio
    return res;
  } catch (e) {
    console.error('XTTS TTS error, falling back to Edge:', e.message);
    return generateTTS_Edge(text);
  }
}

/** Kokoro TTS — local GPU, fastest option (~320ms on RTX 3090 with FastAPI) */
/** Supports both Kokoro-FastAPI (OpenAI-compatible /v1/audio/speech) and legacy Flask (/tts) */
let _kokoroApi = null; // 'openai' or 'legacy'
async function generateTTS_Kokoro(text, format = 'mp3') {
  try {
    // Try OpenAI-compatible API first (Kokoro-FastAPI), fall back to legacy Flask
    if (_kokoroApi !== 'legacy') {
      try {
        const resp = await fetch(`${KOKORO_URL}/v1/audio/speech`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'kokoro', input: text, voice: KOKORO_VOICE, response_format: format, speed: 1.0 }),
          signal: AbortSignal.timeout(15000),
        });
        if (!resp.ok) throw new Error(`Kokoro-FastAPI HTTP ${resp.status}`);
        if (_kokoroApi !== 'openai') { _kokoroApi = 'openai'; console.log('🔊 Using Kokoro-FastAPI (OpenAI-compatible)'); }
        return Buffer.from(await resp.arrayBuffer());
      } catch (e) {
        if (_kokoroApi === 'openai') throw e;
        // Fall through to legacy
      }
    }
    // Legacy Flask API (/tts)
    const resp = await fetch(`${KOKORO_URL}/tts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: KOKORO_VOICE, speed: 1.0 }),
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`Kokoro HTTP ${resp.status}`);
    if (_kokoroApi !== 'legacy') { _kokoroApi = 'legacy'; console.log('🔊 Using Kokoro legacy Flask API (/tts)'); }
    return Buffer.from(await resp.arrayBuffer());
  } catch (e) {
    console.error('Kokoro TTS error, falling back to Edge:', e.message);
    return generateTTS_Edge(text);
  }
}

// ─── Emotion Detection & Extraction ─────────────────────────────────────────

const SYSTEM_PROMPT = `Voice assistant responding via a companion app with animated avatar. Reply in 1-3 short sentences. No markdown, no asterisks, no lists, no bullet points. Plain spoken Argentine Spanish. Concise and natural.

CRITICAL: Before EVERY sentence, you MUST add exactly one emotion tag. The avatar animates based on these tags — they control facial expressions!

Tags: [[emotion:happy]] [[emotion:sad]] [[emotion:surprised]] [[emotion:thinking]] [[emotion:confused]] [[emotion:laughing]] [[emotion:neutral]] [[emotion:angry]] [[emotion:love]]

Rules:
- NEVER use the same emotion twice in a row
- ALWAYS start with an emotion tag
- Be dramatic — exaggerate emotions like an animated character
- Match the emotion to what you're saying

Example: "[[emotion:happy]]¡Hola! Me alegra escucharte. [[emotion:thinking]]Dejame pensar en eso un segundo. [[emotion:surprised]]¡Ah, ya sé la respuesta!"

If the user sends an image, describe what you see expressively. If they send a file, analyze it helpfully.`;

/** Detect emotion from Spanish text using keyword matching (fallback when LLM doesn't tag) */
function analyzeEmotion(text) {
  const t = text.toLowerCase();
  if (/(?:jajaja|jejeje|jijiji|muerto de risa|me meo|no puedo más|😂|🤣|💀)/i.test(t)) return 'laughing';
  if (/(?:jaja|jeje|ja ja|je je)/i.test(t)) return 'laughing';
  if (/(?:furioso|enojado|enoja|molesto|molesta|terrible|horrible|odio|bronca|rabia|mierda|carajo|puta|qué porquería)/i.test(t)) return 'angry';
  if (/(?:triste|tristeza|lamento|lo siento|perdón|perdona|pena|doloroso|melanc|extraño|llorar|lágrima|duele|sufr|😢|😭)/i.test(t)) return 'sad';
  if (/(?:wow|guau|no puedo creer|sorprendente|impresionante|asombroso|en serio|increíble|no sabía|mirá vos|enserio|posta|😮|😲|🤯)/i.test(t)) return 'surprised';
  if (/(?:amor|te quiero|te amo|cariño|hermoso|hermosa|precioso|preciosa|adorable|corazón|❤|💕|😍|🥰)/i.test(t)) return 'love';
  if (/(?:gracioso|divertido|genial|excelente|fantástico|contento|feliz|alegr|me encanta|perfecto|buenísimo|bárbaro|copado|zarpado|macanudo|piola|bien ahí|dale|vamos|sí señor|😊|😁|🎉)/i.test(t)) return 'happy';
  if (/(?:no entiendo|confuso|confusa|raro|no sé|complicado|qué onda|ni idea|me perdí|🤔)/i.test(t)) return 'confused';
  if (/(?:hmm|veamos|déjame pensar|dejame pensar|a ver|interesante|curioso|me pregunto|quizás|tal vez|puede ser|depende|habría que ver)/i.test(t)) return 'thinking';
  if (/[?¿].*[?¿]/.test(text)) return 'confused';
  if (/[?¿]/.test(text)) return 'thinking';
  if (/[!¡].*[!¡]/.test(text)) return 'surprised';
  if (/[!¡]/.test(text)) return 'happy';
  if (/(?:bueno|listo|dale|ok|okey|claro|sí|seguro)/i.test(t)) return 'happy';
  if (/(?:no |nunca|tampoco|nada|nadie)/i.test(t)) return 'neutral';
  return 'neutral';
}

/** Extract [[emotion:X]] tags from LLM output, returning the emotion and cleaned text */
function extractEmotion(text) {
  const match = text.match(/\[\[emotion:(\w+)\]\]/);
  const emotion = match ? match[1] : null;
  const cleanText = text.replace(/\[\[emotion:\w+\]\]\s*/g, '').trim();
  return { emotion, text: cleanText };
}

// ─── Response Parsing (Buttons, Artifacts) ──────────────────────────────────

/** Extract [[buttons:opt1|opt2|opt3]] from LLM output */
function extractButtons(text) {
  const match = text.match(/\[\[buttons:([^\]]+)\]\]/);
  if (!match) return { text, buttons: null };
  const options = match[1].split('|').map(o => o.trim()).filter(Boolean).map(o => ({ text: o, value: o.toLowerCase() }));
  const cleanText = text.replace(/\[\[buttons:[^\]]+\]\]\s*/g, '').trim();
  return { text: cleanText, buttons: options.length > 0 ? options : null };
}

/** Extract large code blocks (>200 chars) as artifacts for separate display */
function extractArtifacts(text) {
  const artifacts = [];
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
  let match;
  let cleanText = text;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    const language = match[1] || '';
    const content = match[2];
    if (content.length > 200) {
      artifacts.push({
        artifactType: 'code',
        content: content.trimEnd(),
        language: language || 'text',
        title: language ? `${language} code` : 'Code',
      });
      cleanText = cleanText.replace(match[0], '');
    }
  }

  if (artifacts.length > 0) {
    cleanText = cleanText.replace(/\n{3,}/g, '\n\n').trim();
    if (!cleanText) cleanText = "Here's the code:";
  }

  return { text: cleanText, artifacts };
}

// ─── Conversation History ───────────────────────────────────────────────────

/**
 * Build the messages array for the LLM, including conversation history.
 * Keeps the system prompt at the start and the last MAX_CONVERSATION_HISTORY exchanges.
 *
 * @param {object} ws - WebSocket with _conversationHistory
 * @param {string|object[]} userContent - User message (string or multimodal content array)
 * @returns {object[]} Messages array ready for the LLM
 */
function buildMessagesWithHistory(ws, userContent) {
  const history = ws._conversationHistory || [];
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

  // Include recent history (last N exchanges = 2*N messages)
  const recentHistory = history.slice(-(MAX_CONVERSATION_HISTORY * 2));
  messages.push(...recentHistory);

  // Add current user message
  messages.push({ role: 'user', content: userContent });

  return messages;
}

/**
 * Record a user message and assistant response in conversation history.
 * Keeps history bounded to MAX_CONVERSATION_HISTORY exchanges.
 */
function recordExchange(ws, userContent, assistantContent) {
  if (!ws._conversationHistory) ws._conversationHistory = [];
  ws._conversationHistory.push(
    { role: 'user', content: typeof userContent === 'string' ? userContent : '[multimodal]' },
    { role: 'assistant', content: assistantContent },
  );
  // Trim to max exchanges (each exchange = 2 messages)
  const maxMessages = MAX_CONVERSATION_HISTORY * 2;
  if (ws._conversationHistory.length > maxMessages) {
    ws._conversationHistory = ws._conversationHistory.slice(-maxMessages);
  }
}

// ─── Web Search Detection ───────────────────────────────────────────────────

/** Check if a user message likely needs web search results */
function needsSearch(text) {
  const t = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const patterns = [
    /(?:busca|buscar|googlea|googlear|search|busqueda)\b/,
    /(?:que es|what is|quien es|who is|como se|how to)\b/,
    /(?:noticias|news|ultima hora|novedades)\b.*(?:sobre|de|about)/,
    /(?:precio|price|cotizacion|valor)\b.*(?:de|del|of)\b/,
    /(?:clima|weather|temperatura|pronostico)\b.*(?:en|in|de)\b/,
    /(?:cuando|when|donde|where)\b.*(?:es|fue|sera|is|was)\b/,
    /(?:averigua|investiga|fijate|check|look up|find out)\b/,
  ];
  return patterns.some(p => p.test(t));
}

/** Extract a clean search query from natural language */
function extractSearchQuery(text) {
  let q = text
    .replace(/^(?:busca|buscame|googlea|search|averigua|investiga|fijate)\s+/i, '')
    .replace(/^(?:que|quien|como|cuando|donde|what|who|how|when|where)\s+(?:es|son|fue|sera|is|are|was)\s+/i, '')
    .replace(/^(?:sobre|de|about|acerca de)\s+/i, '')
    .trim();
  if (q.length > 80) q = q.substring(0, 80);
  return q || text.substring(0, 60);
}

// ─── Gateway WebSocket Client ───────────────────────────────────────────────

/**
 * Persistent WebSocket connection to the OpenClaw Gateway.
 * Uses the native webchat protocol (JSON-RPC, protocol v3).
 * Provides real sessions, persistent history, and proactive message support.
 */
let gwWs = null;
let gwConnected = false;
let gwReconnectTimer = null;
let gwRequestId = 0;
const gwPendingRequests = new Map(); // id → { resolve, reject, timeout }
const gwChatRunCallbacks = new Map(); // clientRunId → { onDelta, onDone, prevText }
let gwActiveRun = null; // { clientRunId, onDelta, onDone, prevText } — current active run
const GW_SESSION_KEY = process.env.GW_SESSION_KEY || 'voice';
const gwProactiveListeners = new Set(); // Set of (payload) => void

function gwNextId() { return `voice-${++gwRequestId}-${crypto.randomUUID().substring(0,8)}`; }

function gwSend(obj) {
  if (gwWs?.readyState === WebSocket.OPEN) {
    gwWs.send(JSON.stringify(obj));
  }
}

/** Send a JSON-RPC request and wait for the response */
function gwRequest(method, params, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = gwNextId();
    const timer = setTimeout(() => {
      gwPendingRequests.delete(id);
      reject(new Error(`Gateway RPC timeout: ${method}`));
    }, timeoutMs);
    gwPendingRequests.set(id, { resolve, reject, timeout: timer });
    gwSend({ type: 'req', id, method, params });
  });
}

function gwConnect() {
  if (gwWs) { try { gwWs.close(); } catch {} }
  
  console.log(`🔌 Connecting to Gateway WS: ${GATEWAY_WS_URL}`);
  gwWs = new WebSocket(GATEWAY_WS_URL, {
    headers: { 'Origin': 'http://127.0.0.1:18789' },
  });
  
  gwWs.on('open', () => {
    console.log('🔌 Gateway WS connected, waiting for challenge...');
  });
  
  gwWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());
      
      // Step 1: Server sends connect.challenge
      if (msg.type === 'event' && msg.event === 'connect.challenge') {
        console.log('🔌 Got challenge, sending connect...');
        gwSend({
          type: 'req',
          id: gwNextId(),
          method: 'connect',
          params: {
            client: {
              id: 'gateway-client',
              displayName: 'OpenClaw Companion Voice Server',
              mode: 'backend',
              version: '1.0.0',
              platform: 'node',
            },
            role: 'operator',
            scopes: ['operator.admin'],
            minProtocol: 3,
            maxProtocol: 3,
            auth: { token: GATEWAY_TOKEN },
          },
        });
        return;
      }
      
      // Step 2: Server responds with hello-ok (standalone or as RPC res)
      if (msg.type === 'hello-ok' || (msg.type === 'res' && msg.ok && msg.payload?.type === 'hello-ok')) {
        gwConnected = true;
        const info = msg.type === 'hello-ok' ? msg : msg.payload;
        console.log(`✅ Gateway WS authenticated (protocol v${info?.protocol || '?'}, server ${info?.server?.version || '?'})`);
        if (msg.id) {
          const pending = gwPendingRequests.get(msg.id);
          if (pending) { clearTimeout(pending.timeout); gwPendingRequests.delete(msg.id); pending.resolve(msg.payload); }
        }
        return;
      }
      
      // Handle RPC responses (including connect success)
      if (msg.type === 'res' && msg.id) {
        if (!msg.ok) console.log(`🔌 Gateway RPC error: ${JSON.stringify(msg.error)}`);
        if (msg.ok && !gwConnected) {
          gwConnected = true;
          console.log(`✅ Gateway WS connected`);
        }
        const pending = gwPendingRequests.get(msg.id);
        if (pending) {
          clearTimeout(pending.timeout);
          gwPendingRequests.delete(msg.id);
          if (msg.ok) pending.resolve(msg.payload);
          else pending.reject(new Error(msg.error?.message || 'Gateway RPC error'));
        }
        return;
      }
      
      // Handle agent streaming events
      if (msg.type === 'event' && msg.event === 'agent') {
        const p = msg.payload;
        if (!p?.runId) return;
        if (!gwActiveRun) return;
        const cb = gwActiveRun;
        
        // Lock onto lifecycle:start for our voice session
        if (!cb.gatewayRunId) {
          if (p.stream === 'lifecycle' && p.data?.phase === 'start') {
            const sk = p.sessionKey || '';
            if (sk === GW_SESSION_KEY || sk.includes(`:${GW_SESSION_KEY}:`)) {
              cb.gatewayRunId = p.runId;
              console.log(`🔌 Locked runId: ${p.runId.substring(0,12)} sk=${sk}`);
            }
          }
          return;
        }
        if (p.runId !== cb.gatewayRunId) return;
        
        if (p.stream === 'assistant' && p.data?.text) {
          // Gateway sends cumulative text — extract only the new part
          const fullText = p.data.text;
          const newText = fullText.substring(cb.prevText?.length || 0);
          cb.prevText = fullText;
          if (newText) cb.onDelta(newText);
        } else if (p.stream === 'lifecycle' && p.data?.phase === 'end') {
          gwActiveRun = null;
          cb.onDone(null);
        } else if (p.stream === 'lifecycle' && p.data?.phase === 'error') {
          gwActiveRun = null;
          cb.onDone(new Error(p.data?.message || 'Agent error'));
        }
        return;
      }
      
      // Handle chat events (final text, proactive messages)
      if (msg.type === 'event' && msg.event === 'chat') {
        const p = msg.payload;
        
        // Proactive messages (not from a run we initiated)
        if (p.state === 'final' && !gwChatRunCallbacks.has(p.runId)) {
          const text = p.message?.content?.[0]?.text;
          if (text) {
            for (const listener of gwProactiveListeners) {
              try { listener({ text, sessionKey: p.sessionKey }); } catch {}
            }
          }
        }
        return;
      }
      
    } catch (e) {
      console.error('🔌 Gateway WS message parse error:', e.message);
    }
  });
  
  gwWs.on('close', (code, reason) => {
    gwConnected = false;
    console.log(`🔌 Gateway WS closed (${code}, ${reason?.toString() || 'no reason'}), reconnecting in 3s...`);
    gwReconnectTimer = setTimeout(gwConnect, 3000);
  });
  
  gwWs.on('error', (err) => {
    console.error('🔌 Gateway WS error:', err.message);
  });
}

/**
 * Send a message via Gateway WebSocket and stream the response.
 * Returns the runId for cancellation.
 *
 * @param {string} message - Text to send
 * @param {object} opts - { attachments?, sessionKey? }
 * @param {function} onDelta - Called with each text delta
 * @param {function} onDone - Called with (error?) when complete
 * @param {AbortSignal} signal - For cancellation
 * @returns {Promise<string>} runId
 */
async function gwChatSend(message, opts, onDelta, onDone, signal) {
  const runId = gwNextId();
  const sessionKey = opts.sessionKey || GW_SESSION_KEY;
  
  // Set as active run
  gwActiveRun = { clientRunId: runId, gatewayRunId: null, onDelta, onDone, prevText: '', sentAt: Date.now() };
  
  if (signal) {
    signal.addEventListener('abort', () => {
      if (gwActiveRun?.clientRunId === runId) gwActiveRun = null;
    }, { once: true });
  }
  
  try {
    const params = {
      message,
      sessionKey,
      idempotencyKey: runId,
    };
    if (opts.attachments) params.attachments = opts.attachments;
    
    const hasAttachments = params.attachments?.length > 0;
    const result = await gwRequest('chat.send', params, hasAttachments ? 180000 : 60000);
    console.log(`🔌 chat.send result: ${JSON.stringify(result)}`);
    return runId;
  } catch (e) {
    if (gwActiveRun?.clientRunId === runId) gwActiveRun = null;
    onDone(e);
    return runId;
  }
}

// ─── Streaming LLM ─────────────────────────────────────────────────────────

/**
 * Stream a chat completion. Uses Gateway WebSocket if available,
 * falls back to HTTP chat completions endpoint.
 *
 * Calls onSentence for each complete sentence detected in the stream,
 * and onDone when the stream finishes (with the full response text).
 */
async function streamAI(opts, onSentence, onDone, signal) {
  const messages = opts.messages;
  if (!messages) {
    onDone('', new Error('Invalid input to streamAI'));
    return;
  }

  // ─── Gateway WebSocket path ───
  if (USE_GATEWAY_WS && gwConnected) {
    let buffer = '';
    let fullResponse = '';
    
    // Extract the user message (last message in array)
    const userMsg = messages[messages.length - 1];
    const userText = typeof userMsg.content === 'string' 
      ? userMsg.content 
      : userMsg.content?.map(c => c.text || '').join(' ') || '';
    
    // Build attachments from multimodal content (resize to fit WS 512KB payload)
    const attachments = [];
    if (Array.isArray(userMsg.content)) {
      for (const part of userMsg.content) {
        if (part.type === 'image_url' && part.image_url?.url) {
          const match = part.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            let imgBase64 = match[2];
            const mimeType = match[1];
            // Resize if base64 > 300KB to fit within WS 512KB frame
            if (sharp && imgBase64.length > 300_000) {
              try {
                const buf = Buffer.from(imgBase64, 'base64');
                const resized = await sharp(buf)
                  .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
                  .jpeg({ quality: 70 })
                  .toBuffer();
                imgBase64 = resized.toString('base64');
                console.log(`🖼️ Resized image: ${buf.length} → ${resized.length} bytes`);
              } catch (e) {
                console.error('⚠️ Image resize failed, sending original:', e.message);
              }
            }
            attachments.push({
              type: 'image',
              mimeType: imgBase64 !== match[2] ? 'image/jpeg' : mimeType,
              content: imgBase64,
            });
          }
        }
      }
    }
    
    const onDelta = (deltaText) => {
      buffer += deltaText;
      fullResponse += deltaText;
      
      // Split on sentence boundaries
      const sentenceRegex = /^(.*?[.!?])(\s+|\s*\[\[emotion:)/;
      let match;
      while ((match = buffer.match(sentenceRegex))) {
        const sentence = match[1].trim();
        if (sentence) onSentence(sentence);
        buffer = buffer.slice(match[1].length).trim();
      }
    };
    
    const onRunDone = (error) => {
      if (buffer.trim()) onSentence(buffer.trim());
      if (error) onDone(fullResponse, error);
      else onDone(fullResponse);
    };
    
    await gwChatSend(
      userText,
      { attachments: attachments.length > 0 ? attachments : undefined },
      onDelta,
      onRunDone,
      signal,
    );
    return;
  }

  // ─── HTTP fallback path (original) ───
  let buffer = '';
  let fullResponse = '';

  try {
    const res = await fetch(GATEWAY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
      },
      body: JSON.stringify({
        model: 'openclaw',
        user: 'voice-companion',
        stream: true,
        messages,
      }),
      signal,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`HTTP ${res.status}: ${body.substring(0, 200)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal && signal.aborted) break;

      sseBuffer += decoder.decode(value, { stream: true });
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop();

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          if (buffer.trim()) onSentence(buffer.trim());
          buffer = '';
          onDone(fullResponse);
          return;
        }
        try {
          const parsed = JSON.parse(data);
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            buffer += content;
            fullResponse += content;

            const sentenceRegex = /^(.*?[.!?])(\s+|\s*\[\[emotion:)/;
            let match;
            while ((match = buffer.match(sentenceRegex))) {
              const sentence = match[1].trim();
              if (sentence) onSentence(sentence);
              buffer = buffer.slice(match[1].length).trim();
            }
          }
        } catch (e) { /* ignore malformed SSE chunks */ }
      }
    }

    if (buffer.trim()) onSentence(buffer.trim());
    onDone(fullResponse);
  } catch (e) {
    if (e.name === 'AbortError') {
      onDone(fullResponse, new Error('Cancelled'));
    } else {
      onDone(fullResponse, e);
    }
  }
}

// ─── Cancellation & Barge-in ────────────────────────────────────────────────

/**
 * Cancel ongoing LLM generation and reset state.
 * Used by both 'cancel' and 'barge_in' message types.
 *
 * @param {object} ws - WebSocket connection
 * @param {object} [options]
 * @param {boolean} [options.sendStopPlayback=false] - Send stop_playback to client (for barge-in)
 * @param {string} [options.reason='cancel'] - Reason for logging
 */
function cancelGeneration(ws, { sendStopPlayback = false, reason = 'cancel' } = {}) {
  console.log(`🚫 ${reason}`);

  if (ws._abortController) {
    ws._abortController.abort();
    ws._abortController = null;
  }

  // Log partial response if we have one (useful for barge-in context)
  if (ws._partialResponse) {
    console.log(`📝 Partial response saved: "${ws._partialResponse.substring(0, 80)}..."`);
    // Record the interrupted exchange in history so the AI has context
    if (ws._pendingUserMessage) {
      recordExchange(ws, ws._pendingUserMessage, ws._partialResponse + '... [interrumpido]');
    }
    ws._partialResponse = null;
    ws._pendingUserMessage = null;
  }

  if (sendStopPlayback) {
    send(ws, { type: 'stop_playback' });
  }

  send(ws, { type: 'status', status: 'idle' });
}

// ─── Message Handlers ───────────────────────────────────────────────────────

/**
 * Handle a text message: optionally search the web, then stream LLM + TTS response.
 * Records the exchange in conversation history for multi-turn context.
 */
async function handleTextMessage(ws, text, prefix) {
  if (text.toLowerCase().replace(/[^a-záéíóú ]/g, '').includes('test emocion')) {
    handleTestEmotions(ws);
    return;
  }

  const ac = new AbortController();
  ws._abortController = ac;
  send(ws, { type: 'status', status: 'thinking' });

  let fullText = prefix ? `${prefix} ${text}` : text;

  // Auto-search: inject web results if the user's actual speech needs them
  // Only search on the original text, not ambient context wrappers
  if (needsSearch(text) && !text.startsWith('[Ambient')) {
    const query = extractSearchQuery(text);
    console.log(`🔍 Auto-search: "${query}"`);
    const results = await webSearch(query, 5);
    if (results && results.length > 0) {
      const searchContext = results.map((r, i) =>
        `[${i + 1}] ${r.title}: ${r.body || r.href}`
      ).join('\n');
      fullText += `\n\n[Web search results for "${query}":\n${searchContext}\n]\nUse these results to answer. Cite sources briefly if relevant.`;
      console.log(`🔍 Injected ${results.length} search results`);
    }
  }

  // Track pending state for barge-in partial response saving
  ws._pendingUserMessage = fullText;
  ws._partialResponse = '';

  const messages = buildMessagesWithHistory(ws, fullText);

  let sentenceIndex = 0;
  let firstSentence = true;
  const sentencePromises = [];

  console.log(`🔄 Streaming: "${text.substring(0, 60)}"`);

  streamAI({ messages },
    (sentence) => {
      if (ac.signal.aborted) return;
      const idx = sentenceIndex++;
      const { emotion: tagEmotion, text: cleanSentence } = extractEmotion(sentence);
      const emotion = tagEmotion || analyzeEmotion(cleanSentence);

      console.log(`📝 [${idx}] ${emotion}: "${cleanSentence.substring(0, 50)}"`);

      if (firstSentence) {
        firstSentence = false;
        send(ws, { type: 'status', status: 'speaking' });
        send(ws, { type: 'emotion', emotion });
      }

      send(ws, { type: 'reply_chunk', text: cleanSentence, index: idx, emotion });

      // Generate TTS concurrently per sentence — chunks are sent as they're ready
      const ttsPromise = (async () => {
        try {
          const audioData = await generateTTS(cleanSentence);
          if (audioData && !ac.signal.aborted) {
            send(ws, { type: 'audio_chunk', data: audioData.toString('base64'), index: idx, emotion, text: cleanSentence });
            console.log(`🔊 Chunk ${idx} OK [${emotion}]`);
          }
        } catch (e) {
          console.error(`❌ TTS ${idx}:`, e.message);
        }
      })();
      sentencePromises.push(ttsPromise);
    },
    async (fullResponse, error) => {
      if (error && !ac.signal.aborted) {
        console.error('❌ Stream error:', error.message);
        send(ws, { type: 'error', message: error.message });
      }

      // Wait for all TTS chunks to finish before signaling done
      await Promise.all(sentencePromises);

      const cleanFull = fullResponse.replace(/\[\[emotion:\w+\]\]\s*/g, '').trim();

      // Extract artifacts and buttons from the full response
      const { text: textWithoutArtifacts, artifacts } = extractArtifacts(cleanFull);
      for (const artifact of artifacts) {
        send(ws, { type: 'artifact', ...artifact });
      }

      const { text: finalText, buttons } = extractButtons(textWithoutArtifacts);
      if (buttons) {
        send(ws, { type: 'buttons', options: buttons });
      }

      // P1-9: Retry once on empty AI response for direct messages (not ambient context)
      if (!ac.signal.aborted && !cleanFull && !fullText.startsWith('[Ambient')) {
        console.log('⚠️ Empty AI response, retrying with simplified prompt...');
        // Don't send stream_done yet, retry
        ws._abortController = null;
        ws._partialResponse = null;
        ws._pendingUserMessage = null;
        handleTextMessage(ws, fullText.replace(/^\[.*?\]:\s*/, '').trim() || fullText, '');
        return;
      }

      // Record exchange in conversation history (only if not cancelled)
      if (!ac.signal.aborted && cleanFull) {
        recordExchange(ws, fullText, cleanFull);
      }

      console.log(`🤖 Done: "${(finalText || cleanFull).substring(0, 80)}"`);
      send(ws, { type: 'stream_done' });
      send(ws, { type: 'status', status: 'idle' });
      ws._abortController = null;
      ws._partialResponse = null;
      ws._pendingUserMessage = null;
    },
    ac.signal
  );
}

/**
 * Handle multimodal messages (images, files with vision).
 * Streams LLM response with per-sentence TTS, same as text handler.
 */
function handleMultimodalMessage(ws, messages, logPrefix, userContentForHistory) {
  const ac = new AbortController();
  ws._abortController = ac;
  send(ws, { type: 'status', status: 'thinking' });

  ws._pendingUserMessage = userContentForHistory || '[multimodal]';
  ws._partialResponse = '';

  let sentenceIndex = 0;
  let firstSentence = true;
  const sentencePromises = [];

  console.log(`🔄 ${logPrefix}`);

  streamAI({ messages },
    (sentence) => {
      if (ac.signal.aborted) return;
      const idx = sentenceIndex++;
      const { emotion: tagEmotion, text: cleanSentence } = extractEmotion(sentence);
      const emotion = tagEmotion || analyzeEmotion(cleanSentence);

      console.log(`📝 [${idx}] ${emotion}: "${cleanSentence.substring(0, 50)}"`);

      if (firstSentence) {
        firstSentence = false;
        send(ws, { type: 'status', status: 'speaking' });
        send(ws, { type: 'emotion', emotion });
      }

      send(ws, { type: 'reply_chunk', text: cleanSentence, index: idx, emotion });

      const ttsPromise = (async () => {
        try {
          const audioData = await generateTTS(cleanSentence);
          if (audioData && !ac.signal.aborted) {
            send(ws, { type: 'audio_chunk', data: audioData.toString('base64'), index: idx, emotion, text: cleanSentence });
            console.log(`🔊 Chunk ${idx} OK [${emotion}]`);
          }
        } catch (e) {
          console.error(`❌ TTS ${idx}:`, e.message);
        }
      })();
      sentencePromises.push(ttsPromise);
    },
    async (fullResponse, error) => {
      if (error && !ac.signal.aborted) {
        console.error('❌ Stream error:', error.message);
        send(ws, { type: 'error', message: error.message });
      }

      await Promise.all(sentencePromises);

      const cleanFull = fullResponse.replace(/\[\[emotion:\w+\]\]\s*/g, '').trim();

      const { text: textWithoutArtifacts, artifacts } = extractArtifacts(cleanFull);
      for (const artifact of artifacts) {
        send(ws, { type: 'artifact', ...artifact });
      }

      const { text: finalText, buttons } = extractButtons(textWithoutArtifacts);
      if (buttons) {
        send(ws, { type: 'buttons', options: buttons });
      }

      if (!ac.signal.aborted && cleanFull) {
        recordExchange(ws, ws._pendingUserMessage, cleanFull);
      }

      console.log(`🤖 Done: "${(finalText || cleanFull).substring(0, 80)}"`);
      send(ws, { type: 'stream_done' });
      send(ws, { type: 'status', status: 'idle' });
      ws._abortController = null;
      ws._partialResponse = null;
      ws._pendingUserMessage = null;
    },
    ac.signal
  );
}

/** Handle image messages (photo + optional caption) */
function handleImageMessage(ws, msg) {
  const caption = msg.text || 'Describe this image';
  const mimeType = msg.mimeType || 'image/jpeg';
  const dataUrl = `data:${mimeType};base64,${msg.data}`;

  console.log(`🖼️ Image message: "${caption.substring(0, 60)}"`);

  // Build messages with history context + multimodal content
  const history = ws._conversationHistory || [];
  const recentHistory = history.slice(-(MAX_CONVERSATION_HISTORY * 2));
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...recentHistory,
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'text', text: caption },
      ],
    },
  ];

  handleMultimodalMessage(ws, messages, `Image: "${caption.substring(0, 60)}"`, caption);
}

/** Handle file messages (text files for analysis) */
function handleFileMessage(ws, msg) {
  const dataSize = Buffer.byteLength(msg.data, 'base64');
  if (dataSize > MAX_FILE_SIZE) {
    send(ws, { type: 'error', message: 'File too large. Maximum size is 5MB.' });
    send(ws, { type: 'status', status: 'idle' });
    return;
  }

  const ext = (msg.name || '').split('.').pop().toLowerCase();
  if (!TEXT_FILE_EXTENSIONS.has(ext)) {
    send(ws, { type: 'error', message: 'File type not supported for analysis' });
    send(ws, { type: 'status', status: 'idle' });
    return;
  }

  const content = Buffer.from(msg.data, 'base64').toString('utf-8');
  const userText = `Here's the file ${msg.name}:\n\`\`\`\n${content}\n\`\`\`\nAnalyze this file.`;

  console.log(`📄 File message: ${msg.name} (${dataSize} bytes)`);
  handleTextMessage(ws, userText, '');
}

// ─── Audio Handling ─────────────────────────────────────────────────────────

/** Handle voice audio: transcribe with Whisper, then process as text */
async function handleAudio(ws, audioBase64, prefix) {
  try {
    const audio = Buffer.from(audioBase64, 'base64');
    console.log(`📥 Audio: ${audio.length} bytes`);

    send(ws, { type: 'status', status: 'transcribing' });
    const text = await transcribe(audio);
    console.log(`📝 Transcript: "${text}"`);

    if (!text.trim()) {
      send(ws, { type: 'error', message: 'No speech detected' });
      send(ws, { type: 'status', status: 'idle' });
      return;
    }

    if (isGarbageTranscription(text)) {
      console.log(`🗑️ Garbage transcription filtered: "${text}"`);
      send(ws, { type: 'error', message: 'No se entendió bien, repetí por favor' });
      send(ws, { type: 'status', status: 'idle' });
      return;
    }

    send(ws, { type: 'transcript', text });
    handleTextMessage(ws, text, prefix);
  } catch (e) {
    console.error('❌ Audio error:', e.message);
    send(ws, { type: 'error', message: e.message });
    send(ws, { type: 'status', status: 'idle' });
  }
}

// ─── Smart Listen (Ambient) Mode ────────────────────────────────────────────

/** Determine if ambient speech should trigger a response based on wake words/patterns */
function shouldRespond(text, botName) {
  const t = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const name = botName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  if (t.includes(name)) return { respond: true, reason: 'name' };
  if (/(?:^|\s)(oye?|che|ey|hey|hola|escucha|decime|contame|explicame|ayudame)/i.test(t) && t.length < 80) {
    return { respond: true, reason: 'wake_phrase' };
  }
  if (/(?:qué (?:opinas|pensás|decís|te parece)|(?:sabés|sabes) (?:algo|qué|si)|podés|podrías|me (?:ayudás|explicás|contás))/i.test(t)) {
    return { respond: true, reason: 'question' };
  }
  if (/(?:vos qué|tu qué|y vos|qué onda con|dale tu opinión)/i.test(t)) {
    return { respond: true, reason: 'opinion_request' };
  }
  return { respond: false };
}

// P2-10: SIMULTANEOUS USE — Meet bot and voice app can run at the same time.
// Speaker profiles are reset when the voice app connects (P1-8) to avoid contamination.
// The meet bot uses its own speaker profiles. They share the same Whisper server but
// requests are independent. No special coordination needed beyond the profile reset.

// P2-11: Auto noise detection — track ambient audio energy to auto-adjust thresholds
const noiseTracker = {
  samples: [],           // recent RMS values
  maxSamples: 50,        // ~50 segments worth of data
  baselineRms: 0,        // running average ambient noise level
  highNoiseThreshold: 800, // if baseline > this, we're in a noisy environment
  isNoisy: false,
};

function updateNoiseBaseline(audioBuffer) {
  // Calculate RMS of the audio buffer
  let sum = 0;
  for (let i = 0; i + 1 < audioBuffer.length; i += 2) {
    const sample = audioBuffer.readInt16LE(i);
    sum += sample * sample;
  }
  const rms = Math.sqrt(sum / (audioBuffer.length / 2));
  
  noiseTracker.samples.push(rms);
  if (noiseTracker.samples.length > noiseTracker.maxSamples) {
    noiseTracker.samples.shift();
  }
  
  const avg = noiseTracker.samples.reduce((a, b) => a + b, 0) / noiseTracker.samples.length;
  const wasNoisy = noiseTracker.isNoisy;
  noiseTracker.baselineRms = avg;
  noiseTracker.isNoisy = avg > noiseTracker.highNoiseThreshold;
  
  if (noiseTracker.isNoisy !== wasNoisy) {
    console.log(`🔊 Noise environment changed: ${noiseTracker.isNoisy ? 'NOISY' : 'quiet'} (baseline RMS: ${avg.toFixed(0)})`);
  }
  
  return { rms, baseline: avg, isNoisy: noiseTracker.isNoisy };
}

// Throttle: only 1 ambient transcription at a time
let _ambientBusy = false;

/** Handle ambient (always-listening) audio: transcribe, identify speaker, decide whether to respond */
async function handleAmbientAudio(ws, audioBase64) {
  try {
    const audio = Buffer.from(audioBase64, 'base64');
    if (audio.length < 1000) return;

    // P2-11: Track noise levels for auto-adjustment
    const noiseInfo = updateNoiseBaseline(audio);

    if (_ambientBusy) return; // Drop if Whisper can't keep up
    _ambientBusy = true;

    console.log(`🎧 Ambient audio: ${audio.length} bytes (rms=${noiseInfo.rms.toFixed(0)}, noise=${noiseInfo.isNoisy ? 'HIGH' : 'low'})`);
    send(ws, { type: 'smart_status', status: 'transcribing' });

    const [text, speakerInfo] = await Promise.all([
      transcribe(audio),
      identifySpeaker(audio).catch(e => { console.error('Speaker ID failed:', e.message); return null; }),
    ]).finally(() => { _ambientBusy = false; });

    if (!text.trim() || isGarbageTranscription(text)) {
      send(ws, { type: 'smart_status', status: 'listening' });
      return;
    }
    
    // P2-11: In noisy environments, require longer transcripts to filter false positives
    const minWords = noiseTracker.isNoisy ? 4 : 3;
    const wordCount = text.trim().split(/\s+/).length;
    if (wordCount < minWords) {
      console.log(`🔇 Short ambient filtered (${wordCount} words): "${text}"`);
      send(ws, { type: 'smart_status', status: 'listening' });
      return;
    }

    const speaker = speakerInfo?.speaker || 'Unknown';
    const isKnown = speakerInfo?.known || false;
    const hasProfiles = speakerInfo?.hasProfiles ?? true;
    const autoEnrolling = speakerInfo?.autoEnrolling || false;
    const isOwner = (speaker === OWNER_NAME) || (!hasProfiles && !autoEnrolling);

    // Detect self-introduction and rename unknown speakers
    const introName = detectIntroduction(text);
    if (introName && !isKnown && speaker.startsWith('Speaker_')) {
      console.log(`📝 Introduction detected: ${speaker} → ${introName}`);
      await renameSpeaker(speaker, introName);
      // Update local vars for this request
      Object.assign(speakerInfo, { speaker: introName, known: true });
    }
    const finalSpeaker = speakerInfo?.speaker || speaker;

    console.log(`🎧 [${finalSpeaker}${isOwner ? ' 👑' : ''}${autoEnrolling ? ` (enrolling ${speakerInfo.samples}/${speakerInfo.needed})` : ''}]: "${text}"`);

    send(ws, { type: 'ambient_transcript', text, speaker: finalSpeaker, isOwner, isKnown });

    // Maintain ambient context window (last 5 minutes)
    if (!ws._ambientContext) ws._ambientContext = [];
    ws._ambientContext.push({ text, speaker: finalSpeaker, isOwner, time: Date.now() });
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    ws._ambientContext = ws._ambientContext
      .filter(c => c.time > fiveMinAgo)
      .slice(-MAX_CONTEXT_LINES);

    const botName = ws._botName || BOT_NAME;
    const decision = shouldRespond(text, botName);
    const shouldReply = decision.respond;

    if (shouldReply) {
      console.log(`🤖 Smart trigger: ${decision.reason || 'owner'} by ${speaker}`);

      let fullPrompt;
      
      // P1-9: For name triggers (someone said "Jarvis"), send CLEAN direct message
      // without ambient context wrapper — the wrapper confuses the AI into empty responses
      if (decision.reason === 'name') {
        // Strip the bot name from the beginning and send as direct message
        const botName = ws._botName || BOT_NAME;
        const cleanText = text.replace(new RegExp(`\\b${botName}\\b[,.:!?\\s]*`, 'gi'), '').trim() || text;
        const speakerLabel = isOwner ? `${finalSpeaker} (your owner)` : finalSpeaker;
        fullPrompt = `[${speakerLabel}]: ${cleanText}`;
        console.log(`📢 Name trigger → clean direct message: "${cleanText}"`);
      } else {
        // For other triggers, include ambient context
        const contextLines = ws._ambientContext.slice(0, -1);
        let contextPrompt = '';
        if (contextLines.length > 0) {
          contextPrompt = `[Ambient conversation context:\n${contextLines.map(c =>
            `- [${c.speaker}${c.isOwner ? ' (your owner, highest priority)' : ''}]: "${c.text}"`
          ).join('\n')}\n]\n\n`;
        }
        const speakerLabel = isOwner ? `${finalSpeaker} (your owner)` : finalSpeaker;
        fullPrompt = contextPrompt + `[${speakerLabel} just said: "${text}"]`;
      }

      send(ws, { type: 'status', status: 'thinking' });
      send(ws, { type: 'transcript', text: `[${finalSpeaker}] ${text}` });
      handleTextMessage(ws, fullPrompt, '');
    } else {
      send(ws, { type: 'smart_status', status: 'listening' });
    }
  } catch (e) {
    console.error('❌ Ambient error:', e.message);
    send(ws, { type: 'smart_status', status: 'listening' });
  }
}

// ─── Test / Demo ────────────────────────────────────────────────────────────

async function handleTestEmotions(ws) {
  console.log('🎭 Emotion demo!');
  const testCues = [
    { startMs: 0, endMs: 2500, text: '¡Hola! Soy feliz de verte.', emotion: 'happy' },
    { startMs: 2500, endMs: 5000, text: '¡Wow, esto es increíble!', emotion: 'surprised' },
    { startMs: 5000, endMs: 7500, text: 'Jajaja, qué divertido.', emotion: 'laughing' },
    { startMs: 7500, endMs: 10000, text: 'Hmm, déjame pensar.', emotion: 'thinking' },
    { startMs: 10000, endMs: 12500, text: 'No entiendo qué pasa.', emotion: 'confused' },
    { startMs: 12500, endMs: 15000, text: 'Esto me pone triste.', emotion: 'sad' },
    { startMs: 15000, endMs: 17500, text: '¡Estoy furioso!', emotion: 'angry' },
    { startMs: 17500, endMs: 20000, text: 'Te quiero mucho.', emotion: 'love' },
    { startMs: 20000, endMs: 22000, text: 'Volvemos a la normalidad.', emotion: 'neutral' },
  ];
  try {
    const fullText = testCues.map(c => c.text).join(' ');
    send(ws, { type: 'reply', text: '🎭 Demo de emociones' });
    send(ws, { type: 'status', status: 'speaking' });
    send(ws, { type: 'emotion_cues', cues: testCues });
    const audio = await generateTTS(fullText);
    if (audio) send(ws, { type: 'audio', data: audio.toString('base64') });
    send(ws, { type: 'status', status: 'idle' });
  } catch (e) {
    console.error('Demo error:', e.message);
    send(ws, { type: 'status', status: 'idle' });
  }
}

// ─── Device Command Support ─────────────────────────────────────────────────

/** Send a command to the connected Android device and wait for the response */
function sendDeviceCommand(ws, command, params = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const id = 'req_' + crypto.randomUUID().slice(0, 8);
    if (!ws._pendingCommands) ws._pendingCommands = {};

    const timer = setTimeout(() => {
      delete ws._pendingCommands[id];
      reject(new Error(`Device command ${command} timed out`));
    }, timeoutMs);

    ws._pendingCommands[id] = {
      resolve: (result) => { clearTimeout(timer); resolve(result); },
      reject: (err) => { clearTimeout(timer); reject(err); },
    };

    send(ws, { type: 'device_command', id, command, params });
  });
}

/** Get the first authenticated WS client (for HTTP API) */
function getActiveClient() {
  for (const client of wss.clients) {
    if (client._authenticated && client.readyState === 1) return client;
  }
  if (wssSecure) {
    for (const client of wssSecure.clients) {
      if (client._authenticated && client.readyState === 1) return client;
    }
  }
  return null;
}

// ─── HTTP + WebSocket Server ────────────────────────────────────────────────

const TLS_CERT = process.env.TLS_CERT || '';
const TLS_KEY = process.env.TLS_KEY || '';
const WSS_PORT = parseInt(process.env.WSS_PORT || '3443');

const requestHandler = (req, res) => {
  const setCors = () => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  };

  if (req.method === 'OPTIONS') {
    setCors();
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":"ok"}');
  } else if (req.url === '/device/capabilities' && req.method === 'GET') {
    setCors();
    const client = getActiveClient();
    if (!client) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No device connected' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      connected: true,
      capabilities: client._deviceCapabilities || {},
    }));
  } else if (req.url === '/device/command' && req.method === 'POST') {
    setCors();
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const { command, params, timeout } = JSON.parse(body);
        if (!command) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing "command" field' }));
          return;
        }
        const client = getActiveClient();
        if (!client) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No device connected' }));
          return;
        }
        // Check if device supports this command
        const caps = client._deviceCapabilities || {};
        if (caps[command] && !caps[command].available) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Device capability "${command}" not available` }));
          return;
        }
        const result = await sendDeviceCommand(client, command, params || {}, timeout || 15000);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
};

const httpServer = http.createServer(requestHandler);

// Optional TLS server for WSS (GitHub Pages requires wss://)
let httpsServer = null;
if (TLS_CERT && TLS_KEY && fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY)) {
  httpsServer = https.createServer({
    cert: fs.readFileSync(TLS_CERT),
    key: fs.readFileSync(TLS_KEY),
  }, requestHandler);
  console.log(`🔒 TLS enabled — WSS will listen on port ${WSS_PORT}`);
}

const wss = new WebSocketServer({ server: httpServer });

// If TLS is available, also accept WSS connections on the HTTPS server
let wssSecure = null;
if (httpsServer) {
  wssSecure = new WebSocketServer({ server: httpsServer });
  // Share the same connection handler (set up below after wss.on('connection'))
}

function handleConnection(ws) {
  console.log('🔌 New WS connection');
  ws._authenticated = false;
  const authTimer = setTimeout(() => { if (!ws._authenticated) ws.close(); }, 5000);

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    // ── Authentication ──
    if (!ws._authenticated) {
      if (msg.type === 'auth' && msg.token === AUTH_TOKEN) {
        ws._authenticated = true;
        clearTimeout(authTimer);

        const sessionId = msg.sessionId || crypto.randomUUID();
        const lastServerSeq = msg.lastServerSeq || 0;
        const session = getOrCreateSession(sessionId);
        ws._sessionId = sessionId;

        syncWsWithSession(ws, session);

        const authResp = { type: 'auth', status: 'ok', sessionId, serverSeq: ws._sseq || 0 };
        if (ws.readyState === 1) ws.send(JSON.stringify(authResp));

        // Replay missed messages on reconnect
        if (lastServerSeq > 0 && ws._sendBuffer.length > 0) {
          const missed = ws._sendBuffer.filter(m => m.sseq > lastServerSeq);
          if (missed.length > 0) {
            console.log(`🔄 Replaying ${missed.length} missed messages (from sseq ${lastServerSeq + 1})`);
            for (const m of missed) {
              if (ws.readyState === 1) ws.send(JSON.stringify({ ...m, _replayed: true }));
            }
          }
        }

        if (msg.clientSeq) session.lastClientSeq = msg.clientSeq;
        console.log(`🔓 Authenticated (session: ${sessionId.slice(0, 8)}, sseq: ${ws._sseq}, history: ${(ws._conversationHistory || []).length} msgs)`);

        // P1-8: Reset speaker profiles on new voice session to avoid contamination from meet bot
        if (!msg.lastServerSeq) {
          // Only reset on fresh connections (not reconnects)
          resetSpeakerProfiles().catch(() => {});
        }
      } else {
        send(ws, { type: 'error', message: 'Auth required' });
        ws.close();
      }
      return;
    }

    // ── Client sequence dedup ──
    if (msg.cseq) {
      const session = sessions.get(ws._sessionId);
      if (session) {
        if (msg.cseq <= session.lastClientSeq) {
          console.log(`⏭️ Skipping duplicate client msg cseq=${msg.cseq}`);
          return;
        }
        session.lastClientSeq = msg.cseq;
      }
    }

    // ── Message routing ──
    switch (msg.type) {
      case 'audio':
        // P2-12: Direct push-to-talk audio assumes it's the owner — no speaker ID needed
        if (msg.data) handleAudio(ws, msg.data, msg.prefix || '');
        break;

      case 'ambient_audio':
        if (msg.data) handleAmbientAudio(ws, msg.data);
        break;

      case 'set_bot_name':
        ws._botName = (msg.name || 'jarvis').toLowerCase();
        console.log(`📛 Bot name set: ${ws._botName}`);
        break;

      case 'enroll_audio':
        if (msg.data && msg.name) {
          const wavBuf = Buffer.from(msg.data, 'base64');
          const append = msg.append || false;
          console.log(`📝 Enrollment${append ? ' (append)' : ''} for: ${msg.name}`);
          enrollSpeaker(wavBuf, msg.name, append).then(result => {
            if (result) {
              send(ws, { type: 'enroll_result', status: 'ok', speaker: msg.name });
              console.log(`✅ Enrolled: ${msg.name}`);
            } else {
              send(ws, { type: 'enroll_result', status: 'error', message: 'Enrollment failed' });
            }
          });
        }
        break;

      case 'get_profiles':
        getSpeakerProfiles().then(result => {
          send(ws, { type: 'profiles', profiles: result.profiles, count: result.count, ownerEnrolled: result.ownerEnrolled });
        });
        break;

      case 'rename_speaker':
        if (msg.oldName && msg.newName) {
          renameSpeaker(msg.oldName, msg.newName).then(result => {
            if (result?.status === 'renamed') {
              send(ws, { type: 'rename_result', status: 'ok', old: msg.oldName, new: msg.newName });
            } else {
              send(ws, { type: 'rename_result', status: 'error', message: result?.error || 'Failed' });
            }
          });
        }
        break;

      case 'reset_speakers':
        fetch(`${SPEAKER_URL}/reset`, { method: 'POST' }).then(() => {
          send(ws, { type: 'reset_result', status: 'ok' });
        }).catch(() => {
          send(ws, { type: 'reset_result', status: 'error' });
        });
        break;

      case 'set_tts_engine':
        if (msg.engine && ['edge', 'kokoro', 'xtts'].includes(msg.engine)) {
          TTS_ENGINE = msg.engine;
          console.log(`🔊 TTS engine changed to: ${TTS_ENGINE}`);
          send(ws, { type: 'tts_engine', engine: TTS_ENGINE, status: 'ok' });
        } else {
          send(ws, { type: 'tts_engine', engine: TTS_ENGINE, status: 'error', message: 'Invalid engine. Use: edge, kokoro, xtts' });
        }
        break;

      case 'get_settings':
        send(ws, { type: 'settings', ttsEngine: TTS_ENGINE, ttsEngines: ['kokoro', 'edge', 'xtts'], botName: BOT_NAME, ownerName: OWNER_NAME });
        break;

      case 'text':
        if (msg.text) {
          console.log(`💬 Text: "${msg.text}"`);
          handleTextMessage(ws, msg.text, msg.prefix || '');
        }
        break;

      case 'image':
        if (msg.data) handleImageMessage(ws, msg);
        break;

      case 'file':
        if (msg.data && msg.name) handleFileMessage(ws, msg);
        else send(ws, { type: 'error', message: 'File requires data and name fields' });
        break;

      case 'cancel':
        cancelGeneration(ws, { reason: 'Cancel requested' });
        break;

      case 'barge_in':
        // Barge-in: user started speaking while AI was responding.
        // Abort LLM, stop client playback, save partial context.
        cancelGeneration(ws, { sendStopPlayback: true, reason: 'Barge-in' });
        break;

      case 'replay':
        if (ws._lastAudio) send(ws, { type: 'audio', data: ws._lastAudio });
        else send(ws, { type: 'error', message: 'No audio to replay' });
        break;

      case 'clear_history':
        ws._conversationHistory = [];
        // Sync to persistent session store
        if (ws._sessionId && sessions.has(ws._sessionId)) {
          sessions.get(ws._sessionId).conversationHistory = [];
        }
        console.log(`🧹 Conversation history cleared`);
        send(ws, { type: 'history_cleared' });
        break;

      case 'capabilities':
        ws._deviceCapabilities = msg.capabilities || {};
        console.log('📱 Device capabilities:', Object.keys(ws._deviceCapabilities).join(', '));
        break;

      case 'device_response': {
        const reqId = msg.id;
        if (ws._pendingCommands && ws._pendingCommands[reqId]) {
          ws._pendingCommands[reqId].resolve(msg);
          delete ws._pendingCommands[reqId];
        } else {
          console.log(`⚠️ Device response for unknown request: ${reqId}`);
        }
        break;
      }

      case 'ping':
        send(ws, { type: 'pong' });
        break;
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    // Reject all pending device commands
    if (ws._pendingCommands) {
      for (const [id, pending] of Object.entries(ws._pendingCommands)) {
        pending.reject(new Error('Device disconnected'));
      }
      ws._pendingCommands = {};
    }
    if (ws._sessionId && sessions.has(ws._sessionId)) {
      saveWsToSession(ws, sessions.get(ws._sessionId));
      expireSession(ws._sessionId);
      console.log(`🔌 WS disconnected (session ${ws._sessionId.slice(0, 8)} saved, ${ws._sendBuffer?.length || 0} msgs buffered)`);
    } else {
      console.log('🔌 WS disconnected');
    }
  });
}

wss.on('connection', handleConnection);
if (wssSecure) wssSecure.on('connection', handleConnection);

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Voice WS server on 0.0.0.0:${PORT}`);
  // Start Gateway WS connection if enabled
  if (USE_GATEWAY_WS) {
    console.log(`🔌 Gateway WS mode enabled, connecting to ${GATEWAY_WS_URL}...`);
    gwConnect();
  } else {
    console.log(`📡 Using HTTP chat completions: ${GATEWAY_URL}`);
  }
});
if (httpsServer) httpsServer.listen(WSS_PORT, '0.0.0.0', () => console.log(`✅ Voice WSS server on 0.0.0.0:${WSS_PORT}`));
