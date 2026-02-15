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
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 5000);
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
            id: 'meet-bot',
            displayName: 'OpenClaw Meet Bot',
            mode: 'backend',
            version: '1.0.0',
            platform: 'node',
          },
          auth: { token: config.gatewayToken },
        },
      });
      return;
    }

    // Step 2: connect response (hello-ok)
    if (msg.type === 'res' && msg.payload?.protocol) {
      this.connected = true;
      console.log(LOG, `Authenticated (protocol v${msg.payload.protocol})`);
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
      return;
    }

    // Agent events (streaming response)
    if (msg.type === 'event') {
      const evt = msg.event;
      const p = msg.payload || {};

      // Filter by session key
      const sessionKey = `${config.gwSessionKey}-${this.meetingId || 'default'}`;
      if (p.sessionKey && p.sessionKey !== sessionKey) return;

      if (evt === 'agent.lifecycle' && p.phase === 'start') {
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
        console.error(LOG, 'Agent error:', p.error);
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

    const text = entry.text.toLowerCase();
    const botName = config.botName.toLowerCase();

    const isSummary = /\b(resumen|summary|resumir)\b/i.test(text);
    const isTrigger = text.includes(botName);

    if (isSummary && isTrigger) {
      this._requestSummary();
    } else if (isTrigger) {
      this._respondToMention(entry.text);
    }
  }

  _respondToMention(triggerText) {
    if (this.processing) return;
    this.processing = true;

    const context = this.recentTranscripts
      .slice(-10)
      .map(t => `${t.speaker || 'Participant'}: ${t.text}`)
      .join('\n');

    const prompt = `Estás en una reunión de Google Meet como ${config.botName}. Alguien te mencionó. Respondé de forma natural y concisa (1-3 oraciones, se va a leer en voz alta).

Contexto reciente:
${context}

Mensaje que te mencionó: "${triggerText}"`;

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

    const prompt = `Hacé un resumen breve de esta reunión hasta ahora. Mencioná los temas principales y decisiones tomadas. Máximo 30 segundos hablado.

Transcripción:
${transcript}`;

    this._sendChat(prompt);
  }

  _sendChat(message) {
    if (!this.connected) {
      console.error(LOG, 'Not connected to Gateway');
      this.processing = false;
      return;
    }

    const sessionKey = `${config.gwSessionKey}-${this.meetingId || 'default'}`;
    const id = this._nextId();

    this._send({
      type: 'req',
      id,
      method: 'chat.send',
      params: {
        sessionKey,
        message,
        user: `meet-${this.meetingId || 'bot'}`,
      },
    });
  }

  async _handleAIResponse(text) {
    try {
      const audioBuffer = await this._getTTS(text);
      if (audioBuffer?.length > 0) {
        await this.audioPipeline.injectAudio(audioBuffer, 'wav');
        console.log(LOG, 'Audio injected into meeting');
      }

      this.memory.addEntry({
        text,
        timestamp: Date.now(),
        speaker: config.botName,
      });

      this.emit('response', { text });
    } catch (err) {
      console.error(LOG, 'Failed to handle response:', err.message);
    }
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

  _kokoroTTS(text) {
    return new Promise((resolve, reject) => {
      const url = new URL(config.kokoroUrl);
      const body = JSON.stringify({ text, voice: config.kokoroVoice, speed: 1.0 });
      const req = http.request({
        hostname: url.hostname, port: url.port,
        path: '/v1/audio/speech', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        timeout: 30000,
      }, (res) => {
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
    execSync(`edge-tts --voice "${config.ttsVoice}" --text "${text.replace(/"/g, '\\"')}" --write-media ${tmp} 2>/dev/null`, { timeout: 30000 });
    const buf = fs.readFileSync(tmp);
    try { fs.unlinkSync(tmp); } catch {}
    return buf;
  }
}

module.exports = AIResponder;
