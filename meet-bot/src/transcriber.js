const { EventEmitter } = require('events');
const http = require('http');
const https = require('https');
const config = require('./config');

const LOG = '[Transcriber]';

const SPEAKER_URL = process.env.SPEAKER_URL || 'http://127.0.0.1:3201';

class Transcriber extends EventEmitter {
  constructor(audioPipeline) {
    super();
    this.audioPipeline = audioPipeline;
    this.speakerIdEnabled = process.env.SPEAKER_ID !== 'false';
    this.buffer = Buffer.alloc(0);
    this.active = false;
    this.speechActive = false;
    this.silenceFrames = 0;
    this.SAMPLE_RATE = 16000;
    this.BYTES_PER_SAMPLE = 2;
    // Accumulate ~2.5s of audio before sending
    this.chunkBytes = Math.floor((config.vadChunkMs / 1000) * this.SAMPLE_RATE * this.BYTES_PER_SAMPLE);
    this.vadThreshold = config.vadThreshold;
    this.lastTranscript = '';
    this.consecutiveDuplicates = 0;
  }

  start() {
    if (this.active) return;
    this.active = true;
    console.log(LOG, `Started (threshold=${this.vadThreshold}, chunk=${config.vadChunkMs}ms)`);

    this.audioPipeline.on('audio', (chunk) => this._onAudio(chunk));
  }

  stop() {
    this.active = false;
    this.buffer = Buffer.alloc(0);
    this.audioPipeline.removeAllListeners('audio');
    console.log(LOG, 'Stopped');
  }

  _onAudio(chunk) {
    if (!this.active) return;

    // Calculate RMS energy
    const rms = this._calculateRMS(chunk);

    if (rms > this.vadThreshold) {
      if (!this.speechActive) {
        this.emit('voice-start');
      }
      this.speechActive = true;
      this.silenceFrames = 0;
      this.buffer = Buffer.concat([this.buffer, chunk]);
    } else if (this.speechActive) {
      this.silenceFrames++;
      this.buffer = Buffer.concat([this.buffer, chunk]);
      // ~500ms of silence = end of speech segment
      const silenceThreshold = Math.ceil(0.5 * this.SAMPLE_RATE * this.BYTES_PER_SAMPLE / chunk.length);
      if (this.silenceFrames >= silenceThreshold) {
        this.speechActive = false;
        this.silenceFrames = 0;
        this.emit('voice-end');
      }
    }

    // Send when we have enough buffered audio
    if (this.buffer.length >= this.chunkBytes && !this.speechActive) {
      const audioToSend = this.buffer;
      this.buffer = Buffer.alloc(0);
      this._transcribe(audioToSend);
    }

    // Safety: don't buffer more than 10s
    const maxBytes = 10 * this.SAMPLE_RATE * this.BYTES_PER_SAMPLE;
    if (this.buffer.length > maxBytes) {
      const audioToSend = this.buffer;
      this.buffer = Buffer.alloc(0);
      this.speechActive = false;
      this._transcribe(audioToSend);
    }
  }

  _calculateRMS(buffer) {
    let sum = 0;
    const samples = buffer.length / this.BYTES_PER_SAMPLE;
    for (let i = 0; i < buffer.length; i += this.BYTES_PER_SAMPLE) {
      const sample = buffer.readInt16LE(i) / 32768;
      sum += sample * sample;
    }
    return Math.sqrt(sum / samples);
  }

  async _transcribe(audioBuffer) {
    if (audioBuffer.length < this.SAMPLE_RATE * this.BYTES_PER_SAMPLE * 0.3) {
      return; // Skip very short clips (<300ms)
    }

    try {
      // Build WAV header
      const wavBuffer = this._pcmToWav(audioBuffer, this.SAMPLE_RATE, 1, 16);

      // Run Whisper + Speaker ID in parallel
      const whisperPromise = this._sendToWhisper(wavBuffer);
      const speakerPromise = this.speakerIdEnabled
        ? this._identifySpeaker(wavBuffer).catch(err => {
            if (!this._speakerWarnLogged) {
              console.warn(LOG, `Speaker ID unavailable: ${err.message}`);
              this._speakerWarnLogged = true;
            }
            return null;
          })
        : Promise.resolve(null);

      const [result, speaker] = await Promise.all([whisperPromise, speakerPromise]);

      if (!result || !result.text) return;

      const text = result.text.trim();
      if (!text) return;

      // Filter hallucinations
      if (this._isHallucination(text)) {
        return;
      }

      // Filter consecutive duplicates
      if (text === this.lastTranscript) {
        this.consecutiveDuplicates++;
        if (this.consecutiveDuplicates > 2) return;
      } else {
        this.consecutiveDuplicates = 0;
      }
      this.lastTranscript = text;

      const lang = result.language || null;

      // Self-introduction detection: "me llamo X" / "mi nombre es X" / "my name is X" / "I'm X"
      if (speaker) {
        this._detectSelfIntro(text, speaker);
      }

      console.log(LOG, `Transcript [${lang || '?'}] [${speaker || '?'}]: "${text}"`);
      this.emit('transcript', {
        text,
        timestamp: Date.now(),
        speaker,
        language: lang,
      });
    } catch (err) {
      console.error(LOG, 'Transcription error:', err.message);
    }
  }

