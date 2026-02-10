const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '3200', 10);
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'jarvis-voice-' + crypto.randomBytes(8).toString('hex');
const WHISPER_URL = process.env.WHISPER_URL || 'http://172.18.0.1:9000/asr?language=es&output=json';
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://172.18.0.1:18789/v1/chat/completions';
const GATEWAY_TOKEN = process.env.GATEWAY_TOKEN || '';
const TTS_VOICE = process.env.TTS_VOICE || 'es-AR-TomasNeural';

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5MB
const TEXT_FILE_EXTENSIONS = new Set(['txt', 'md', 'json', 'csv', 'js', 'py', 'html', 'css', 'xml', 'yaml', 'yml', 'log']);
const BOT_NAME = (process.env.BOT_NAME || 'jarvis').toLowerCase();
const MAX_CONTEXT_LINES = 20; // Max ambient context lines to keep
const SPEAKER_URL = process.env.SPEAKER_URL || 'http://127.0.0.1:3201';
const OWNER_NAME = process.env.OWNER_NAME || 'Pablo';

console.log(`🎙️ Voice WS server starting on port ${PORT}`);
console.log(`🔑 Token: ${AUTH_TOKEN}`);

// --- Speaker Identification ---

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

// --- Web Search ---

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

// --- Helpers ---

function send(ws, obj) {
  try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch (e) {}
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

// --- Transcription ---

async function transcribe(audio) {
  const boundary = '----Boundary' + crypto.randomBytes(8).toString('hex');
  const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="audio_file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`);
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([header, audio, footer]);
  const res = await httpReq(WHISPER_URL, {
    method: 'POST',
    headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length },
  }, body);
  return JSON.parse(res.body.toString()).text || '';
}

function isGarbageTranscription(text) {
  const t = text.trim();
  // Too short (likely noise)
  if (t.length < 2) return true;
  // Too many unique/rare words (hallucination pattern)
  const words = t.split(/\s+/);
  if (words.length < 2) return false;
  // High ratio of non-Spanish/nonsense words
  const nonsense = /(?:psychiatric|exchange|itísmo|oxpor|lunar bar|virgen hay una casa)/i;
  if (nonsense.test(t)) return true;
  // Very low word-to-unique ratio with many words (repeated hallucination)
  const unique = new Set(words.map(w => w.toLowerCase()));
  if (words.length > 8 && unique.size / words.length < 0.4) return true;
  // Mixed languages (Spanish + random English = likely hallucination)
  const englishWords = t.match(/\b(?:the|is|are|was|were|have|has|this|that|with|from|they|their|there|which|would|could|should|about|been|into|than|just|over|also|after|before|between|through)\b/gi);
  const spanishWords = t.match(/\b(?:que|los|las|del|por|una|con|para|como|más|pero|hay|está|son|tiene|puede|este|esta|ese|esa|todo|muy|bien|sin|sobre|entre)\b/gi);
  if (englishWords && spanishWords && englishWords.length > 2 && spanishWords.length > 2) return true;
  return false;
}

// --- TTS ---

