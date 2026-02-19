const { EventEmitter } = require('events');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const config = require('./config');

puppeteer.use(StealthPlugin());

const LOG = '[MeetJoiner]';

class MeetJoiner extends EventEmitter {
  constructor() {
    super();
    this.browser = null;
    this.page = null;
    this.state = 'idle'; // idle, launching, joining, waiting-admission, in-meeting, leaving, error
    this.meetLink = '';
    this.botName = config.botName;
    this.watchdogInterval = null;
    // Active speaker detection
    this.activeSpeakers = [];       // Current speakers (from Meet UI)
    this.speakerPollInterval = null;
    // Auto-leave when alone
    this.aloneTimer = null;
    this.aloneSinceMs = 0;
    this.autoLeaveMs = parseInt(process.env.AUTO_LEAVE_ALONE_MS || '300000', 10); // 5 min
  }

  getState() {
    return this.state;
  }

  _setState(state) {
    const prev = this.state;
    this.state = state;
    console.log(LOG, `State: ${prev} → ${state}`);
    this.emit('state', state);
  }

  async join(meetLink, botName) {
    if (this.state !== 'idle' && this.state !== 'error') {
      throw new Error(`Cannot join: current state is ${this.state}`);
    }

    this.meetLink = meetLink;
    this.botName = botName || config.botName;
    this._setState('launching');

    try {
      await this._launchBrowser();
      await this._loadCookies();

      // Emit 'browser-ready' so Live2D can install overrides before navigation
      this.emit('browser-ready', this.page);
      // Give a tick for async listeners
      await new Promise(r => setTimeout(r, 100));

      await this._navigateToMeet();
      await this._joinMeeting();
      this._startWatchdog();
      this._startSpeakerPoll();
    } catch (err) {
      console.error(LOG, 'Join failed:', err.message);
      this._setState('error');
      this.emit('error', err);
      throw err;
    }
  }

  async leave() {
    this._setState('leaving');
    this._stopWatchdog();
    this._stopSpeakerPoll();

    try {
      if (this.page) {
        // Try clicking the leave button
        try {
          await this.page.evaluate(() => {
            // Google Meet leave button
            const leaveBtn = document.querySelector('[aria-label*="Leave"], [aria-label*="Salir"], [data-tooltip*="Leave"], [data-tooltip*="Salir"]');
            if (leaveBtn) leaveBtn.click();
          });
          await this._sleep(2000);
        } catch (e) { /* ignore */ }
      }
    } catch (e) {
      console.error(LOG, 'Error during leave:', e.message);
    }

    await this._cleanup();
    this._setState('idle');
    this.emit('left');
  }

  async _launchBrowser() {
    console.log(LOG, 'Launching Chromium...');

    const args = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--enable-webgl',
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--use-fake-ui-for-media-stream',       // Auto-allow mic/camera prompts
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1280,720',
      '--disable-features=WebRtcHideLocalIpsWithMdns',
      '--disable-dev-shm-usage',
      '--alsa-output-device=pulse',            // Route audio through PulseAudio
      '--disable-extensions',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-translate',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
    ];

    // If Live2D is enabled, don't use fake video — we'll provide our own
    if (config.live2dEnabled) {
      // Remove fake video capture since we'll override getUserMedia
      // Keep fake audio capture for the virtual mic
    }

    this.browser = await puppeteer.launch({
      executablePath: config.chromePath,
      headless: false, // Need real browser for WebRTC
      args,
      defaultViewport: { width: 1280, height: 720 },
      ignoreDefaultArgs: ['--mute-audio', '--enable-automation'],
    });

    this.page = (await this.browser.pages())[0] || await this.browser.newPage();

    // Stealth patches — hide automation fingerprints
    await this.page.evaluateOnNewDocument(() => {
      // Hide webdriver
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      delete navigator.__proto__.webdriver;
      
      // Fake chrome.runtime (Google checks this on their own sites)
      window.chrome = window.chrome || {};
      window.chrome.runtime = window.chrome.runtime || {
        connect: function() {},
        sendMessage: function() {},
      };
      
      // Fake plugins (headless has 0)
      Object.defineProperty(navigator, 'plugins', {
        get: () => {
          const arr = [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
            { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
          ];
          arr.refresh = () => {};
          return arr;
        }
      });
      
      // Fake languages
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      
      // Fix permissions query
      const origQuery = window.Permissions?.prototype?.query;
      if (origQuery) {
        window.Permissions.prototype.query = function(params) {
          if (params.name === 'notifications') {
            return Promise.resolve({ state: 'prompt', onchange: null });
          }
          return origQuery.call(this, params);
        };
      }
    });

    // Grant permissions
    const context = this.browser.defaultBrowserContext();
    await context.overridePermissions('https://meet.google.com', [
      'microphone', 'camera', 'notifications',
    ]);

    console.log(LOG, 'Browser launched (stealth mode)');
  }

