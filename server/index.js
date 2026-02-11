const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { WebSocketServer } = require('ws');

// ─── Configuration ───────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3200', 10);
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'jarvis-voice-' + crypto.randomBytes(8).toString('hex');
const WHISPER_URL = process.env.WHISPER_URL || 'http://172.18.0.1:9000/asr?language=es&output=json';
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://172.18.0.1:18789/v1/chat/completions';
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || '';
const TTS_VOICE = process.env.TTS_VOICE || 'es-AR-TomasNeural';
const TTS_ENGINE = process.env.TTS_ENGINE || 'edge'; // 'edge' or 'xtts'
const XTTS_URL = process.env.XTTS_URL || 'http://127.0.0.1:5002';
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
      const langPart = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nes`);
      const fmtPart = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson`);
      const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
      const body = Buffer.concat([header, audio, langPart, fmtPart, footer]);
      const res = await httpReq(url, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
      }, body);
      if (res.status === 200) {
        if (_whisperApi !== 'openai') { _whisperApi = 'openai'; console.log('🎤 Using OpenAI-compatible Whisper API'); }
        return JSON.parse(res.body.toString()).text || '';
      }
    } catch (e) {
      if (_whisperApi === 'openai') throw e;
    }
  }

  // Original API (/asr)
  const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio_file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`);
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, audio, footer]);
  const res = await httpReq(WHISPER_URL, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
  }, body);
  if (_whisperApi !== 'original') { _whisperApi = 'original'; console.log('🎤 Using original Whisper API (/asr)'); }
  return JSON.parse(res.body.toString()).text || '';
}

/** Filter out Whisper hallucinations and garbage transcriptions */
function isGarbageTranscription(text) {
  const t = text.trim();
  if (t.length < 2) return true;
  const words = t.split(/\s+/);
  if (words.length < 2) return false;
  const nonsense = /(?:psychiatric|exchange|itísmo|oxpor|lunar bar|virgen hay una casa)/i;
  if (nonsense.test(t)) return true;
  const unique = new Set(words.map(w => w.toLowerCase()));
  if (words.length > 8 && unique.size / words.length < 0.4) return true;
  // Mixed languages (Spanish + random English = likely hallucination)
  const englishWords = t.match(/\b(?:the|is|are|was|were|have|has|this|that|with|from|they|their|there|which|would|could|should|about|been|into|than|just|over|also|after|before|between|through)\b/gi);
  const spanishWords = t.match(/\b(?:que|los|las|del|por|una|con|para|como|más|pero|hay|está|son|tiene|puede|este|esta|ese|esa|todo|muy|bien|sin|sobre|entre)\b/gi);
  if (englishWords && spanishWords && englishWords.length > 2 && spanishWords.length > 2) return true;
  return false;
}

// ─── TTS Engine ─────────────────────────────────────────────────────────────

/**
 * Generate TTS audio from text.
 * Supports two engines via TTS_ENGINE env var:
 * - 'edge': Edge TTS (cloud, free, good quality, ~300-800ms)
 * - 'xtts': Coqui XTTS v2 (local GPU, voice cloning, ~200-500ms on RTX 3090)
 * @returns {Buffer} Audio data (MP3 for edge, WAV for xtts)
 */
function generateTTS(text) {
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

// ─── Streaming LLM ─────────────────────────────────────────────────────────

/**
 * Stream a chat completion from the LLM gateway.
 * Calls onSentence for each complete sentence detected in the stream,
 * and onDone when the stream finishes (with the full response text).
 *
 * @param {object} opts - { messages: [...] }
 * @param {function} onSentence - Called with each sentence fragment
 * @param {function} onDone - Called with (fullResponse, error?)
 * @param {AbortSignal} signal - For cancellation/barge-in
 */
async function streamAI(opts, onSentence, onDone, signal) {
  const messages = opts.messages;
  if (!messages) {
    onDone('', new Error('Invalid input to streamAI'));
    return;
  }

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

            // Split on sentence boundaries, also splitting before [[emotion: tags
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

  // Auto-search: inject web results if the message looks like it needs them
  if (needsSearch(text)) {
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
          const audioData = generateTTS(cleanSentence);
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

  // Track partial response for barge-in (updated by the stream)
  // We piggyback on the fullResponse in the onDone callback above
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
          const audioData = generateTTS(cleanSentence);
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

// Throttle: only 1 ambient transcription at a time
let _ambientBusy = false;

/** Handle ambient (always-listening) audio: transcribe, identify speaker, decide whether to respond */
async function handleAmbientAudio(ws, audioBase64) {
  try {
    const audio = Buffer.from(audioBase64, 'base64');
    if (audio.length < 1000) return;

    if (_ambientBusy) return; // Drop if Whisper can't keep up
    _ambientBusy = true;

    console.log(`🎧 Ambient audio: ${audio.length} bytes`);
    send(ws, { type: 'smart_status', status: 'transcribing' });

    const [text, speakerInfo] = await Promise.all([
      transcribe(audio),
      identifySpeaker(audio).catch(e => { console.error('Speaker ID failed:', e.message); return null; }),
    ]).finally(() => { _ambientBusy = false; });

    if (!text.trim() || isGarbageTranscription(text)) {
      send(ws, { type: 'smart_status', status: 'listening' });
      return;
    }

    const speaker = speakerInfo?.speaker || 'Unknown';
    const isKnown = speakerInfo?.known || false;
    const hasProfiles = speakerInfo?.hasProfiles ?? true;
    const isOwner = hasProfiles ? (speaker === OWNER_NAME) : true;

    console.log(`🎧 [${speaker}${isOwner ? ' 👑' : ''}${!hasProfiles ? ' (no-enroll)' : ''}]: "${text}"`);

    send(ws, { type: 'ambient_transcript', text, speaker, isOwner, isKnown });

    // Maintain ambient context window (last 5 minutes)
    if (!ws._ambientContext) ws._ambientContext = [];
    ws._ambientContext.push({ text, speaker, isOwner, time: Date.now() });
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    ws._ambientContext = ws._ambientContext
      .filter(c => c.time > fiveMinAgo)
      .slice(-MAX_CONTEXT_LINES);

    const botName = ws._botName || BOT_NAME;
    const decision = shouldRespond(text, botName);
    const shouldReply = isOwner
      ? (decision.respond || text.length > 15)
      : decision.respond;

    if (shouldReply) {
      console.log(`🤖 Smart trigger: ${decision.reason || 'owner'} by ${speaker}`);

      const contextLines = ws._ambientContext.slice(0, -1);
      let contextPrompt = '';
      if (contextLines.length > 0) {
        contextPrompt = `[Ambient conversation context:\n${contextLines.map(c =>
          `- [${c.speaker}${c.isOwner ? ' (your owner, highest priority)' : ''}]: "${c.text}"`
        ).join('\n')}\n]\n\n`;
      }

      const speakerLabel = isOwner ? `${speaker} (your owner)` : speaker;
      const fullPrompt = contextPrompt + `[${speakerLabel} just said: "${text}"]`;

      send(ws, { type: 'status', status: 'thinking' });
      send(ws, { type: 'transcript', text: `[${speaker}] ${text}` });
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

function handleTestEmotions(ws) {
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
    const audio = generateTTS(fullText);
    if (audio) send(ws, { type: 'audio', data: audio.toString('base64') });
    send(ws, { type: 'status', status: 'idle' });
  } catch (e) {
    console.error('Demo error:', e.message);
    send(ws, { type: 'status', status: 'idle' });
  }
}

// ─── HTTP + WebSocket Server ────────────────────────────────────────────────

const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":"ok"}');
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
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
          send(ws, { type: 'profiles', profiles: result.profiles, count: result.count });
        });
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

      case 'ping':
        send(ws, { type: 'pong' });
        break;
    }
  });

  ws.on('close', () => {
    clearTimeout(authTimer);
    if (ws._sessionId && sessions.has(ws._sessionId)) {
      saveWsToSession(ws, sessions.get(ws._sessionId));
      expireSession(ws._sessionId);
      console.log(`🔌 WS disconnected (session ${ws._sessionId.slice(0, 8)} saved, ${ws._sendBuffer?.length || 0} msgs buffered)`);
    } else {
      console.log('🔌 WS disconnected');
    }
  });
});

httpServer.listen(PORT, '0.0.0.0', () => console.log(`✅ Voice WS server on 0.0.0.0:${PORT}`));
