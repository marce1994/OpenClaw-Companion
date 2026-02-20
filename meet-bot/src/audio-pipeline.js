const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { writeFileSync, unlinkSync, mkdirSync } = require('fs');
const path = require('path');
const config = require('./config');

const LOG = '[Audio]';

class AudioPipeline extends EventEmitter {
  constructor() {
    super();
    this.capturing = false;
    this.parecProc = null;
    this.SAMPLE_RATE = 16000;
    this.CHANNELS = 1;
    this.BITS = 16;
    // Audio recording
    this.recordAudio = config.recordAudio;
    this.chunkIndex = 0;
    this.recordingDir = '';
  }

  /**
   * Start capturing audio from meet_capture.monitor via parec.
   * Emits 'audio' events with Buffer chunks (16-bit PCM 16kHz mono).
   */
  startCapture() {
    if (this.capturing) {
      console.log(LOG, 'Already capturing');
      return;
    }

    console.log(LOG, 'Starting audio capture from meet_capture.monitor...');

    // Setup audio recording if enabled
    if (this.recordAudio) {
      const dateStr = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 16);
      this.recordingDir = path.join(config.meetingsDir, `audio-${dateStr}`);
      mkdirSync(this.recordingDir, { recursive: true });
      this.chunkIndex = 0;
      console.log(LOG, `Audio recording enabled → ${this.recordingDir}`);
    }

    this.parecProc = spawn('parec', [
      '--device=meet_capture.monitor',
      '--rate=16000',
      '--channels=1',
      '--format=s16le',
      '--latency-msec=100',
    ]);

    this.capturing = true;

    // Buffer for recording: save every ~5s of audio as a WAV chunk
    let recordBuffer = Buffer.alloc(0);
    const recordChunkBytes = 5 * this.SAMPLE_RATE * this.BITS / 8 * this.CHANNELS;

    this.parecProc.stdout.on('data', (chunk) => {
      this.emit('audio', chunk);

      // Save audio chunks if recording is enabled
      if (this.recordAudio && this.recordingDir) {
        recordBuffer = Buffer.concat([recordBuffer, chunk]);
        if (recordBuffer.length >= recordChunkBytes) {
          const wavBuf = this._pcmToWav(recordBuffer);
          const chunkFile = path.join(this.recordingDir, `chunk-${String(this.chunkIndex).padStart(5, '0')}.wav`);
          try {
            writeFileSync(chunkFile, wavBuf);
            this.chunkIndex++;
          } catch (e) {
            console.error(LOG, 'Failed to save audio chunk:', e.message);
          }
          recordBuffer = Buffer.alloc(0);
        }
      }
    });

    this.parecProc.stderr.on('data', (data) => {
      const msg = data.toString().trim();
      if (msg) console.error(LOG, 'parec stderr:', msg);
    });

    this.parecProc.on('close', (code) => {
      console.log(LOG, `parec exited with code ${code}`);
      this.capturing = false;
      // Auto-restart if unexpected exit
      if (code !== 0 && code !== null) {
        console.log(LOG, 'Restarting capture in 2s...');
        setTimeout(() => this.startCapture(), 2000);
      }
    });

    this.parecProc.on('error', (err) => {
      console.error(LOG, 'parec error:', err.message);
      this.capturing = false;
    });
  }

  stopCapture() {
    if (this.parecProc) {
      console.log(LOG, 'Stopping capture...');
      this.parecProc.kill('SIGTERM');
      this.parecProc = null;
      this.capturing = false;
    }
  }

  _pcmToWav(pcmData) {
    const sampleRate = this.SAMPLE_RATE;
    const channels = this.CHANNELS;
    const bitsPerSample = this.BITS;
    const byteRate = sampleRate * channels * bitsPerSample / 8;
    const blockAlign = channels * bitsPerSample / 8;
    const dataSize = pcmData.length;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);
    return Buffer.concat([header, pcmData]);
  }

  /**
   * Inject audio into the TTS output sink so it reaches Meet as mic audio.
   * @param {Buffer} audioBuffer - Raw PCM 16-bit or WAV data
   * @param {string} format - 'pcm' for raw s16le 24kHz mono, 'wav' for WAV file
   */
  async injectAudio(audioBuffer, format = 'wav') {
    return new Promise((resolve, reject) => {
      if (!audioBuffer || audioBuffer.length === 0) {
        return resolve();
      }

      console.log(LOG, `Injecting ${(audioBuffer.length / 1024).toFixed(1)}KB audio (${format})...`);

      if (format === 'wav') {
        // Convert through ffmpeg first to ensure compatible WAV format for PulseAudio
        const tmpIn = `/tmp/tts_in_${Date.now()}.wav`;
        const tmpOut = `/tmp/tts_out_${Date.now()}.wav`;
        writeFileSync(tmpIn, audioBuffer);

        const ffmpeg = spawn('ffmpeg', [
          '-y', '-i', tmpIn,
          '-ar', '48000', '-ac', '1', '-f', 'wav', tmpOut,
        ], { stdio: ['ignore', 'ignore', 'ignore'] });

        ffmpeg.on('close', (ffCode) => {
          try { unlinkSync(tmpIn); } catch (e) {}
          if (ffCode !== 0) {
            try { unlinkSync(tmpOut); } catch (e) {}
            return reject(new Error(`ffmpeg conversion failed: code ${ffCode}`));
          }

          const proc = spawn('paplay', ['--device=tts_output', tmpOut]);
          proc.on('close', (code) => {
            try { unlinkSync(tmpOut); } catch (e) {}
            if (code === 0) resolve();
            else reject(new Error(`paplay exited with code ${code}`));
          });
          proc.on('error', (err) => {
            try { unlinkSync(tmpOut); } catch (e) {}
            reject(err);
          });
        });
      } else {
        // Raw PCM — pipe through ffmpeg to convert to WAV then paplay
        const ffmpeg = spawn('ffmpeg', [
          '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', 'pipe:0',
          '-f', 'wav', '-ar', '48000', '-ac', '1', 'pipe:1',
        ], { stdio: ['pipe', 'pipe', 'ignore'] });

        const paplay = spawn('paplay', [
          '--device=tts_output',
          '--raw',
          '--format=s16le',
          '--rate=48000',
          '--channels=1',
        ], { stdio: ['pipe', 'ignore', 'ignore'] });

        ffmpeg.stdout.pipe(paplay.stdin);
        ffmpeg.stdin.write(audioBuffer);
        ffmpeg.stdin.end();

        paplay.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`paplay exited with code ${code}`));
        });

        paplay.on('error', reject);
      }
    });
  }
}

module.exports = AudioPipeline;
