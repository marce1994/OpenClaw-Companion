const { EventEmitter } = require('events');
const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');
const config = require('./config');

const LOG = '[AI]';

/** Simple Levenshtein distance for fuzzy name matching */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

/** Check if any word in text fuzzy-matches the bot name */
function fuzzyNameMatch(text, botName) {
  const name = botName.toLowerCase();
  const words = text.toLowerCase().replace(/[^a-záéíóúñü\s]/g, '').split(/\s+/).filter(w => w.length >= 3);
  
  // Also check 2-word combinations (e.g. "hey jarvis" → "jarvis")
  for (const word of words) {
    if (word === name) return true;
    // Allow up to 2 edits for names >= 5 chars, 1 edit for shorter
    const maxDist = name.length >= 5 ? 2 : 1;
    if (word.length >= name.length - 2 && word.length <= name.length + 2) {
      if (levenshtein(word, name) <= maxDist) return true;
    }
  }
  return false;
}

class AIResponder extends EventEmitter {
  constructor(audioPipeline, meetingMemory) {
    super();
    this.audioPipeline = audioPipeline;
    this.memory = meetingMemory;
    this.ws = null;
    this.connected = false;
    this.reconnectTimer = null;
    this.recentTranscripts = [];
    this.maxContext = 20;
    this.processing = false;
    this.meetingId = null;
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.activeRun = null;
    this.accumulatedText = '';
    this.reconnectAttempts = 0;
    this.detectedLang = config.defaultLang || 'es';
    this.lastResponseTime = 0;
    this.responseCooldownMs = 10000;
    this.audioQueue = [];
    this.playingAudio = false;
    
    // Transcript batching
    this.batchBuffer = [];
    this.batchTimer = null;
    this.batchWindowMs = 10000;
    
    // Session key for filtering events
    this._sessionKey = null;
    
    // Latency tracking
    this._chatSentAt = 0;  // When chat.send was called
    this._sttLatency = 0;  // Last STT latency
    this._aiLatency = 0;   // Last AI response latency
    this._ttsLatency = 0;  // Last TTS latency
  }

  setMeetingId(id) { 
    this.meetingId = id;
    this._sessionKey = `${config.gwSessionKey}-${id || 'default'}`;
  }

  _nextId() {
    return `meet-${++this.requestId}-${crypto.randomUUID().substring(0, 8)}`;
  }

