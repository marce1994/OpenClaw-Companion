/**
 * Live2D Canvas — High-performance avatar injection for Google Meet
 * 
 * Uses WebCodecs MediaStreamTrackGenerator to inject Live2D frames
 * directly into Meet's video pipeline at 30fps+ in HD.
 * 
 * Architecture:
 * 1. evaluateOnNewDocument installs getUserMedia override + MediaStreamTrackGenerator
 * 2. Meet calls getUserMedia → gets our generator track instead of real camera
 * 3. After Meet joins, we inject PixiJS + Live2D libs inline via CDP
 * 4. Live2D renders on a canvas in Meet's page context
 * 5. Each frame → new VideoFrame(canvas) → writer.write() → zero-copy to WebRTC
 * 
 * No cross-tab transfer, no base64 serialization. Pure in-page rendering.
 */

const fs = require('fs');
const pathModule = require('path');
const config = require('./config');
const LOG = '[Live2D]';

class Live2DCanvas {
  constructor() {
    this.active = false;
    this.modelName = config.live2dModel || 'wanko';
  }

  /**
   * Install getUserMedia override + MediaStreamTrackGenerator BEFORE Meet loads.
   * Must be called before navigating to Meet URL.
   */
  async installOverrides(page) {
    console.log(LOG, 'Installing WebCodecs-based video override...');

    await page.evaluateOnNewDocument(() => {
      // Create a shared canvas for Live2D rendering — captureStream is more reliable than VideoFrame
      // Use 640x360 canvas — smaller = faster WebRTC encoding = higher delivered FPS
      const avatarCanvas = document.createElement('canvas');
      avatarCanvas.width = 640;
      avatarCanvas.height = 360;
      const ctx = avatarCanvas.getContext('2d');
      ctx.fillStyle = '#1a1a2e';
      ctx.fillRect(0, 0, 640, 360);
      window.__avatarCanvas = avatarCanvas;
      // captureStream(0) = manual frame control via requestFrame()
      window.__avatarStream = avatarCanvas.captureStream(0);
      window.__avatarTrack = window.__avatarStream.getVideoTracks()[0];
      window.__avatarWriter = null;
      window.__avatarReady = false;
      window.__meetPeerConnections = [];
      console.log('[Live2D-Override] Avatar canvas 640x360 + captureStream(0) created');

      // Override getUserMedia
      const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async function(constraints) {
        const hasVideo = !!(constraints && constraints.video);
        const hasAudio = !!(constraints && constraints.audio);
        console.log('[Live2D-Override] getUserMedia video=' + hasVideo + ' audio=' + hasAudio);

        if (hasVideo) {
          console.log('[Live2D-Override] INTERCEPTING VIDEO');
          
          // Get real audio if requested
          let audioTracks = [];
          if (hasAudio) {
            try {
              const audioStream = await origGUM({ audio: constraints.audio });
              audioTracks = audioStream.getAudioTracks();
            } catch(e) {
              console.log('[Live2D-Override] Audio fallback failed: ' + e.message);
            }
          }

          // Use captureStream from shared avatar canvas — most compatible with WebRTC
          const stream = new MediaStream([window.__avatarTrack, ...audioTracks]);
          console.log('[Live2D-Override] Returning captureStream track (30fps)');
          return stream;
        }
        return origGUM(constraints);
      };

      // Override enumerateDevices to report a camera
      const origEnumerate = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
      navigator.mediaDevices.enumerateDevices = async function() {
        const devices = await origEnumerate();
        const hasCam = devices.some(d => d.kind === 'videoinput');
        if (!hasCam) {
          devices.push({
            deviceId: 'live2d-avatar', groupId: 'live2d',
            kind: 'videoinput', label: 'Live2D Avatar Camera',
            toJSON() { return { deviceId: this.deviceId, groupId: this.groupId, kind: this.kind, label: this.label }; }
          });
        }
        return devices;
      };

      // Capture PeerConnections + intercept addTrack to swap video tracks
      const OrigPC = window.RTCPeerConnection;
      const origAddTrack = OrigPC.prototype.addTrack;
      OrigPC.prototype.addTrack = function(track, ...streams) {
        if (track.kind === 'video' && window.__avatarTrack) {
          console.log('[Live2D-Override] addTrack intercepted: swapping video track with avatar');
          return origAddTrack.call(this, window.__avatarTrack, ...streams);
        }
        return origAddTrack.call(this, track, ...streams);
      };
      
      window.RTCPeerConnection = function(...args) {
        const pc = new OrigPC(...args);
        window.__meetPeerConnections.push(pc);
        console.log('[Live2D-Override] PC created (' + window.__meetPeerConnections.length + ')');
        return pc;
      };
      window.RTCPeerConnection.prototype = OrigPC.prototype;
      Object.keys(OrigPC).forEach(k => { try { window.RTCPeerConnection[k] = OrigPC[k]; } catch(e) {} });

      console.log('[Live2D-Override] All overrides installed (WebCodecs mode)');
    });
  }

