const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { writeFileSync, unlinkSync } = require('fs');
const path = require('path');

const LOG = '[Audio]';

class AudioPipeline extends EventEmitter {
  constructor() {
    super();
    this.capturing = false;
    this.parecProc = null;
    this.SAMPLE_RATE = 16000;
    this.CHANNELS = 1;
    this.BITS = 16;
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

    this.parecProc = spawn('parec', [
      '--device=meet_capture.monitor',
      '--rate=16000',
      '--channels=1',
      '--format=s16le',
      '--latency-msec=100',
    ]);

    this.capturing = true;

    this.parecProc.stdout.on('data', (chunk) => {
      this.emit('audio', chunk);
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

      if (format === 'wav' || format === 'pcm') {
        // Stream PCM/WAV directly to paplay — no ffmpeg, no disk write
        const isPcm = format === 'pcm' || (audioBuffer.length > 4 && 
          audioBuffer[0] !== 0x52); // 0x52 = 'R' (RIFF header)
        
        const paplayArgs = isPcm 
          ? ['--device=tts_output', '--raw', '--format=s16le', '--rate=24000', '--channels=1']
          : ['--device=tts_output', '--raw', '--format=s16le', '--rate=24000', '--channels=1'];
        
        if (!isPcm) {
          // WAV file — play directly
          const tmpFile = `/tmp/tts_${Date.now()}.wav`;
          writeFileSync(tmpFile, audioBuffer);
          const proc = spawn('paplay', ['--device=tts_output', tmpFile]);
          proc.on('close', (code) => {
            try { unlinkSync(tmpFile); } catch (e) {}
            if (code === 0) resolve();
            else reject(new Error(`paplay exited with code ${code}`));
          });
          proc.on('error', (err) => {
            try { unlinkSync(tmpFile); } catch (e) {}
            reject(err);
          });
          return;
        }
        
        // Raw PCM — pipe directly to paplay (zero disk I/O)
        const proc = spawn('paplay', paplayArgs, { stdio: ['pipe', 'ignore', 'ignore'] });
        proc.stdin.write(audioBuffer);
        proc.stdin.end();
        proc.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`paplay exited with code ${code}`));
        });
        proc.on('error', reject);
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
