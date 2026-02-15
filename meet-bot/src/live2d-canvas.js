/**
 * Live2D Canvas — Renders Live2D model in a browser tab and provides
 * a MediaStream that gets injected as Chrome's camera feed into Meet.
 *
 * Architecture:
 * 1. Opens a hidden tab to http://localhost:{port}/live2d.html
 * 2. The page renders Live2D via PixiJS + pixi-live2d-display
 * 3. canvas.captureStream(30) provides a MediaStream
 * 4. getUserMedia override in Meet page returns this stream's video track
 * 5. Lip sync controlled via page.evaluate() calls
 */

const config = require('./config');
const LOG = '[Live2D]';

class Live2DCanvas {
  constructor() {
    this.active = false;
    this.page = null;       // Puppeteer page for Live2D rendering
    this.browser = null;
    this.modelName = config.live2dModel || 'Mao';
    this.lipSyncInterval = null;
  }

  /**
   * Start the Live2D renderer in a separate tab.
   * Must be called AFTER browser is launched but BEFORE joining Meet.
   * @param {import('puppeteer').Browser} browser
   */
  async start(browser) {
    this.browser = browser;

    try {
      this.page = await browser.newPage();
      await this.page.goto(
        `http://localhost:${config.meetPort}/live2d.html?model=${this.modelName}`,
        { waitUntil: 'networkidle2', timeout: 15000 }
      );

      // Wait for Live2D model to load
      await this.page.waitForFunction('window.isLive2DReady && window.isLive2DReady()', {
        timeout: 15000,
      });

      this.active = true;
      console.log(LOG, `Live2D model "${this.modelName}" loaded and rendering`);
    } catch (err) {
      console.error(LOG, 'Failed to start Live2D:', err.message);
      this.active = false;
    }
  }