  /**
   * After Meet has joined, inject Live2D renderer directly into the Meet page.
   */
  async injectIntoMeet(meetPage) {
    console.log(LOG, 'Injecting Live2D renderer into Meet page...');
    this.meetPage = meetPage; // Store reference for setStatus calls

    try {
      // Read all JS libraries
      const libDir = pathModule.join(__dirname, '..', 'public', 'live2d');
      const pixiCode = fs.readFileSync(pathModule.join(libDir, 'pixi.min.js'), 'utf-8');
      const live2dCore = fs.readFileSync(pathModule.join(libDir, 'live2d.min.js'), 'utf-8');
      const cubism4Core = fs.readFileSync(pathModule.join(libDir, 'live2dcubismcore.min.js'), 'utf-8');
      const live2dDisplay = fs.readFileSync(pathModule.join(libDir, 'pixi-live2d-display.min.js'), 'utf-8');

      console.log(LOG, `Injecting libraries (~${Math.round((pixiCode.length + live2dCore.length + cubism4Core.length + live2dDisplay.length) / 1024)}KB)...`);

      // Inject libraries one by one via CDP (bypasses CSP)
      const cdp = await meetPage.target().createCDPSession();
      
      await cdp.send('Runtime.evaluate', { expression: pixiCode, awaitPromise: false });
      console.log(LOG, '✅ PixiJS injected');
      
      await cdp.send('Runtime.evaluate', { expression: live2dCore, awaitPromise: false });
      console.log(LOG, '✅ Live2D Cubism 2 core injected');
      
      await cdp.send('Runtime.evaluate', { expression: cubism4Core, awaitPromise: false });
      console.log(LOG, '✅ Live2D Cubism 4 core injected');
      
      await cdp.send('Runtime.evaluate', { expression: live2dDisplay, awaitPromise: false });
      console.log(LOG, '✅ pixi-live2d-display injected');

      // Read model files and encode as base64 for inline injection
      const modelDir = pathModule.join(__dirname, '..', 'public', 'live2d', this.modelName);
      const modelJsonPath = pathModule.join(modelDir, `${this.modelName}.model.json`);
      const modelJson = JSON.parse(fs.readFileSync(modelJsonPath, 'utf-8'));
      const isCubism2 = this.modelName === 'wanko';

      // Read all model assets and create a blob URL map
      const modelAssets = {};
      
      // .moc file
      const mocPath = pathModule.join(modelDir, modelJson.model);
      modelAssets['model'] = fs.readFileSync(mocPath).toString('base64');
      
      // Textures
      const textureData = [];
      for (const tex of modelJson.textures) {
        const texPath = pathModule.join(modelDir, tex);
        textureData.push(fs.readFileSync(texPath).toString('base64'));
      }
      
      // Motion files (optional)
      const motionData = {};
      if (modelJson.motions) {
        for (const [group, motions] of Object.entries(modelJson.motions)) {
          motionData[group] = [];
          for (const m of motions) {
            try {
              const mtnPath = pathModule.join(modelDir, m.file);
              motionData[group].push(fs.readFileSync(mtnPath).toString('base64'));
            } catch(e) {
              motionData[group].push(null);
            }
          }
        }
      }

      console.log(LOG, `Model assets loaded: moc=${Math.round(modelAssets.model.length/1024)}KB, textures=${textureData.length}, motions=${Object.keys(motionData).length} groups`);

      // Inject the renderer
      const rendererCode = `
        (async () => {
          try {
            console.log('[Live2D-Render] Starting renderer...');
            
            // Create hidden canvas for rendering
            const canvas = document.createElement('canvas');
            canvas.width = 640;
            canvas.height = 360;
            canvas.style.display = 'none';
            document.body.appendChild(canvas);
            window.__live2dCanvas = canvas;
            
            // Create PIXI application
            const app = new PIXI.Application({
              view: canvas,
              width: 640,
              height: 360,
              backgroundColor: 0x1a1a2e,
              autoStart: true,
              antialias: true,
              preserveDrawingBuffer: true,
            });
            window.__live2dApp = app;
            
            // Pre-decode all assets into memory
            const mocB64 = '${modelAssets.model}';
            const mocData = Uint8Array.from(atob(mocB64), c => c.charCodeAt(0)).buffer;
            
            const textureB64List = ${JSON.stringify(textureData)};
            const textureImages = [];
            for (const b64 of textureB64List) {
              const img = new Image();
              await new Promise((resolve, reject) => {
                img.onload = resolve;
                img.onerror = reject;
                img.src = 'data:image/png;base64,' + b64;
              });
              textureImages.push(img);
            }
            
            const motionB64Map = ${JSON.stringify(motionData)};
            
            // Override the XHR loader to serve from memory
            const assetMap = {};
            const modelDef = ${JSON.stringify(modelJson)};
            // Use fake paths 
            assetMap['/model.json'] = JSON.stringify(modelDef);
            assetMap[modelDef.model] = mocData;
            if (modelDef.motions) {
              for (const [group, motions] of Object.entries(modelDef.motions)) {
                const b64Group = motionB64Map[group] || [];
                for (let i = 0; i < motions.length; i++) {
                  if (b64Group[i]) {
                    assetMap[motions[i].file] = Uint8Array.from(atob(b64Group[i]), c => c.charCodeAt(0)).buffer;
                  }
                }
              }
            }
            
            // Hook into pixi-live2d-display's loader
            const origMiddlewares = PIXI.live2d.Live2DLoader.middlewares.slice();
            PIXI.live2d.Live2DLoader.middlewares = [(context, next) => {
              // Check if this URL matches one of our pre-loaded assets
              const url = context.url || '';
              const key = Object.keys(assetMap).find(k => url.endsWith(k));
              if (key) {
                console.log('[Live2D-Render] Serving from memory: ' + key);
                const data = assetMap[key];
                if (typeof data === 'string') {
                  context.result = JSON.parse(data);
                  if (key.endsWith('.json')) context.result.url = '/model.json';
                } else {
                  context.result = data;
                }
                return next();
              }
              console.log('[Live2D-Render] XHR load: ' + url);
              // Fall through to original loader
              return origMiddlewares[0](context, next);
            }];
            
            // Load model — the loader will serve everything from memory
            console.log('[Live2D-Render] Loading model from memory...');
            
            // Override PIXI's texture loading to use our pre-loaded images
            const origTextureFrom = PIXI.Texture.fromURL || PIXI.Texture.from;
            const textureOverrides = {};
            modelDef.textures.forEach((texPath, i) => {
              textureOverrides[texPath] = textureImages[i];
            });
            
            // Monkey-patch Texture.from to intercept our texture paths
            const origFrom = PIXI.Texture.from;
            PIXI.Texture.from = function(source, options) {
              if (typeof source === 'string') {
                const match = Object.keys(textureOverrides).find(k => source.endsWith(k));
                if (match) {
                  console.log('[Live2D-Render] Serving texture from memory: ' + match);
                  return origFrom.call(PIXI.Texture, textureOverrides[match], options);
                }
              }
              return origFrom.call(PIXI.Texture, source, options);
            };
            if (PIXI.Texture.fromURL) {
              const origFromURL = PIXI.Texture.fromURL;
              PIXI.Texture.fromURL = function(url, options) {
                const match = Object.keys(textureOverrides).find(k => url.endsWith(k));
                if (match) {
                  console.log('[Live2D-Render] Serving texture from memory (fromURL): ' + match);
                  return Promise.resolve(origFrom.call(PIXI.Texture, textureOverrides[match], options));
                }
                return origFromURL.call(PIXI.Texture, url, options);
              };
            }
            
            // Load model — everything served from memory
            modelDef.url = '/model.json';
            const model = await PIXI.live2d.Live2DModel.from(modelDef);
            app.stage.addChild(model);
            
            // Position model
            const isCubism2 = ${isCubism2};
            console.log('[Live2D-Render] Model loaded, dimensions:', model.width, 'x', model.height, 'cubism2:', isCubism2);
            
            // Scale to fit canvas
            const scale = Math.min(640 / model.width, 360 / model.height) * 0.9;
            model.scale.set(scale);
            model.x = 40;
            model.y = 230;
            console.log('[Live2D-Render] Positioned: scale=' + scale.toFixed(3) + ' x=40 y=230 (640x360)');
            
            // Status tracking — drawn directly on avatar canvas each frame
            window.__jarvisStatus = 'idle';
            window.__setJarvisStatus = function(s) { window.__jarvisStatus = s || 'idle'; };
            
            // Lip sync — oscillate mouth open/close while speaking
            window.__jarvisSpeaking = false;
            let lipFrame = 0;
            app.ticker.add(() => {
              if (window.__jarvisSpeaking && model.internalModel) {
                lipFrame += 0.15;
                const val = (Math.sin(lipFrame * 4) + 1) / 2; // 0-1 oscillation
                try {
                  if (isCubism2) {
                    model.internalModel.coreModel.setParamFloat('PARAM_MOUTH_OPEN_Y', val);
                  } else {
                    const cm = model.internalModel.coreModel;
                    const idx = cm.getParameterIndex('ParamMouthOpenY');
                    if (idx >= 0) cm.setParameterValueByIndex(idx, val);
                  }
                } catch(e) {}
              }
            });
            
            // === EMOJI BUBBLE SYSTEM ===
            const emotionEmojis = {
              happy: '😄', laughing: '😂', thinking: '🤔', confused: '😵',
              sad: '😢', love: '❤️', angry: '😤', surprised: '😮'
            };
            window.__emojiBubbles = [];
            window.__spawnEmojiBubble = function(emotion) {
              const emoji = emotionEmojis[emotion];
              if (!emoji) return;
              window.__emojiBubbles.push({
                emoji,
                x: 280 + Math.random() * 80, // center-top area
                y: 180,
                startTime: performance.now(),
                duration: 2500,
                wobbleOffset: Math.random() * Math.PI * 2
              });
            };
            
            // Status icons map
            const statusIcons = {
              'idle': '😴 Idle',
              'listening': '🎧 Listening...',
              'thinking': '🤔 Thinking...',
              'speaking': '🔊 Speaking...',
              'transcribing': '📝 Transcribing...',
            };
            // HUD data
            window.__lastTranscript = '';
            window.__hudStats = { sttMs: 0, aiMs: 0, ttsMs: 0, queueSize: 0, totalMs: 0 };
            
            // Start idle animation
            try {
              model.motion('idle');
            } catch(e) {}
            
            window.__live2dModel = model;
            window.__avatarReady = true;
            
            // Render loop: push VideoFrames to the generator track
            const writer = window.__avatarWriter;
            let frameCount = 0;
            const startTime = performance.now();
            
            // Render loop: draw Live2D to avatar canvas, then requestFrame() for captureStream
            const avatarCanvas = window.__avatarCanvas;
            const avatarCtx = avatarCanvas ? avatarCanvas.getContext('2d') : null;
            const avatarStream = window.__avatarStream;
            const videoTrack = avatarStream ? avatarStream.getVideoTracks()[0] : null;
            
            function renderLoop() {
              try {
                if (avatarCtx) {
                  // Draw Live2D output
                  avatarCtx.drawImage(canvas, 0, 0, 640, 360);
                  
                  // === HUD OVERLAY ===
                  const status = window.__jarvisStatus || 'idle';
                  const statusLabel = statusIcons[status] || statusIcons['idle'];
                  const transcript = window.__lastTranscript || '';
                  const stats = window.__hudStats || {};
                  
                  avatarCtx.save();
                  
                  // --- Top-left: Status pill ---
                  const L = 60; // Left margin (Meet crops ~50px)
                  avatarCtx.font = 'bold 18px Arial, sans-serif';
                  const stw = avatarCtx.measureText(statusLabel).width;
                  const statusColors = {
                    idle: 'rgba(80,80,80,0.6)',
                    listening: 'rgba(0,150,80,0.75)',
                    transcribing: 'rgba(200,150,0,0.75)',
                    thinking: 'rgba(0,100,200,0.75)',
                    speaking: 'rgba(180,50,200,0.75)',
                  };
                  avatarCtx.fillStyle = statusColors[status] || statusColors.idle;
                  avatarCtx.fillRect(L, 20, stw + 16, 26);
                  avatarCtx.fillStyle = '#fff';
                  avatarCtx.fillText(statusLabel, L + 8, 40);
                  
                  // --- Top-right: Latency stats ---
                  if (stats.totalMs > 0 || stats.queueSize > 0) {
                    avatarCtx.font = '13px monospace';
                    const lines = [];
                    if (stats.sttMs) lines.push('STT: ' + stats.sttMs + 'ms');
                    if (stats.aiMs) lines.push('AI: ' + stats.aiMs + 'ms');
                    if (stats.ttsMs) lines.push('TTS: ' + stats.ttsMs + 'ms');
                    if (stats.totalMs) lines.push('Total: ' + stats.totalMs + 'ms');
                    if (stats.queueSize > 0) lines.push('Queue: ' + stats.queueSize);
                    
                    const lineH = 16;
                    const boxW = 130;
                    const boxX = 640 - L - boxW;
                    const boxY = 20;
                    const boxH = lines.length * lineH + 8;
                    avatarCtx.fillStyle = 'rgba(0,0,0,0.55)';
                    avatarCtx.fillRect(boxX, boxY, boxW, boxH);
                    avatarCtx.fillStyle = '#ccc';
                    lines.forEach((line, i) => {
                      avatarCtx.fillText(line, boxX + 6, boxY + 14 + i * lineH);
                    });
                  }
                  
                  // --- Bottom: Last transcript ---
                  if (transcript) {
                    avatarCtx.font = '14px Arial, sans-serif';
                    const maxW = 520;
                    let displayText = transcript;
                    while (avatarCtx.measureText(displayText).width > maxW && displayText.length > 10) {
                      displayText = '...' + displayText.substring(4);
                    }
                    const ttw = avatarCtx.measureText(displayText).width;
                    const tpy = 290;
                    avatarCtx.fillStyle = 'rgba(0,0,0,0.5)';
                    avatarCtx.fillRect(L - 5, tpy - 14, ttw + 10, 20);
                    avatarCtx.fillStyle = '#e0e0e0';
                    avatarCtx.fillText(displayText, L, tpy);
                  }
                  
                  // --- Emoji Bubbles ---
                  const now = performance.now();
                  const bubbles = window.__emojiBubbles;
                  for (let i = bubbles.length - 1; i >= 0; i--) {
                    const b = bubbles[i];
                    const elapsed = now - b.startTime;
                    if (elapsed > b.duration) { bubbles.splice(i, 1); continue; }
                    const t = elapsed / b.duration; // 0→1
                    const bx = b.x + Math.sin(t * Math.PI * 4 + b.wobbleOffset) * 20;
                    const by = b.y - t * 160; // float upward
                    const alpha = 1 - t;
                    avatarCtx.globalAlpha = alpha;
                    avatarCtx.font = '46px serif';
                    avatarCtx.fillText(b.emoji, bx, by);
                  }
                  avatarCtx.globalAlpha = 1;
                  
                  avatarCtx.restore();
                  
                  // Signal new frame
                  if (videoTrack && videoTrack.requestFrame) {
                    videoTrack.requestFrame();
                  }
                }
                
                frameCount++;
                if (frameCount % 300 === 0) {
                  const elapsed = (performance.now() - startTime) / 1000;
                  console.log('[Live2D-Render] ' + frameCount + ' frames, ~' + Math.round(frameCount / elapsed) + 'fps (captureStream 640x360)');
                }
              } catch(e) {}
              requestAnimationFrame(renderLoop);
            }
            
            renderLoop();
            console.log('[Live2D-Render] ✅ Render loop started at native RAF speed');
            
            // Also try to replace track on existing PeerConnections
            setTimeout(() => {
              const pcs = window.__meetPeerConnections || [];
              let replaced = 0;
              for (const pc of pcs) {
                try {
                  const senders = pc.getSenders();
                  for (const sender of senders) {
                    if (sender.track && sender.track.kind === 'video' && window.__avatarTrack) {
                      sender.replaceTrack(window.__avatarTrack);
                      replaced++;
                    }
                  }
                } catch(e) {}
              }
              console.log('[Live2D-Render] Track replacement: ' + replaced + ' senders updated');
            }, 2000);
            
          } catch(e) {
            console.error('[Live2D-Render] ERROR:', e.message, e.stack);
          }
        })()
      `;

      const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
        expression: rendererCode,
        awaitPromise: true,
        returnByValue: true,
      });