  _send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  connect() {
    if (this.ws) return;
    console.log(LOG, `Connecting to Gateway at ${config.gatewayWsUrl}...`);

    this.ws = new WebSocket(config.gatewayWsUrl, {
      headers: { 'Origin': 'http://127.0.0.1:18789' },
    });

    this.ws.on('open', () => {
      console.log(LOG, 'WS open, waiting for challenge...');
    });

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this._handleMessage(msg);
      } catch (e) {
        console.error(LOG, 'Parse error:', e.message);
      }
    });

    this.ws.on('close', () => {
      console.log(LOG, 'Disconnected');
      this.connected = false;
      this.ws = null;
      this._scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error(LOG, 'WS error:', err.message);
    });
  }

  disconnect() {
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) { this.ws.close(); this.ws = null; }
    this.connected = false;
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    const delay = Math.min(5000 * Math.pow(1.5, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;
    console.log(LOG, `Reconnecting in ${(delay/1000).toFixed(1)}s (attempt ${this.reconnectAttempts})...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  _handleMessage(msg) {
    // Step 1: connect.challenge → send connect
    if (msg.type === 'event' && msg.event === 'connect.challenge') {
      console.log(LOG, 'Got challenge, authenticating...');
      this._send({
        type: 'req',
        id: this._nextId(),
        method: 'connect',
        params: {
          client: {
            id: 'gateway-client',
            displayName: 'OpenClaw Meet Bot',
            mode: 'backend',
            version: '1.0.0',
            platform: 'node',
          },
          role: 'operator',
          scopes: ['operator.admin'],
          minProtocol: 3,
          maxProtocol: 3,
          auth: { token: config.gatewayToken },
        },
      });
      return;
    }

    // Step 2: connect response (hello-ok)
    if (msg.type === 'hello-ok' || (msg.type === 'res' && msg.ok && msg.payload?.type === 'hello-ok')) {
      this.connected = true;
      this.reconnectAttempts = 0;
      const info = msg.type === 'hello-ok' ? msg : msg.payload;
      console.log(LOG, `Authenticated (protocol v${info?.protocol || '?'}, server ${info?.server?.version || '?'})`);
      return;
    }

    // Error response
    if (msg.type === 'res' && msg.ok === false) {
      console.error(LOG, 'Request failed:', JSON.stringify(msg.error || msg.payload || msg));
      return;
    }

    // JSON-RPC response
    if (msg.type === 'res' && msg.id) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(msg.id);
        pending.resolve(msg.payload);
      }

      if (msg.payload?.text && this.processing) {
        this._handleAIResponse(msg.payload.text);
      }
      return;
    }

    // Agent events (streaming response)
    if (msg.type === 'event') {
      const evt = msg.event;
      const p = msg.payload || {};

      // STRICT session filtering — only process events for OUR session
      if (p.sessionKey && this._sessionKey && p.sessionKey !== this._sessionKey) {
        return; // Silently ignore events from other sessions
      }

      if (evt === 'agent' && p.stream === 'lifecycle' && p.data?.phase === 'start') {
        this.accumulatedText = '';
        this.activeRun = { runId: p.runId };
        console.log(LOG, `Agent run started: ${p.runId}`);
      } else if (evt === 'agent' && p.stream === 'assistant' && p.data?.text) {
        this.accumulatedText = p.data.text;
        if (!this.activeRun) this.activeRun = { runId: p.runId };
      } else if (evt === 'agent' && p.stream === 'lifecycle' && p.data?.phase === 'end') {
        const fullText = this.accumulatedText;
        this.accumulatedText = '';
        this.activeRun = null;
        if (fullText) {
          console.log(LOG, `AI response: "${fullText.substring(0, 100)}..."`);
          this._handleAIResponse(fullText);
        }
        this.processing = false;
      } else if (evt === 'agent' && p.stream === 'error') {
        console.error(LOG, 'Agent error:', p.data);
        this.processing = false;
        this.accumulatedText = '';
      }
      // Old-style events (backwards compat)
      else if (evt === 'agent.lifecycle' && p.phase === 'start') {
        this.accumulatedText = '';
        this.activeRun = { runId: p.runId };
      } else if (evt === 'agent.text.delta') {
        this.accumulatedText += (p.delta || '');
      } else if (evt === 'agent.lifecycle' && p.phase === 'end') {
        const fullText = this.accumulatedText;
        this.accumulatedText = '';
        this.activeRun = null;
        if (fullText) {
          console.log(LOG, `AI response: "${fullText.substring(0, 100)}..."`);
          this._handleAIResponse(fullText);
        }
        this.processing = false;
      } else if (evt === 'agent.error') {
        console.error(LOG, 'Agent error:', p.error || p.data);
        this.processing = false;
        this.accumulatedText = '';
      }
    }
  }

  onTranscript(entry) {
    this.recentTranscripts.push(entry);
    if (this.recentTranscripts.length > this.maxContext) {
      this.recentTranscripts.shift();
    }

    // Use Whisper's language detection
    if (entry.language && entry.language !== this.detectedLang) {
      console.log(LOG, `Language switched: ${this.detectedLang} → ${entry.language}`);
      this.detectedLang = entry.language;
    }

    const text = entry.text;
    const isSummary = /\b(resumen|summary|resumir)\b/i.test(text);
    const nameMentioned = fuzzyNameMatch(text, config.botName);

    const now = Date.now();
    const inCooldown = (now - this.lastResponseTime) < this.responseCooldownMs;

    console.log(LOG, `Transcript: "${text.substring(0,80)}" name=${nameMentioned} processing=${this.processing} cooldown=${inCooldown} batch=${this.batchBuffer.length}`);

    if (this.processing || !this.connected) return;

    // Summary requests bypass batching
    if (isSummary) {
      this._flushBatch();
      this._requestSummary();
      return;
    }

    // Name mention → flush batch immediately and respond
    if (nameMentioned) {
      this._flushBatch();
      this._respondProactive(entry.text, true);
      return;
    }

    // During cooldown, just buffer (don't start timer)
    if (inCooldown) {
      this.batchBuffer.push({ text: entry.text, speaker: entry.speaker, timestamp: now });
      return;
    }

    // Add to batch buffer
    this.batchBuffer.push({ text: entry.text, speaker: entry.speaker, timestamp: now });

    // Start/reset batch timer
    if (this.batchTimer) clearTimeout(this.batchTimer);
    this.batchTimer = setTimeout(() => this._flushBatch(), this.batchWindowMs);
  }

  _flushBatch() {
    if (this.batchTimer) { clearTimeout(this.batchTimer); this.batchTimer = null; }
    if (this.batchBuffer.length === 0) return;
    if (this.processing) return;

    const combined = this.batchBuffer.map(b => `[${b.speaker || 'Unknown'}]: ${b.text}`).join('\n');
    const count = this.batchBuffer.length;
    this.batchBuffer = [];

    console.log(LOG, `Flushing batch: ${count} transcripts`);
    this._respondProactive(combined, false, true);
  }

  _respondProactive(transcriptText, nameMentioned = false, isBatched = false) {
    if (this.processing) return;
    this.processing = true;

    const context = this.recentTranscripts.slice(-10).map(t => `[${t.speaker || 'Unknown'}]: ${t.text}`).join('\n');

    const nameHint = nameMentioned
      ? `Your name ("${config.botName}") was mentioned — they're likely addressing you directly. Respond helpfully. `
      : '';

    const batchHint = isBatched
      ? `The following is a batch of recent conversation lines. Review them all and decide if you should contribute. `
      : '';

    const langInstruction = this.detectedLang === 'en'
      ? `You are in a Google Meet call as ${config.botName}. You hear the conversation. `
        + nameHint + batchHint
        + `Only respond if you can add real value (answer a question, provide info, give an opinion when asked). `
        + `Keep it concise (1-3 sentences, it will be read aloud). Reply in English.\n`
        + `If the conversation doesn't need you, reply EXACTLY "SKIP" and nothing else.`
      : `Estás en una reunión de Google Meet como ${config.botName}. Escuchás la conversación. `
        + nameHint + batchHint
        + `Solo respondé si podés aportar algo útil (responder una pregunta, dar info, opinar cuando te preguntan). `
        + `Sé conciso (1-3 oraciones, se va a leer en voz alta). Respondé en español.\n`
        + `Si la conversación no te necesita, respondé EXACTAMENTE "SKIP" y nada más.`;

    const lastLine = isBatched ? `Batch de transcripciones recientes:\n${transcriptText}` : `Último: "${transcriptText}"`;
    const prompt = `${langInstruction}\n\nContexto reciente:\n${context}\n\n${lastLine}`;

    this._sendChat(prompt);
  }

  _requestSummary() {
    if (this.processing) return;
    this.processing = true;

    const transcript = this.memory.getFormattedTranscript();
    if (!transcript) { this.processing = false; return; }

    const langInstruction = this.detectedLang === 'en'
      ? 'Give a brief summary of this meeting so far. Mention key topics and decisions. Max 30 seconds spoken. Reply in English.'
      : 'Hacé un resumen breve de esta reunión hasta ahora. Mencioná los temas principales y decisiones tomadas. Máximo 30 segundos hablado. Respondé en español.';

    this._sendChat(`${langInstruction}\n\nTranscripción:\n${transcript}`);
  }

  _sendChat(message) {
    this._chatSentAt = Date.now();
    console.log(LOG, `Sending chat (connected=${this.connected}): "${message.substring(0,80)}..."`);
    if (!this.connected) {
      console.error(LOG, 'Not connected to Gateway');
      this.processing = false;
      return;
    }

    const sessionKey = this._sessionKey || `${config.gwSessionKey}-${this.meetingId || 'default'}`;
    const id = this._nextId();

    this.pendingRequests.set(id, {
      resolve: () => {},
      timeout: setTimeout(() => {
        this.pendingRequests.delete(id);
        this.processing = false;
      }, 60000),
    });

    this._send({
      type: 'req',
      id,
      method: 'chat.send',
      params: {
        sessionKey,
        message,
        idempotencyKey: crypto.randomUUID(),
      },
    });

    setTimeout(() => {
      if (this.processing) {
        console.log(LOG, 'Processing timeout — resetting');
        this.processing = false;
      }
    }, 30000);
  }

  async _handleAIResponse(text) {
    this._aiLatency = this._chatSentAt ? Date.now() - this._chatSentAt : 0;
    
    if (text.trim() === 'SKIP' || text.trim() === 'NO_REPLY' || text.trim() === 'HEARTBEAT_OK') {
      console.log(LOG, 'AI skipped (no relevant response)');
      this.processing = false;
      this.emit('skip');
      return;
    }

    this.lastResponseTime = Date.now();

    this.audioQueue.push(text);
    console.log(LOG, `Queued response (queue size: ${this.audioQueue.length}): "${text.substring(0, 60)}..."`);
    this._drainQueue();
  }

  async _drainQueue() {
    if (this.playingAudio || this.audioQueue.length === 0) return;
    this.playingAudio = true;

    while (this.audioQueue.length > 0) {
      const text = this.audioQueue.shift();
      try {
        const ttsStart = Date.now();
        const audioBuffer = await this._getTTS(text);
        this._ttsLatency = Date.now() - ttsStart;
        const totalMs = this._aiLatency + this._ttsLatency;
        
        if (audioBuffer?.length > 0) {
          this.emit('speaking-start', { 
            sttMs: this._sttLatency, aiMs: this._aiLatency, 
            ttsMs: this._ttsLatency, totalMs, queueSize: this.audioQueue.length 
          });
          await this.audioPipeline.injectAudio(audioBuffer, 'wav');
          this.emit('speaking-end');
          console.log(LOG, `Audio played (${this.audioQueue.length} remaining) latency: AI=${this._aiLatency}ms TTS=${this._ttsLatency}ms Total=${totalMs}ms`);
        }

        this.memory.addEntry({
          text,
          timestamp: Date.now(),
          speaker: config.botName,
        });

        this.emit('response', { text });
      } catch (err) {
        console.error(LOG, 'Failed to play audio:', err.message);
        this.emit('speaking-end');
      }
    }

    this.playingAudio = false;
  }

  async _getTTS(text) {
    try {
      if (config.ttsEngine === 'kokoro') return await this._kokoroTTS(text);
      return await this._edgeTTS(text);
    } catch (err) {
      console.error(LOG, `${config.ttsEngine} TTS error:`, err.message);
      if (config.ttsEngine === 'kokoro') {
        try { return await this._edgeTTS(text); } catch (e) { return null; }
      }
      return null;
    }
  }

  _kokoroTTS(text) {
    return new Promise((resolve, reject) => {
      const url = new URL(config.kokoroUrl);
      const voice = this.detectedLang === 'en' ? config.kokoroVoiceEn : config.kokoroVoice;
      const body = JSON.stringify({ model: 'kokoro', input: text, voice, response_format: 'wav', speed: 1.0 });
      const req = http.request({
        hostname: url.hostname, port: url.port,
        path: '/v1/audio/speech', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 30000,
      }, (res) => {
        if (res.statusCode === 404 || res.statusCode === 405) {
          const legacyBody = JSON.stringify({ text, voice, lang: this.detectedLang, speed: 1.0 });
          const legacyReq = http.request({
            hostname: url.hostname, port: url.port,
            path: '/tts', method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(legacyBody) },
            timeout: 30000,
          }, (lRes) => {
            const chunks = [];
            lRes.on('data', c => chunks.push(c));
            lRes.on('end', () => resolve(Buffer.concat(chunks)));
          });
          legacyReq.on('error', reject);
          legacyReq.write(legacyBody);
          legacyReq.end();
          return;
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  _edgeTTS(text) {
    const { execSync } = require('child_process');
    const fs = require('fs');
    const tmp = `/tmp/tts_${Date.now()}.wav`;
    const voice = this.detectedLang === 'en' ? 'en-US-GuyNeural' : config.ttsVoice;
    execSync(`edge-tts --voice "${voice}" --text "${text.replace(/"/g, '\\"')}" --write-media ${tmp} 2>/dev/null`, { timeout: 30000 });
    const buf = fs.readFileSync(tmp);
    try { fs.unlinkSync(tmp); } catch {}
    return buf;
  }
}

module.exports = AIResponder;