function generateTTS(text) {
  const ttsFile = `/tmp/tts-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const textFile = `${ttsFile}.txt`;
  fs.writeFileSync(textFile, text);
  try {
    execSync(`edge-tts --voice "${TTS_VOICE}" --file "${textFile}" --write-media "${ttsFile}.mp3" 2>/dev/null`, { timeout: 30000 });
  } finally {
    try { fs.unlinkSync(textFile); } catch(e) {}
  }
  const data = fs.readFileSync(`${ttsFile}.mp3`);
  try { fs.unlinkSync(`${ttsFile}.mp3`); } catch(e) {}
  return data;
}

// --- Emotion ---

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

function analyzeEmotion(text) {
  const t = text.toLowerCase();
  // Laughing - strongest match first
  if (/(?:jajaja|jejeje|jijiji|muerto de risa|me meo|no puedo más|😂|🤣|💀)/i.test(t)) return 'laughing';
  if (/(?:jaja|jeje|ja ja|je je)/i.test(t)) return 'laughing';
  // Angry
  if (/(?:furioso|enojado|enoja|molesto|molesta|terrible|horrible|odio|bronca|rabia|mierda|carajo|puta|qué porquería)/i.test(t)) return 'angry';
  // Sad
  if (/(?:triste|tristeza|lamento|lo siento|perdón|perdona|pena|doloroso|melanc|extraño|llorar|lágrima|duele|sufr|😢|😭)/i.test(t)) return 'sad';
  // Surprised
  if (/(?:wow|guau|no puedo creer|sorprendente|impresionante|asombroso|en serio|increíble|no sabía|mirá vos|enserio|posta|😮|😲|🤯)/i.test(t)) return 'surprised';
  // Love
  if (/(?:amor|te quiero|te amo|cariño|hermoso|hermosa|precioso|preciosa|adorable|corazón|❤|💕|😍|🥰)/i.test(t)) return 'love';
  // Happy
  if (/(?:gracioso|divertido|genial|excelente|fantástico|contento|feliz|alegr|me encanta|perfecto|buenísimo|bárbaro|copado|zarpado|macanudo|piola|bien ahí|dale|vamos|sí señor|😊|😁|🎉)/i.test(t)) return 'happy';
  // Confused
  if (/(?:no entiendo|confuso|confusa|raro|no sé|complicado|qué onda|ni idea|me perdí|🤔)/i.test(t)) return 'confused';
  // Thinking
  if (/(?:hmm|veamos|déjame pensar|dejame pensar|a ver|interesante|curioso|me pregunto|quizás|tal vez|puede ser|depende|habría que ver)/i.test(t)) return 'thinking';
  // Fallback patterns
  if (/[?¿].*[?¿]/.test(text)) return 'confused';  // Multiple question marks
  if (/[?¿]/.test(text)) return 'thinking';
  if (/[!¡].*[!¡]/.test(text)) return 'surprised';  // Multiple exclamations
  if (/[!¡]/.test(text)) return 'happy';
  // Sentiment by sentence structure
  if (/(?:bueno|listo|dale|ok|okey|claro|sí|seguro)/i.test(t)) return 'happy';
  if (/(?:no |nunca|tampoco|nada|nadie)/i.test(t)) return 'neutral';
  return 'neutral';
}

function extractEmotion(text) {
  const match = text.match(/\[\[emotion:(\w+)\]\]/);
  const emotion = match ? match[1] : null;
  const cleanText = text.replace(/\[\[emotion:\w+\]\]\s*/g, '').trim();
  return { emotion, text: cleanText };
}

// --- Buttons parsing ---

function extractButtons(text) {
  const match = text.match(/\[\[buttons:([^\]]+)\]\]/);
  if (!match) return { text, buttons: null };
  const options = match[1].split('|').map(o => o.trim()).filter(Boolean).map(o => ({ text: o, value: o.toLowerCase() }));
  const cleanText = text.replace(/\[\[buttons:[^\]]+\]\]\s*/g, '').trim();
  return { text: cleanText, buttons: options.length > 0 ? options : null };
}

// --- Artifact extraction ---

function extractArtifacts(text) {
  const artifacts = [];
  const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
  let match;
  let cleanText = text;

  // Collect all code blocks that are long enough
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
      // Replace the code block with a reference
      cleanText = cleanText.replace(match[0], '');
    }
  }

  // Clean up extra whitespace from removals
  if (artifacts.length > 0) {
    cleanText = cleanText.replace(/\n{3,}/g, '\n\n').trim();
    // If text ends with something like "Here's the code:" followed by nothing, keep it
    if (!cleanText) cleanText = "Here's the code:";
  }

  return { text: cleanText, artifacts };
}

// --- Streaming LLM (using native fetch) ---
// Accepts either a text string (backward compat) or a messages array via opts.messages

async function streamAI(textOrOpts, onSentence, onDone, signal) {
  let messages;

  if (typeof textOrOpts === 'string') {
    // Backward compatible: text string
    messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: textOrOpts },
    ];
  } else if (textOrOpts && textOrOpts.messages) {
    // Multimodal: caller provides full messages array
    messages = textOrOpts.messages;
  } else {
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

            const sentenceRegex = /^(.*?[.!?])(\s+|\s*\[\[emotion:)/;
            let match;
            while ((match = buffer.match(sentenceRegex))) {
              const sentence = match[1].trim();
              if (sentence) onSentence(sentence);
              buffer = buffer.slice(match[1].length).trim();
            }
          }
        } catch (e) { /* ignore */ }
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

// --- Handle text (streaming) ---

// Detect if a message needs web search
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

// Extract search query from natural language
function extractSearchQuery(text) {
  // Remove common prefixes
  let q = text
    .replace(/^(?:busca|buscame|googlea|search|averigua|investiga|fijate)\s+/i, '')
    .replace(/^(?:que|quien|como|cuando|donde|what|who|how|when|where)\s+(?:es|son|fue|sera|is|are|was)\s+/i, '')
    .replace(/^(?:sobre|de|about|acerca de)\s+/i, '')
    .trim();
  // If too long, just use first ~60 chars
  if (q.length > 80) q = q.substring(0, 80);
  return q || text.substring(0, 60);
}

async function handleTextMessage(ws, text, prefix) {
  if (text.toLowerCase().replace(/[^a-záéíóú ]/g, '').includes('test emocion')) {
    handleTestEmotions(ws);
    return;
  }

  const ac = new AbortController();
  ws._abortController = ac;
  send(ws, { type: 'status', status: 'thinking' });

  let fullText = prefix ? `${prefix} ${text}` : text;

  // Auto-search: if the message looks like it needs web info
  if (needsSearch(text)) {
    const query = extractSearchQuery(text);
    console.log(`🔍 Auto-search: "${query}"`);
    const results = await webSearch(query, 5);
    if (results && results.length > 0) {
      const searchContext = results.map((r, i) =>
        `[${i+1}] ${r.title}: ${r.body || r.href}`
      ).join('\n');
      fullText += `\n\n[Web search results for "${query}":\n${searchContext}\n]\nUse these results to answer. Cite sources briefly if relevant.`;
      console.log(`🔍 Injected ${results.length} search results`);
    }
  }

  let sentenceIndex = 0;
  let firstSentence = true;
  const sentencePromises = [];

  console.log(`🔄 Streaming: "${text.substring(0, 60)}"`);

  streamAI(fullText,
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

      // Extract and send artifacts (code blocks > 200 chars)
      const { text: textWithoutArtifacts, artifacts } = extractArtifacts(cleanFull);
      for (const artifact of artifacts) {
        send(ws, { type: 'artifact', ...artifact });
      }

      // Extract and send buttons
      const { text: finalText, buttons } = extractButtons(textWithoutArtifacts);
      if (buttons) {
        send(ws, { type: 'buttons', options: buttons });
      }

      console.log(`🤖 Done: "${(finalText || cleanFull).substring(0, 80)}"`);
      send(ws, { type: 'stream_done' });
      send(ws, { type: 'status', status: 'idle' });
      ws._abortController = null;
    },
    ac.signal
  );
}

// --- Handle multimodal streaming (shared by image/file) ---

function handleMultimodalMessage(ws, messages, logPrefix) {
  const ac = new AbortController();
  ws._abortController = ac;
  send(ws, { type: 'status', status: 'thinking' });

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

      console.log(`🤖 Done: "${(finalText || cleanFull).substring(0, 80)}"`);
      send(ws, { type: 'stream_done' });
      send(ws, { type: 'status', status: 'idle' });
      ws._abortController = null;
    },
    ac.signal
  );
}

// --- Handle image message ---

function handleImageMessage(ws, msg) {
  const caption = msg.text || 'Describe this image';
  const mimeType = msg.mimeType || 'image/jpeg';
  const dataUrl = `data:${mimeType};base64,${msg.data}`;

  console.log(`🖼️ Image message: "${caption.substring(0, 60)}"`);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: dataUrl } },
        { type: 'text', text: caption },
      ],
    },
  ];

  handleMultimodalMessage(ws, messages, `Image: "${caption.substring(0, 60)}"`);
}

// --- Handle file message ---

function handleFileMessage(ws, msg) {
  // Size check
  const dataSize = Buffer.byteLength(msg.data, 'base64');
  if (dataSize > MAX_FILE_SIZE) {
    send(ws, { type: 'error', message: 'File too large. Maximum size is 5MB.' });
    send(ws, { type: 'status', status: 'idle' });
    return;
  }

  // Extension check
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

// --- Handle audio ---

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

// --- Smart Listen Mode ---

function shouldRespond(text, botName) {
  const t = text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const name = botName.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  
  // Direct mention of bot name
  if (t.includes(name)) return { respond: true, reason: 'name' };
  
  // Common wake patterns (Spanish)
  if (/(?:^|\s)(oye?|che|ey|hey|hola|escucha|decime|contame|explicame|ayudame)/i.test(t) && t.length < 80) {
    return { respond: true, reason: 'wake_phrase' };
  }
  
  // Direct questions that seem directed at an assistant
  if (/(?:qué (?:opinas|pensás|decís|te parece)|(?:sabés|sabes) (?:algo|qué|si)|podés|podrías|me (?:ayudás|explicás|contás))/i.test(t)) {
    return { respond: true, reason: 'question' };
  }
  
  // "What do you think?" patterns
  if (/(?:vos qué|tu qué|y vos|qué onda con|dale tu opinión)/i.test(t)) {
    return { respond: true, reason: 'opinion_request' };
  }
  
  return { respond: false };
}

async function handleAmbientAudio(ws, audioBase64) {
  try {
    const audio = Buffer.from(audioBase64, 'base64');
    if (audio.length < 1000) return; // Too short, skip
    
    console.log(`🎧 Ambient audio: ${audio.length} bytes`);
    send(ws, { type: 'smart_status', status: 'transcribing' });
    
    // Transcribe and identify speaker in parallel (speaker ID is best-effort)
    const [text, speakerInfo] = await Promise.all([
      transcribe(audio),
      identifySpeaker(audio).catch(e => { console.error('Speaker ID failed:', e.message); return null; }),
    ]);
    
    if (!text.trim() || isGarbageTranscription(text)) {
      send(ws, { type: 'smart_status', status: 'listening' });
      return;
    }
    
    const speaker = speakerInfo?.speaker || 'Unknown';
    const isOwner = speaker === OWNER_NAME;
    const isKnown = speakerInfo?.known || false;
    
    console.log(`🎧 [${speaker}${isOwner ? ' 👑' : ''}]: "${text}"`);
    
    // Send transcript to app (with speaker info)
    send(ws, { type: 'ambient_transcript', text, speaker, isOwner, isKnown });
    
    // Store in ambient context
    if (!ws._ambientContext) ws._ambientContext = [];
    ws._ambientContext.push({ text, speaker, isOwner, time: Date.now() });
    const fiveMinAgo = Date.now() - 5 * 60 * 1000;
    ws._ambientContext = ws._ambientContext
      .filter(c => c.time > fiveMinAgo)
      .slice(-MAX_CONTEXT_LINES);
    
    // Decision: should we respond?
    const botName = ws._botName || BOT_NAME;
    const decision = shouldRespond(text, botName);
    
    // Owner (Pablo) → always respond if they say anything directed
    // Others → only respond if they mention bot name or ask directly
    const shouldReply = isOwner
      ? (decision.respond || text.length > 15)  // Owner: respond to most things
      : decision.respond;  // Others: only on explicit triggers
    
    if (shouldReply) {
      console.log(`🤖 Smart trigger: ${decision.reason || 'owner'} by ${speaker}`);
      
      // Build context-aware prompt with speaker labels
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

// --- Test emotions ---

function handleTestEmotions(ws) {
  console.log('🎭 Emotion demo!');
  const testCues = [
    { startMs: 0, endMs: 2500, text: "¡Hola! Soy feliz de verte.", emotion: "happy" },
    { startMs: 2500, endMs: 5000, text: "¡Wow, esto es increíble!", emotion: "surprised" },
    { startMs: 5000, endMs: 7500, text: "Jajaja, qué divertido.", emotion: "laughing" },
    { startMs: 7500, endMs: 10000, text: "Hmm, déjame pensar.", emotion: "thinking" },
    { startMs: 10000, endMs: 12500, text: "No entiendo qué pasa.", emotion: "confused" },
    { startMs: 12500, endMs: 15000, text: "Esto me pone triste.", emotion: "sad" },
    { startMs: 15000, endMs: 17500, text: "¡Estoy furioso!", emotion: "angry" },
    { startMs: 17500, endMs: 20000, text: "Te quiero mucho.", emotion: "love" },
    { startMs: 20000, endMs: 22000, text: "Volvemos a la normalidad.", emotion: "neutral" },
  ];
  try {
    const fullText = testCues.map(c => c.text).join(' ');
    send(ws, { type: 'reply', text: '🎭 Demo de emociones' });
    send(ws, { type: 'status', status: 'speaking' });
    send(ws, { type: 'emotion_cues', cues: testCues });
    const audio = generateTTS(fullText);
    if (audio) send(ws, { type: 'audio', data: audio.toString('base64') });
    send(ws, { type: 'status', status: 'idle' });
  } catch(e) {
    console.error('Demo error:', e.message);
    send(ws, { type: 'status', status: 'idle' });
  }
}

// --- HTTP + WebSocket server ---

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

    if (!ws._authenticated) {
      if (msg.type === 'auth' && msg.token === AUTH_TOKEN) {
        ws._authenticated = true;
        clearTimeout(authTimer);
        console.log('🔓 Authenticated');
        send(ws, { type: 'auth', status: 'ok' });
      } else {
        send(ws, { type: 'error', message: 'Auth required' });
        ws.close();
      }
      return;
    }

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
        console.log('🚫 Cancel');
        if (ws._abortController) {
          ws._abortController.abort();
          ws._abortController = null;
        }
        send(ws, { type: 'status', status: 'idle' });
        break;
      case 'replay':
        if (ws._lastAudio) send(ws, { type: 'audio', data: ws._lastAudio });
        else send(ws, { type: 'error', message: 'No audio to replay' });
        break;
      case 'ping':
        send(ws, { type: 'pong' });
        break;
    }
  });

  ws.on('close', () => { clearTimeout(authTimer); console.log('🔌 WS disconnected'); });
});

httpServer.listen(PORT, '0.0.0.0', () => console.log(`✅ Voice WS server on 0.0.0.0:${PORT}`));

