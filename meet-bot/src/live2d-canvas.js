/**
 * Live2D Canvas — Renders Live2D model in a separate browser tab,
 * captures the canvas as a video stream, and replaces Meet's camera track.
 *
 * Architecture:
 * 1. Opens a tab to http://localhost:{port}/live2d.html — renders model via PixiJS
 * 2. In live2d.html, captures canvas stream and creates an RTCPeerConnection offer
 * 3. In Meet page, creates RTCPeerConnection answer, receives the Live2D video track
 * 4. Replaces Meet's camera track with the Live2D track via RTCPeerConnection.getSenders()
 * 5. Lip sync controlled via page.evaluate() calls on live2d page
 */

const config = require('./config');
const LOG = '[Live2D]';

class Live2DCanvas {
  constructor() {
    this.active = false;
    this.page = null;
    this.browser = null;
    this.modelName = config.live2dModel || 'Mao';
  }

  async start(browser) {
    this.browser = browser;

    try {
      this.page = await browser.newPage();
      this.page.on('console', msg => console.log(LOG, `[page] ${msg.type()}: ${msg.text()}`));
      this.page.on('pageerror', err => console.error(LOG, `[page] ERROR: ${err.message}`));

      await this.page.goto(
        `http://localhost:${config.meetPort}/live2d.html?model=${this.modelName}`,
        { waitUntil: 'networkidle2', timeout: 15000 }
      );

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
   * Replace Meet's camera with Live2D canvas stream.
   * Uses CDP to bypass Meet's CSP — executes in Meet page context via
   * Runtime.evaluate with no CSP restrictions.
   */
  async injectIntoMeet(meetPage) {
    if (!this.active || !this.page) {
      console.log(LOG, 'Live2D not active, skipping injection');
      return false;
    }

    try {
      console.log(LOG, 'Setting up Live2D → Meet video bridge...');

      // Step 1: In Live2D page, capture canvas stream and create offer
      const offer = await this.page.evaluate(async () => {
        const canvas = document.getElementById('live2d-canvas');
        const stream = canvas.captureStream(30);
        const videoTrack = stream.getVideoTracks()[0];

        window._live2dPC = new RTCPeerConnection();
        window._live2dPC.addTrack(videoTrack, stream);

        const offerDesc = await window._live2dPC.createOffer();
        await window._live2dPC.setLocalDescription(offerDesc);

        // Wait for ICE candidates
        await new Promise(resolve => {
          if (window._live2dPC.iceGatheringState === 'complete') return resolve();
          window._live2dPC.addEventListener('icegatheringstatechange', () => {
            if (window._live2dPC.iceGatheringState === 'complete') resolve();
          });
          setTimeout(resolve, 3000); // Timeout fallback
        });

        return JSON.stringify(window._live2dPC.localDescription);
      });

      console.log(LOG, 'Live2D offer created');

      // Step 2: In Meet page, create answer and get the video track
      // Use CDP to bypass Trusted Types CSP
      const cdp = await meetPage.target().createCDPSession();

      const { result } = await cdp.send('Runtime.evaluate', {
        expression: `(async () => {
          const offer = JSON.parse(${JSON.stringify(offer)});
          
          window._receiverPC = new RTCPeerConnection();
          
          // Collect incoming track
          const trackPromise = new Promise(resolve => {
            window._receiverPC.ontrack = (e) => {
              window._live2dVideoTrack = e.track;
              resolve(e.track);
            };
          });
          
          await window._receiverPC.setRemoteDescription(offer);
          const answer = await window._receiverPC.createAnswer();
          await window._receiverPC.setLocalDescription(answer);
          
          // Wait for ICE
          await new Promise(resolve => {
            if (window._receiverPC.iceGatheringState === 'complete') return resolve();
            window._receiverPC.addEventListener('icegatheringstatechange', () => {
              if (window._receiverPC.iceGatheringState === 'complete') resolve();
            });
            setTimeout(resolve, 3000);
          });
          
          // Wait for track
          await trackPromise;
          
          return JSON.stringify(window._receiverPC.localDescription);
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });

      const answer = result.value;
      console.log(LOG, 'Meet answer created');

      // Step 3: Set answer on Live2D side
      await this.page.evaluate(async (answerStr) => {
        const answer = JSON.parse(answerStr);
        await window._live2dPC.setRemoteDescription(answer);
      }, answer);

      console.log(LOG, 'WebRTC bridge established');

      // Step 4: Replace Meet's camera track with the Live2D track
      const { result: replaceResult } = await cdp.send('Runtime.evaluate', {
        expression: `(async () => {
          const live2dTrack = window._live2dVideoTrack;
          if (!live2dTrack) return 'NO_TRACK';
          
          // Find all RTCPeerConnections and replace video senders
          // The getUserMedia override stored senders in window._rtcSenders
          const senders = window._rtcSenders || [];
          let replaced = 0;
          
          // Also check all PeerConnections
          const pcs = window._meetPeerConnections || [];
          for (const pc of pcs) {
            try {
              const videoSenders = pc.getSenders().filter(s => s.track?.kind === 'video');
              for (const sender of videoSenders) {
                await sender.replaceTrack(live2dTrack);
                replaced++;
              }
            } catch(e) {}
          }
          
          // Try stored senders too
          for (const sender of senders) {
            try {
              await sender.replaceTrack(live2dTrack);
              replaced++;
            } catch(e) {}
          }
          
          return replaced > 0 ? 'OK:' + replaced : 'NO_SENDERS';
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });

      console.log(LOG, `Track replacement result: ${replaceResult.value}`);
      await cdp.detach();

      if (replaceResult.value?.startsWith('OK')) {
        console.log(LOG, '✅ Live2D avatar is now the camera feed!');
        return true;
      } else {
        console.log(LOG, `⚠️ Track replacement: ${replaceResult.value}. Will retry when Meet creates senders.`);
        // Schedule retry — Meet might not have created PeerConnection yet
        this._scheduleRetry(meetPage);
        return false;
      }

    } catch (err) {
      console.error(LOG, 'Failed to inject Live2D into Meet:', err.message);
      return false;
    }
  }

  _scheduleRetry(meetPage) {
    let attempts = 0;
    const interval = setInterval(async () => {
      attempts++;
      if (attempts > 10) {
        clearInterval(interval);
        console.log(LOG, 'Gave up retrying track replacement');
        return;
      }
      try {
        const cdp = await meetPage.target().createCDPSession();
        const { result } = await cdp.send('Runtime.evaluate', {
          expression: `(async () => {
            const live2dTrack = window._live2dVideoTrack;
            if (!live2dTrack) return 'NO_TRACK';
            let replaced = 0;
            
            // Try stored senders
            for (const sender of (window._rtcSenders || [])) {
              try { await sender.replaceTrack(live2dTrack); replaced++; } catch(e) {}
            }
            
            // Also scan all PeerConnection instances
            for (const pc of (window._meetPeerConnections || [])) {
              try {
                for (const sender of pc.getSenders()) {
                  if (sender.track?.kind === 'video') {
                    await sender.replaceTrack(live2dTrack);
                    replaced++;
                  }
                }
              } catch(e) {}
            }
            
            return replaced > 0 ? 'OK:' + replaced : 'WAITING:pcs=' + (window._meetPeerConnections||[]).length + ',senders=' + (window._rtcSenders||[]).length;
          })()`,
          awaitPromise: true,
          returnByValue: true,
        });
        await cdp.detach();
        if (result.value?.startsWith('OK')) {
          clearInterval(interval);
          console.log(LOG, `✅ Live2D track replaced on retry #${attempts}`);
        }
      } catch (e) {}
    }, 3000);
  }

  async startSpeaking() {
    if (!this.active || !this.page) return;
    try {
      await this.page.evaluate(() => {
        if (window.startLipSync) window.startLipSync();
      });
    } catch (e) {}
  }

  async stopSpeaking() {
    if (!this.active || !this.page) return;
    try {
      await this.page.evaluate(() => {
        if (window.stopLipSync) window.stopLipSync();
      });
    } catch (e) {}
  }

  async stop() {
    this.active = false;
    if (this.page) {
      try { await this.page.close(); } catch (e) {}
      this.page = null;
    }
  }
}

module.exports = Live2DCanvas;