  _detectSelfIntro(text, currentSpeakerId) {
    // Don't rename if already has a real name (not Speaker_X)
    if (!/^Speaker_\d+$/.test(currentSpeakerId)) return;

    // Only match EXPLICIT self-introductions — aggressive patterns cause too many false positives
    // For ambiguous cases, rely on AI rename via [RENAME:old:new] tags
    const patterns = [
      // "My name is X" / "Mi nombre es X" / "Me llamo X"
      /(?:my name is|mi nombre es|me llamo)\s+([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)/i,
      // "I'm X, nice to meet you" / "I'm X here"
      /(?:I'?m|i am)\s+([A-Z][a-z]+)[,.]?\s+(?:nice|here|speaking|and I)/i,
      // "Call me X"
      /(?:call me|they call me)\s+([A-Z][a-z]+)/i,
    ];

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (!match) continue;
      const name = match[1];
      // Skip common false positives
      const skipWords = [config.botName.toLowerCase(), 'ok', 'yeah', 'yes', 'no', 'hey', 'well', 'so', 'the', 'this', 'that', 'just', 'here', 'there', 'thanks', 'thank', 'sorry', 'sure', 'right', 'good', 'great', 'fine', 'bueno', 'bien', 'dale', 'claro', 'todo', 'hola', 'chau', 'not', 'like', 'ready', 'trying', 'two', 'three', 'four', 'five', 'validated', 'therefore', 'also', 'still', 'really', 'going', 'about', 'been', 'what', 'how', 'why', 'when', 'where', 'who'];
      if (skipWords.includes(name.toLowerCase())) continue;
      if (name.length < 2 || name.length > 20) continue;

      console.log(LOG, `Self-intro detected: "${currentSpeakerId}" → "${name}" (from: "${text.substring(0, 60)}")`);
      this._renameSpeaker(currentSpeakerId, name);
      break;
    }
  }

  _renameSpeaker(oldName, newName) {
    const url = new URL(SPEAKER_URL + '/rename');
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname,
      method: 'POST',
      headers: { 'X-Old-Name': oldName, 'X-New-Name': newName },
      timeout: 3000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => console.log(LOG, `Renamed: ${data}`));
    });
    req.on('error', (e) => console.warn(LOG, `Rename failed: ${e.message}`));
    req.end();
  }

  _isHallucination(text) {
    for (const pattern of config.hallucinationPatterns) {
      if (pattern.test(text)) return true;
    }
    if (text.length < 2) return true;
    return false;
  }

  _pcmToWav(pcmData, sampleRate, channels, bitsPerSample) {
    const byteRate = sampleRate * channels * bitsPerSample / 8;
    const blockAlign = channels * bitsPerSample / 8;
    const dataSize = pcmData.length;
    const header = Buffer.alloc(44);

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcmData]);
  }

  _identifySpeaker(wavBuffer) {
    return new Promise((resolve, reject) => {
      const url = new URL(SPEAKER_URL + '/identify');
      const req = http.request({
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'audio/wav',
          'Content-Length': wavBuffer.length,
        },
        timeout: 3000, // 3s max — don't block transcription
      }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            if (result.speaker) {
              resolve(result.speaker);
            } else {
              resolve(null);
            }
          } catch (e) {
            reject(new Error('Invalid speaker ID response'));
          }
        });
      });
      req.on('timeout', () => { req.destroy(); reject(new Error('Speaker ID timeout')); });
      req.on('error', reject);
      req.write(wavBuffer);
      req.end();
    });
  }

  _sendToWhisper(wavBuffer) {
    return new Promise((resolve, reject) => {
      const url = new URL(config.whisperUrl);
      // Use OpenAI-compatible API (/v1/audio/transcriptions)
      url.pathname = '/v1/audio/transcriptions';
      // Clear any /asr query params
      url.search = '';

      const boundary = '----FormBoundary' + Date.now().toString(16);
      const modelName = process.env.WHISPER_MODEL || 'Systran/faster-whisper-large-v3-turbo';
      const preamble = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`
      );
      const modelPart = Buffer.from(
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${modelName}`
      );
      const fmtPart = Buffer.from(
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\nverbose_json`
      );
      const epilogue = Buffer.from(`\r\n--${boundary}--\r\n`);
      const body = Buffer.concat([preamble, wavBuffer, modelPart, fmtPart, epilogue]);

      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': body.length,
        },
        timeout: 15000,
      };

      const client = url.protocol === 'https:' ? https : http;
      const req = client.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (e) {
            reject(new Error(`Invalid JSON from Whisper: ${data.substring(0, 200)}`));
          }
        });
      });

      req.on('timeout', () => { req.destroy(); reject(new Error('Whisper timeout')); });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}

module.exports = Transcriber;