  /**
   * After Meet joins, replace the video track with Live2D canvas stream.
   * This needs to be called from the Meet page context.
   * @param {import('puppeteer').Page} meetPage
   */
  async injectIntoMeet(meetPage) {
    if (!this.active || !this.page) {
      console.log(LOG, 'Live2D not active, skipping injection');
      return false;
    }

    try {
      // Step 1: In the Live2D page, create a peer connection sender
      // Step 2: In the Meet page, create a receiver
      // Actually, we can't share MediaStreams across pages directly.
      //
      // Better approach: Render Live2D directly in the Meet page.
      // We'll inject the Live2D scripts and model into Meet's page context.

      console.log(LOG, 'Injecting Live2D renderer into Meet page...');

      // Load Cubism core
      await meetPage.addScriptTag({
        url: `http://localhost:${config.meetPort}/live2d/live2dcubismcore.min.js`
      });

      // Load PixiJS
      await meetPage.addScriptTag({
        url: 'https://cdn.jsdelivr.net/npm/pixi.js@7.3.3/dist/pixi.min.js'
      });

      // Load pixi-live2d-display
      await meetPage.addScriptTag({
        url: 'https://cdn.jsdelivr.net/npm/pixi-live2d-display@0.4.0/dist/cubism4.min.js'
      });

      // Wait for libraries to load
      await meetPage.waitForFunction(() =>
        typeof PIXI !== 'undefined' && PIXI.live2d,
        { timeout: 10000 }
      );

      // Create Live2D canvas and replace video track
      const success = await meetPage.evaluate(async (modelName, port) => {
        try {
          const PIXI_L2D = PIXI.live2d;

          // Create offscreen canvas
          const canvas = document.createElement('canvas');
          canvas.width = 640;
          canvas.height = 480;
          canvas.style.position = 'fixed';
          canvas.style.top = '-9999px'; // Hidden
          canvas.style.left = '-9999px';
          document.body.appendChild(canvas);

          // Create PIXI app
          const app = new PIXI.Application({
            view: canvas,
            width: 640,
            height: 480,
            backgroundColor: 0x1a1a2e,
            autoStart: true,
            antialias: true,
          });

          // Load model
          const model = await PIXI_L2D.Live2DModel.from(
            `http://localhost:${port}/live2d/${modelName}/${modelName}.model3.json`,
            { autoInteract: false }
          );

          // Scale and position
          const scale = Math.min(480 / model.height, 640 / model.width) * 1.8;
          model.scale.set(scale);
          model.anchor.set(0.5, 0.5);
          model.x = 320;
          model.y = 300;

          app.stage.addChild(model);
          model.motion('Idle', 0, PIXI_L2D.MotionPriority.IDLE);

          // Lip sync state
          window._live2dModel = model;
          window._live2dApp = app;
          window._lipSyncValue = 0;
          window._targetLipSync = 0;

          app.ticker.add(() => {
            window._lipSyncValue += (window._targetLipSync - window._lipSyncValue) * 0.3;
            const coreModel = model.internalModel?.coreModel;
            if (coreModel) {
              const idx = coreModel.getParameterIndex('ParamA');
              if (idx >= 0) coreModel.setParameterValueByIndex(idx, window._lipSyncValue);
            }
          });

          // Capture stream from canvas
          const canvasStream = canvas.captureStream(30);
          const live2dTrack = canvasStream.getVideoTracks()[0];

          // Find all RTCPeerConnections and replace video tracks
          // Meet uses WebRTC — we need to find the senders
          // Control API
          window.setLipSync = (v) => { window._targetLipSync = Math.max(0, Math.min(1, v)); };
          window.setExpression = (name) => { model.expression(name); };
          window.playMotion = (group, idx) => { model.motion(group, idx || 0); };

          // Replace existing RTC video senders with Live2D track
          if (window._rtcSenders && window._rtcSenders.length > 0) {
            for (const sender of window._rtcSenders) {
              try {
                await sender.replaceTrack(live2dTrack);
                console.log('[Live2D] Replaced RTC sender track');
              } catch (e) {
                console.warn('[Live2D] Failed to replace sender track:', e.message);
              }
            }
          }

          // Also replace the original stream track so Meet's self-view shows Live2D
          if (window._meetVideoStream && window._meetVideoTrack) {
            try {
              window._meetVideoStream.removeTrack(window._meetVideoTrack);
              window._meetVideoStream.addTrack(live2dTrack);
              console.log('[Live2D] Replaced Meet self-view track');
            } catch (e) {
              console.warn('[Live2D] Could not replace self-view:', e.message);
            }
          }

          // Override future getUserMedia calls to return Live2D video
          const origGUM = navigator.mediaDevices._origGetUserMedia || navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
          navigator.mediaDevices.getUserMedia = async function(constraints) {
            const stream = await origGUM(constraints);
            if (constraints?.video) {
              const oldTrack = stream.getVideoTracks()[0];
              if (oldTrack) {
                stream.removeTrack(oldTrack);
                stream.addTrack(live2dTrack);
              }
            }
            return stream;
          };

          console.log('[Live2D] Renderer injected into Meet page');
          return true;
        } catch (err) {
          console.error('[Live2D] Injection error:', err.message);
          return false;
        }
      }, this.modelName, config.meetPort);

      if (success) {
        console.log(LOG, 'Successfully injected Live2D into Meet page');
        // Close the separate Live2D tab since we're rendering in Meet now
        if (this.page) {
          await this.page.close().catch(() => {});
          this.page = null;
        }
        return true;
      } else {
        console.error(LOG, 'Live2D injection returned false');
        return false;
      }

    } catch (err) {
      console.error(LOG, 'Failed to inject Live2D into Meet:', err.message);
      return false;
    }
  }

  /**
   * Set lip sync value (called during TTS playback)
   * @param {import('puppeteer').Page} meetPage
   * @param {number} value 0-1
   */
  async setLipSync(meetPage, value) {
    if (!this.active) return;
    try {
      await meetPage.evaluate((v) => {
        if (window.setLipSync) window.setLipSync(v);
      }, value);
    } catch (e) { /* page might be navigating */ }
  }

  /**
   * Start lip sync animation based on TTS audio
   * @param {import('puppeteer').Page} meetPage
   */
  startLipSync(meetPage) {
    if (this.lipSyncInterval) clearInterval(this.lipSyncInterval);

    // Simulate mouth movement — will be driven by actual audio RMS later
    let frame = 0;
    this.lipSyncInterval = setInterval(() => {
      frame++;
      // Simple sine wave for lip movement
      const value = Math.abs(Math.sin(frame * 0.3)) * 0.8 + Math.random() * 0.2;
      this.setLipSync(meetPage, value);
    }, 50); // 20fps lip sync
  }

  /**
   * Stop lip sync (mouth closes)
   * @param {import('puppeteer').Page} meetPage
   */
  stopLipSync(meetPage) {
    if (this.lipSyncInterval) {
      clearInterval(this.lipSyncInterval);
      this.lipSyncInterval = null;
    }
    this.setLipSync(meetPage, 0);
  }

  stop() {
    if (this.lipSyncInterval) {
      clearInterval(this.lipSyncInterval);
      this.lipSyncInterval = null;
    }
    if (this.page) {
      this.page.close().catch(() => {});
      this.page = null;
    }
    this.active = false;
  }
}

module.exports = Live2DCanvas;
