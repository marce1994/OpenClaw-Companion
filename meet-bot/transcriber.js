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
      const result = await this._sendToWhisper(wavBuffer);

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

      // Speaker identification — send audio chunk to speaker service
      let speaker = null;
      if (this.speakerIdEnabled) {
        try {
          speaker = await this._identifySpeaker(wavBuffer);
        } catch (err) {
          // Non-fatal — continue without speaker ID
          if (!this._speakerWarnLogged) {
            console.warn(LOG, `Speaker ID unavailable: ${err.message}`);
            this._speakerWarnLogged = true;
          }
        }
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
        `\r\n--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson`
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