  async _loadCookies() {
    if (!config.googleCookie) {
      console.log(LOG, 'No Google cookies configured — joining as guest');
      return;
    }

    try {
      let cookies;
      if (config.googleCookie.startsWith('[')) {
        cookies = JSON.parse(config.googleCookie);
      } else {
        cookies = JSON.parse(config.googleCookie);
      }

      // Ensure cookies have required fields
      const processedCookies = cookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain || '.google.com',
        path: c.path || '/',
        httpOnly: c.httpOnly !== undefined ? c.httpOnly : false,
        secure: c.secure !== undefined ? c.secure : true,
        sameSite: c.sameSite || 'Lax',
      }));

      await this.page.setCookie(...processedCookies);
      console.log(LOG, `Loaded ${processedCookies.length} cookies`);
    } catch (err) {
      console.error(LOG, 'Failed to load cookies:', err.message);
    }
  }

  async _navigateToMeet() {
    console.log(LOG, `Navigating to ${this.meetLink}...`);
    this._setState('joining');

    // Live2D overrides are installed externally via live2d.installOverrides(page)
    // before this method is called. See index.js for the flow.

    // Listen for console messages on Meet page for debugging
    this.page.on('console', msg => {
      const text = msg.text();
      if (text.includes('Live2D') || text.includes('Override')) {
        console.log('[MeetPage]', text);
      }
    });

    await this.page.goto(this.meetLink, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    await this._sleep(3000);
    // Check if our override was injected
    const overrideCheck = await this.page.evaluate(() => {
      return {
        hasFakeCanvas: !!window._fakeCanvas,
        gumCallCount: window._gumCallCount || 0,
        gumCalls: window._gumCalls || [],
        hasPCs: (window._meetPeerConnections || []).length,
      };
    });
    console.log(LOG, 'Override check:', JSON.stringify(overrideCheck));
    console.log(LOG, 'Page loaded');
  }

  async _joinMeeting() {
    // If Live2D is enabled, keep camera ON (getUserMedia is overridden)
    // If not, turn off camera
    if (!config.live2dEnabled) {
      await this._tryClick('[aria-label*="camera" i][data-is-muted="false"]', 'Turn off camera');
      await this._tryClick('[aria-label*="cámara" i][data-is-muted="false"]', 'Turn off camera (es)');
    } else {
      console.log(LOG, 'Keeping camera ON for Live2D avatar');
    }

    // Turn off mic — we'll inject audio via PulseAudio
    // Actually keep mic ON so our virtual mic (TTS) is used
    // But turn off initially to avoid noise
    // await this._tryClick('[aria-label*="microphone" i][data-is-muted="false"]', 'Mute mic');

    // Enter bot name if there's a name input (guest mode)
    await this._trySetName();

    // Click "Ask to join" or "Join now"
    await this._sleep(2000);

    const joined = await this._clickJoinButton();
    if (!joined) {
      throw new Error('Could not find join button');
    }

    // Wait for admission (if "Ask to join" was clicked)
    await this._waitForAdmission();

    // Handle post-join dialogs (Gemini notes, tips, etc.)
    await this._dismissDialogs();

    console.log(LOG, 'Successfully joined the meeting!');
    this._setState('in-meeting');
    this.emit('joined');
  }

  async _dismissDialogs() {
    // Handle Gemini "taking notes" dialog, "Got it" tips, etc.
    for (let attempt = 0; attempt < 5; attempt++) {
      await this._sleep(1000);
      try {
        const dismissed = await this.page.evaluate(() => {
          const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
          const dismissTexts = ['join now', 'got it', 'dismiss', 'close', 'ok', 'accept', 'entendido', 'cerrar', 'aceptar'];
          let found = false;
          for (const btn of buttons) {
            const text = btn.textContent.toLowerCase().trim();
            if (dismissTexts.some(t => text === t || text.includes(t))) {
              // Don't click "Leave" button
              if (text.includes('leave') || text.includes('salir')) continue;
              btn.click();
              found = true;
              console.log('[MeetBot] Dismissed dialog button: ' + text);
            }
          }
          return found;
        });
        if (dismissed) {
          console.log(LOG, 'Dismissed a dialog (attempt ' + (attempt + 1) + ')');
        } else {
          break; // No more dialogs
        }
      } catch (e) { break; }
    }
  }

  async _trySetName() {
    try {
      // Try multiple selectors — Meet changes these frequently
      const selectors = [
        'input[placeholder*="name" i]',
        'input[placeholder*="nombre" i]',
        'input[aria-label*="name" i]',
        'input[aria-label*="nombre" i]',
        'input[type="text"]',  // Generic fallback — usually only 1 text input on join screen
      ];
      
      let nameInput = null;
      for (const sel of selectors) {
        nameInput = await this.page.$(sel);
        if (nameInput) {
          console.log(LOG, `Found name input with selector: ${sel}`);
          break;
        }
      }
      
      // Always try evaluate approach — more reliable than Puppeteer click
      const found = await this.page.evaluate((name) => {
        const inputs = document.querySelectorAll('input');
        for (const input of inputs) {
          const ph = (input.placeholder || '').toLowerCase();
          const label = (input.getAttribute('aria-label') || '').toLowerCase();
          if (ph.includes('name') || ph.includes('nombre') || ph.includes('your name') ||
              label.includes('name') || label.includes('nombre') ||
              input.type === 'text') {
            // Use native setter to bypass React controlled input
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeSetter.call(input, name);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            return 'set: ' + (ph || label || input.type) + ' = ' + input.value;
          }
        }
        return null;
      }, this.botName);
      
      if (found) {
        console.log(LOG, `Name: ${found}`);
      } else {
        console.log(LOG, 'No name input found — may already be signed in');
      }
    } catch (e) {
      console.log(LOG, 'Name input error:', e.message);
    }
  }

  async _clickJoinButton() {
    // Various selectors for the join button across locales
    const selectors = [
      'button[data-idom-class*="join"]',
      '[jsname="Qx7uuf"]', // "Join now" button jsname
      'button:has-text("Join now")',
      'button:has-text("Ask to join")',
      'button:has-text("Unirse")',
      'button:has-text("Pedir unirse")',
      'button:has-text("Participar")',
    ];

    // Try direct selectors first
    for (const sel of selectors) {
      try {
        const btn = await this.page.$(sel);
        if (btn) {
          await btn.click();
          console.log(LOG, `Clicked join button (${sel})`);
          return true;
        }
      } catch (e) { /* continue */ }
    }

    // Fallback: find by text content
    try {
      const clicked = await this.page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
        const joinTexts = ['join now', 'ask to join', 'unirse', 'pedir unirse', 'participar', 'join'];
        for (const btn of buttons) {
          const text = btn.textContent.toLowerCase().trim();
          if (joinTexts.some(t => text.includes(t))) {
            btn.click();
            return text;
          }
        }
        return null;
      });

      if (clicked) {
        console.log(LOG, `Clicked join button by text: "${clicked}"`);
        return true;
      }
    } catch (e) {
      console.error(LOG, 'Error finding join button:', e.message);
    }

    return false;
  }

  async _waitForAdmission() {
    console.log(LOG, 'Waiting for admission...');
    this._setState('waiting-admission');

    // Wait up to 5 minutes for admission
    const timeout = 5 * 60 * 1000;
    const start = Date.now();

    while (Date.now() - start < timeout) {
      // Check if we're in the meeting AND handle any blocking dialogs
      const status = await this.page.evaluate(() => {
        const body = document.body.innerText.toLowerCase();
        
        // Check for denial
        if (body.includes('denied') || body.includes('rechazad') ||
            body.includes('not allowed') || body.includes('removed')) {
          return 'denied';
        }
        
        // Check for blocking dialogs (Gemini notes, etc.) and click through them
        const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
        // Only dismiss non-join dialogs (tips, notifications)
        // The Gemini "Join now" dialog only appears AFTER admission — handle separately
        const acceptTexts = ['got it', 'dismiss', 'entendido', 'aceptar'];
        const skipTexts = ['leave', 'salir', 'cancel', 'cancelar', 'join', 'ask to join', 'unirse', 'pedir'];
        
        // Special case: Gemini dialog with "Join now" — only click if we see Gemini text
        const bodyLower = document.body.innerText.toLowerCase();
        const hasGemini = bodyLower.includes('gemini') && bodyLower.includes('taking notes');
        if (hasGemini) {
          for (const btn of buttons) {
            const text = btn.textContent.toLowerCase().trim();
            if (text === 'join now' || text === 'unirse ahora') {
              btn.click();
              console.log('[MeetBot] Clicked Gemini Join now dialog');
              return 'clicked-dialog';
            }
          }
        }
        for (const btn of buttons) {
          const text = btn.textContent.toLowerCase().trim();
          if (skipTexts.some(t => text.includes(t))) continue;
          if (acceptTexts.some(t => text === t || text.includes(t))) {
            btn.click();
            console.log('[MeetBot] Auto-clicked dialog: ' + text);
            return 'clicked-dialog';
          }
        }
        
        // Check if we're in the meeting
        const controls = document.querySelector('[data-call-ended]');
        if (controls) return 'ended';
        
        const meetUI = document.querySelector(
          '[aria-label*="people" i], [aria-label*="participant" i], ' +
          '[aria-label*="chat" i], [data-tooltip*="chat" i], ' +
          '[aria-label*="personas" i]'
        );
        return meetUI ? 'in-meeting' : 'waiting';
      });

      if (status === 'in-meeting') return;
      if (status === 'denied') throw new Error('Admission denied or removed from meeting');
      if (status === 'ended') throw new Error('Meeting ended');
      if (status === 'clicked-dialog') {
        console.log(LOG, 'Clicked through a dialog during admission wait');
        await this._sleep(3000); // Give time for meeting to load after dialog
        continue;
      }
      
      // Log what we see every 10 seconds
      if ((Date.now() - start) % 10000 < 2500) {
        const pageInfo = await this.page.evaluate(() => ({
          title: document.title,
          url: window.location.href,
          bodySnippet: document.body.innerText.substring(0, 200),
        })).catch(() => ({ title: '?', url: '?', bodySnippet: '?' }));
        console.log(LOG, 'Still waiting...', JSON.stringify(pageInfo));
      }

      await this._sleep(2000);
    }

    throw new Error('Admission timeout (5 minutes)');
  }

  /**
   * Poll Meet UI for active speakers (blue border / speaking indicator).
   * Emits 'active-speakers' with array of {name, participantId}.
   * Also tracks participant count for auto-leave.
   */
  _startSpeakerPoll() {
    this.speakerPollInterval = setInterval(async () => {
      if (this.state !== 'in-meeting' || !this.page) return;
      try {
        const result = await this.page.evaluate(() => {
          const speakers = [];
          const allParticipants = [];

          // Meet renders participant tiles. Active speakers have animated borders.
          // Method 1: data-participant-id tiles with speaking indicator
          document.querySelectorAll('[data-participant-id]').forEach(el => {
            // Get participant name from aria-label or nested element
            const nameEl = el.querySelector('[data-self-name]') || el.querySelector('[class*="ZjFb7c"]');
            const name = nameEl?.textContent?.trim() ||
                         el.getAttribute('aria-label')?.replace(/ \(.*\)/, '')?.trim() ||
                         'Unknown';

            allParticipants.push(name);

            // Check for speaking indicator:
            // 1. Blue/green animated border (CSS animation on border)
            // 2. SVG speaking wave icon
            // 3. Class containing "speaking" or "active"
            const style = window.getComputedStyle(el);
            const hasBorderAnim = style.animationName !== 'none' && style.animationName !== '';
            const hasSpeakingClass = el.className.includes('speak') || el.className.includes('Spoke');
            // Check child elements for speaking wave SVG
            const hasSpeakingIcon = !!el.querySelector('svg[class*="speak"], [class*="Qevneb"]');
            // Check border color (active speaker gets colored border)
            const borderColor = style.borderColor || style.outlineColor || '';
            const hasActiveBorder = borderColor.includes('rgb(26, 115, 232)') || // Google blue
                                    borderColor.includes('rgb(66, 133, 244)') ||
                                    borderColor.includes('rgb(0, 200,') ||       // green variant
                                    el.querySelector('[style*="border"][style*="rgb(26"]');

            if (hasBorderAnim || hasSpeakingClass || hasSpeakingIcon || hasActiveBorder) {
              speakers.push({ name, participantId: el.getAttribute('data-participant-id') });
            }
          });

          // Method 2: Bottom bar speaking indicators (shows name of current speaker)
          // Meet sometimes shows "X is presenting" or speaker name in bottom bar
          const speakerBar = document.querySelector('[class*="ojJM9c"], [class*="GSQgnf"]');
          if (speakerBar?.textContent) {
            const barText = speakerBar.textContent.trim();
            if (barText && !speakers.some(s => barText.includes(s.name))) {
              speakers.push({ name: barText.replace(' is presenting', '').trim(), participantId: null });
            }
          }

          return { speakers, participantCount: allParticipants.length };
        });

        // Emit active speakers if changed
        const newNames = result.speakers.map(s => s.name).sort().join(',');
        const oldNames = this.activeSpeakers.map(s => s.name).sort().join(',');
        if (newNames !== oldNames) {
          this.activeSpeakers = result.speakers;
          if (result.speakers.length > 0) {
            this.emit('active-speakers', result.speakers);
          }
        }

        // Auto-leave when alone (only bot in meeting)
        // participantCount includes the bot itself, so <= 1 means alone
        if (result.participantCount <= 1) {
          if (!this.aloneSinceMs) {
            this.aloneSinceMs = Date.now();
            console.log(LOG, 'Alone in meeting, starting auto-leave timer (' + (this.autoLeaveMs/1000) + 's)');
          } else if (Date.now() - this.aloneSinceMs >= this.autoLeaveMs) {
            console.log(LOG, 'Alone for ' + (this.autoLeaveMs/1000) + 's, auto-leaving');
            this._stopSpeakerPoll();
            this._stopWatchdog();
            this.emit('auto-leave');
            this.leave().catch(e => console.error(LOG, 'Auto-leave error:', e.message));
          }
        } else {
          if (this.aloneSinceMs) {
            console.log(LOG, 'No longer alone (' + result.participantCount + ' participants)');
          }
          this.aloneSinceMs = 0;
        }
      } catch (e) {
        // Page might be navigating
      }
    }, 1000); // Poll every 1s
  }

  _stopSpeakerPoll() {
    if (this.speakerPollInterval) {
      clearInterval(this.speakerPollInterval);
      this.speakerPollInterval = null;
    }
    this.activeSpeakers = [];
    this.aloneSinceMs = 0;
  }

  /** Get current active speakers (called by transcriber for attribution) */
  getActiveSpeakers() {
    return this.activeSpeakers;
  }

  _startWatchdog() {
    this.watchdogInterval = setInterval(async () => {
      if (this.state !== 'in-meeting') return;

      try {
        // Check if meeting ended
        const ended = await this.page.evaluate(() => {
          const body = document.body.innerText.toLowerCase();
          const title = document.title;
          // Title changes from "Meeting - Google Meet" to just "Google Meet" when ejected
          const titleEjected = title === 'Google Meet' || title === 'Meet';
          return titleEjected ||
                 body.includes('you left the meeting') ||
                 body.includes('the meeting has ended') ||
                 body.includes('has finalizado') ||
                 body.includes('saliste de la reunión') ||
                 body.includes('removed from the meeting') ||
                 body.includes('call ended') ||
                 body.includes('return to home screen') ||
                 body.includes('you\'ve been removed');
        });

        if (ended) {
          console.log(LOG, 'Meeting ended detected');
          this._stopWatchdog();
          this._setState('idle');
          this.emit('meeting-ended');
        }
      } catch (err) {
        // Page might be closed
        if (err.message.includes('Target closed') || err.message.includes('Session closed')) {
          console.log(LOG, 'Browser closed unexpectedly');
          this._stopWatchdog();
          this._setState('error');
          this.emit('error', new Error('Browser closed'));
        }
      }
    }, 5000);
  }

  _stopWatchdog() {
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }
  }

  async _cleanup() {
    this._stopWatchdog();
    if (this.browser) {
      try {
        await this.browser.close();
      } catch (e) { /* ignore */ }
      this.browser = null;
      this.page = null;
    }
  }

  async _tryClick(selector, label) {
    try {
      const el = await this.page.$(selector);
      if (el) {
        await el.click();
        console.log(LOG, label || `Clicked ${selector}`);
        await this._sleep(500);
        return true;
      }
    } catch (e) { /* ignore */ }
    return false;
  }

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = MeetJoiner;