      if (exceptionDetails) {
        console.error(LOG, 'Renderer injection error:', exceptionDetails.text);
      }

      await cdp.detach();

      this.active = true;
      console.log(LOG, '✅ Live2D renderer injected into Meet page!');
      return true;

    } catch (err) {
      console.error(LOG, 'Failed to inject Live2D:', err.message);
      return false;
    }
  }

  async setStatus(status, transcript, stats) {
    if (!this.meetPage) return;
    try {
      await this.meetPage.evaluate((s, t, st) => {
        if (window.__setJarvisStatus) window.__setJarvisStatus(s);
        if (t) window.__lastTranscript = t;
        if (st) Object.assign(window.__hudStats || {}, st);
      }, status, transcript || null, stats || null);
    } catch(e) {}
  }

  async setEmotion(emotion) {
    if (!this.meetPage) return;
    try {
      await this.meetPage.evaluate((e) => {
        if (window.__spawnEmojiBubble) window.__spawnEmojiBubble(e);
      }, emotion);
    } catch(e) {}
  }

  async startSpeaking() {
    await this.setStatus('speaking');
    if (!this.meetPage) return;
    try {
      await this.meetPage.evaluate(() => {
        if (window.__jarvisSpeaking !== undefined) window.__jarvisSpeaking = true;
      });
    } catch(e) {}
  }

  async stopSpeaking() {
    await this.setStatus('idle');
    if (!this.meetPage) return;
    try {
      await this.meetPage.evaluate(() => {
        if (window.__jarvisSpeaking !== undefined) window.__jarvisSpeaking = false;
      });
    } catch(e) {}
  }

  // These are no-ops now since rendering is all in-page
  async start(browser) {
    this.active = true;
    console.log(LOG, `Configured for model: ${this.modelName} (will inject into Meet page)`);
  }

  async stop() {
    this.active = false;
  }
}

module.exports = Live2DCanvas;
