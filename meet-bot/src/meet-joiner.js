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
      await this._navigateToMeet();
      await this._joinMeeting();
      this._startWatchdog();
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

    this.browser = await puppeteer.launch({
      executablePath: config.chromePath,
      headless: false, // Need real browser for WebRTC
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--use-fake-ui-for-media-stream',
        '--use-fake-device-for-media-stream',
        '--use-file-for-fake-audio-capture=/tmp/silence.wav',
        '--autoplay-policy=no-user-gesture-required',
        '--window-size=1280,720',
        '--disable-features=WebRtcHideLocalIpsWithMdns',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-translate',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
      defaultViewport: { width: 1280, height: 720 },
      ignoreDefaultArgs: ['--mute-audio'],
    });

    this.page = (await this.browser.pages())[0] || await this.browser.newPage();

    // Grant permissions
    const context = this.browser.defaultBrowserContext();
    await context.overridePermissions('https://meet.google.com', [
      'microphone', 'camera', 'notifications',
    ]);

    console.log(LOG, 'Browser launched');
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

    await this.page.goto(this.meetLink, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    await this._sleep(3000);
    console.log(LOG, 'Page loaded');
  }

  async _joinMeeting() {
    // Turn off camera if toggle is available
    await this._tryClick('[aria-label*="camera" i][data-is-muted="false"]', 'Turn off camera');
    await this._tryClick('[aria-label*="cámara" i][data-is-muted="false"]', 'Turn off camera (es)');

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

    console.log(LOG, 'Successfully joined the meeting!');
    this._setState('in-meeting');
    this.emit('joined');
  }

  async _trySetName() {
    try {
      const nameInput = await this.page.$('input[placeholder*="name" i], input[placeholder*="nombre" i], input[aria-label*="name" i]');
      if (nameInput) {
        await nameInput.click({ clickCount: 3 }); // Select all
        await nameInput.type(this.botName, { delay: 50 });
        console.log(LOG, `Set name to "${this.botName}"`);
      }
    } catch (e) { /* no name field, probably signed in */ }
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
      // Check if we're in the meeting (presence of meeting controls)
      const inMeeting = await this.page.evaluate(() => {
        // Meeting UI indicators
        const controls = document.querySelector('[data-call-ended]');
        if (controls) return false; // Call ended

        // Check for participant list, chat, or meeting controls
        const meetUI = document.querySelector(
          '[aria-label*="people" i], [aria-label*="participant" i], ' +
          '[aria-label*="chat" i], [data-tooltip*="chat" i], ' +
          '[aria-label*="personas" i]'
        );
        return !!meetUI;
      });

      if (inMeeting) {
        return;
      }

      // Check if we got denied
      const denied = await this.page.evaluate(() => {
        const body = document.body.innerText.toLowerCase();
        return body.includes('denied') || body.includes('rechazad') ||
               body.includes('not allowed') || body.includes('removed');
      });

      if (denied) {
        throw new Error('Admission denied or removed from meeting');
      }

      await this._sleep(2000);
    }

    throw new Error('Admission timeout (5 minutes)');
  }

  _startWatchdog() {
    this.watchdogInterval = setInterval(async () => {
      if (this.state !== 'in-meeting') return;

      try {
        // Check if meeting ended
        const ended = await this.page.evaluate(() => {
          const body = document.body.innerText.toLowerCase();
          return body.includes('you left the meeting') ||
                 body.includes('the meeting has ended') ||
                 body.includes('has finalizado') ||
                 body.includes('saliste de la reunión') ||
                 body.includes('removed from the meeting') ||
                 body.includes('call ended') ||
                 body.includes('return to home screen');
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
