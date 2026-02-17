const { EventEmitter } = require('events');
const WebSocket = require('ws');
const http = require('http');
const crypto = require('crypto');
const config = require('./config');

const LOG = '[AI]';

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
    this.activeRun = null; // { text, onDone }
    this.accumulatedText = '';
    this.reconnectAttempts = 0;
    this.detectedLang = config.defaultLang || 'es'; // Current meeting language
    this.lastResponseTime = 0; // Cooldown tracking
    this.responseCooldownMs = 10000; // 10s cooldown after each response
    this.audioQueue = []; // FIFO queue for sequential audio playback
    this.playingAudio = false; // Mutex for audio injection
    this.speaking = false; // True while TTS is playing
  }

  setMeetingId(id) { this.meetingId = id; }

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

    // Step 2: connect response (hello-ok) — can come as standalone or wrapped in res
    if (msg.type === 'hello-ok' || (msg.type === 'res' && msg.ok && msg.payload?.type === 'hello-ok')) {
      this.connected = true;
      this.reconnectAttempts = 0;
      const info = msg.type === 'hello-ok' ? msg : msg.payload;
      console.log(LOG, `Authenticated (protocol v${info?.protocol || '?'}, server ${info?.server?.version || '?'})`);
      return;
    }

    // Error response (auth failure, etc.)
    if (msg.type === 'res' && msg.ok === false) {
      console.error(LOG, 'Request failed:', JSON.stringify(msg.error || msg.payload || msg));
      return;
    }

    // JSON-RPC response
    if (msg.type === 'res' && msg.id) {
      console.log(LOG, `RPC response id=${msg.id} ok=${msg.ok} payload=${JSON.stringify(msg.payload || {}).substring(0,200)}`);
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(msg.id);
        pending.resolve(msg.payload);
      }

      // If this is a chat.send response with text, handle it
      if (msg.payload?.text && this.processing) {
        console.log(LOG, `Got response text from RPC: "${msg.payload.text.substring(0,100)}"`);
        this._handleAIResponse(msg.payload.text);
      }
      return;
    }

    // Log all messages for debugging
    if (msg.type !== 'event' || !msg.event?.startsWith('tick')) {
      // Don't log ticks, log everything else
      if (msg.type === 'event') {
        console.log(LOG, `WS event: ${msg.event} payload=${JSON.stringify(msg.payload || {}).substring(0,150)}`);
      }
    }

    // Agent events (streaming response)
    if (msg.type === 'event') {
      const evt = msg.event;
      const p = msg.payload || {};

      // Filter by session key
      const sessionKey = `${config.gwSessionKey}-${this.meetingId || 'default'}`;
      if (evt.startsWith('agent.')) {
        console.log(LOG, `Event: ${evt} sessionKey=${p.sessionKey || '?'} expected=${sessionKey}`);
      }
      if (p.sessionKey && p.sessionKey !== sessionKey) return;

      // Handle both old-style (agent.lifecycle/agent.text.delta) and new-style (agent with stream/data)
      if (evt === 'agent.lifecycle' && p.phase === 'start') {
        this.accumulatedText = '';
        this.activeRun = { runId: p.runId };
      } else if (evt === 'agent.text.delta') {
        this.accumulatedText += (p.delta || '');
      } else if (evt === 'agent' && p.stream === 'lifecycle' && p.data?.phase === 'start') {
        this.accumulatedText = '';
        this.activeRun = { runId: p.runId };
        console.log(LOG, `Agent run started: ${p.runId}`);
      } else if (evt === 'agent' && p.stream === 'assistant' && p.data?.text) {
        // New-style agent event with cumulative text
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
      } else if (evt === 'agent.lifecycle' && p.phase === 'end') {
        const fullText = this.accumulatedText;
        this.accumulatedText = '';
        this.activeRun = null;
        if (fullText) {
          console.log(LOG, `AI response: "${fullText.substring(0, 100)}..."`);
          this._handleAIResponse(fullText);
        }
        this.processing = false;
      } else if (evt === 'agent.error' || (evt === 'agent' && p.stream === 'error')) {
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

    const text = entry.text.toLowerCase();
    const botName = config.botName.toLowerCase();

    const isSummary = /\b(resumen|summary|resumir)\b/i.test(text);
    // Match bot name + common Whisper mis-transcriptions
    const nameVariants = [botName, 'jervis', 'jarves', 'jarvis', 'shervis', 'charvis', 'jarviz', 'jarbi', 'jarby', 'yarvis', 'xervis', 'charbis', 'jarbis', 'chervis', 'gervis', 'harvis', 'charbi'];
    const nameMentioned = nameVariants.some(v => text.includes(v));

    // Cooldown check
    const now = Date.now();
    const inCooldown = (now - this.lastResponseTime) < this.responseCooldownMs;

    console.log(LOG, `Transcript: "${text.substring(0,60)}" name=${nameMentioned} processing=${this.processing} cooldown=${inCooldown} speaking=${this.speaking}`);

    if (this.processing || !this.connected) return;
    if (this.speaking && !nameMentioned) return; // Don't process while Jarvis is talking (echo)
    if (inCooldown && !nameMentioned) return; // Skip proactive during cooldown, but allow name mentions

    if (isSummary) {
      this._requestSummary();
    } else {
      // Unified proactive mode — AI decides whether to respond
      this._respondProactive(entry.text, nameMentioned);
    }
  }

  _respondProactive(transcriptText, nameMentioned = false) {
    if (this.processing) return;
    this.processing = true;

    const context = this.recentTranscripts.slice(-10).map(t => `[${t.speaker || '?'}]: ${t.text}`).join('\n');

    const nameHint = nameMentioned
      ? `Your name ("${config.botName}") was mentioned, but they might be talking ABOUT you, not TO you. Only respond if they're clearly addressing you or asking you something directly. `
      : '';

    const speakerRenameInstruction = `\nIf someone introduces themselves or you learn a speaker's name (e.g. "call me X", "that was Luke", "I'm Pablo"), include [RENAME:CurrentID:RealName] at the END of your response. Example: "Nice to meet you! [RENAME:Speaker_1:Luke]". Only use this when you're confident about the name.`;

    const backgroundContext = `\nBackground context: You are Jarvis, AI assistant for Pablo Bianco. Pablo is a full-stack developer based in Argentina (General Belgrano, Buenos Aires). He runs Digital Village (digitalvillage.com.au, digitalvillage.network). His wife Damaris runs Piel de Porcelana (Korean skincare). You run on a Dell XPS 15 with an RTX 3090 eGPU. You were built using OpenClaw. You know about Pablo's projects, infrastructure, and work context.`;

    const langInstruction = this.detectedLang === 'en'
      ? `You are in a Google Meet call as ${config.botName}. You hear the conversation. `
        + nameHint
        + `Only respond if you can add real value (answer a question, provide info, give an opinion when asked). `
        + `Keep it concise (1-3 sentences, it will be read aloud). Reply in English.\n`
        + `If the conversation doesn't need you, reply EXACTLY "SKIP" and nothing else.`
        + speakerRenameInstruction + backgroundContext
      : `Estás en una reunión de Google Meet como ${config.botName}. Escuchás la conversación. `
        + nameHint
        + `Solo respondé si podés aportar algo útil (responder una pregunta, dar info, opinar cuando te preguntan). `
        + `Sé conciso (1-3 oraciones, se va a leer en voz alta). Respondé en español.\n`
        + `Si la conversación no te necesita, respondé EXACTAMENTE "SKIP" y nada más.`
        + speakerRenameInstruction + backgroundContext;

    const prompt = `${langInstruction}\n\nContexto reciente:\n${context}\n\nÚltimo: "${transcriptText}"`;

    this._sendChat(prompt);
  }

  _requestSummary() {
    if (this.processing) return;
    this.processing = true;

    const transcript = this.memory.getFormattedTranscript();
    if (!transcript) {
      this.processing = false;
      return;
    }

    const langInstruction = this.detectedLang === 'en'
      ? 'Give a brief summary of this meeting so far. Mention key topics and decisions. Max 30 seconds spoken. Reply in English.'
      : 'Hacé un resumen breve de esta reunión hasta ahora. Mencioná los temas principales y decisiones tomadas. Máximo 30 segundos hablado. Respondé en español.';

    const prompt = `${langInstruction}

Transcripción:
${transcript}`;

    this._sendChat(prompt);
  }

  _sendChat(message) {
    console.log(LOG, `Sending chat (connected=${this.connected}): "${message.substring(0,80)}..."`);
    if (!this.connected) {
      console.error(LOG, 'Not connected to Gateway');
      this.processing = false;
      return;
    }

    const sessionKey = `${config.gwSessionKey}-${this.meetingId || 'default'}`;
    const id = this._nextId();

    // Store pending request to handle response
    this.pendingRequests.set(id, {
      resolve: (payload) => {
        console.log(LOG, `chat.send response received`);
      },
      timeout: setTimeout(() => {
        console.log(LOG, 'chat.send timeout — resetting processing');
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

    // Safety: reset processing after 30s if no response
    setTimeout(() => {
      if (this.processing) {
        console.log(LOG, 'Processing timeout — resetting');
        this.processing = false;
      }
    }, 30000);
  }

  async _handleAIResponse(text) {
    try {
      // Skip if AI decided not to respond
      if (text.trim() === 'SKIP' || text.trim() === 'NO_REPLY' || text.trim() === 'HEARTBEAT_OK') {
        console.log(LOG, 'AI skipped (no relevant response)');
        this.processing = false;
        this.emit('skip');
        return;
      }
      this.lastResponseTime = Date.now(); // Start cooldown

      // Extract and process [RENAME:OldName:NewName] tags
      const renamePattern = /\[RENAME:([^\]:]+):([^\]]+)\]/g;
      let renameMatch;
      while ((renameMatch = renamePattern.exec(text)) !== null) {
        const [, oldName, newName] = renameMatch;
        console.log(LOG, `AI rename: "${oldName}" → "${newName}"`);
        this._renameSpeaker(oldName.trim(), newName.trim());
      }
      // Strip rename tags from spoken text
      const spokenText = text.replace(/\s*\[RENAME:[^\]]+\]/g, '').trim();
      if (!spokenText) {
        this.processing = false;
        return;
      }

      const audioBuffer = await this._getTTS(spokenText);
      if (audioBuffer?.length > 0) {
        this.audioQueue.push({ audio: audioBuffer, text: spokenText });
        this._drainQueue();
      } else {
        this.memory.addEntry({ text: spokenText, timestamp: Date.now(), speaker: config.botName });
        this.emit('response', { text: spokenText });
      }
    } catch (err) {
      console.error(LOG, 'Failed to handle response:', err.message);
    }
  }

  async _drainQueue() {
    if (this.playingAudio) return; // Already draining
    this.playingAudio = true;

    while (this.audioQueue.length > 0) {
      const { audio, text } = this.audioQueue.shift();
      try {
        this.speaking = true;
        this.emit('speaking-start');
        await this.audioPipeline.injectAudio(audio, 'wav');
        this.emit('speaking-end');
        this.speaking = false;
        console.log(LOG, 'Audio played from queue');

        this.memory.addEntry({ text, timestamp: Date.now(), speaker: config.botName });
        this.emit('response', { text });
      } catch (err) {
        console.error(LOG, 'Audio playback error:', err.message);
        this.speaking = false;
        this.emit('speaking-end');
      }
    }

    this.playingAudio = false;
  }

  _renameSpeaker(oldName, newName) {
    const speakerUrl = process.env.SPEAKER_URL || 'http://127.0.0.1:3201';
    const url = new URL(speakerUrl + '/rename');
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname,
      method: 'POST',
      headers: { 'X-Old-Name': oldName, 'X-New-Name': newName },
      timeout: 3000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => console.log(LOG, `Speaker renamed: ${data}`));
    });
    req.on('error', (e) => console.warn(LOG, `Rename failed: ${e.message}`));
    req.end();
  }

  async _getTTS(text) {
    try {
      if (config.ttsEngine === 'kokoro') {
        return await this._kokoroTTS(text);
      }
      return await this._edgeTTS(text);
    } catch (err) {
      console.error(LOG, `${config.ttsEngine} TTS error:`, err.message);
      if (config.ttsEngine === 'kokoro') {
        try { return await this._edgeTTS(text); } catch (e) { return null; }
      }
      return null;
    }
  }

  /** Kokoro TTS — supports both FastAPI (OpenAI-compatible) and legacy Flask */
  _kokoroTTS(text) {
    return new Promise((resolve, reject) => {
      const url = new URL(config.kokoroUrl);
      const voice = this.detectedLang === 'en' ? config.kokoroVoiceEn : config.kokoroVoice;
      // Try OpenAI-compatible API first (Kokoro-FastAPI)
      const body = JSON.stringify({ model: 'kokoro', input: text, voice, response_format: 'wav', speed: 1.0 });
      const req = http.request({
        hostname: url.hostname, port: url.port,
        path: '/v1/audio/speech', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 30000,
      }, (res) => {
        if (res.statusCode === 404 || res.statusCode === 405) {
          // Fall back to legacy Flask API
          console.log('[meet] Kokoro-FastAPI not found, falling back to legacy /tts');
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
