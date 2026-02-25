const http = require('http');
const fs = require('fs');
const pathModule = require('path');
const config = require('./config');
const MeetJoiner = require('./meet-joiner');
const AudioPipeline = require('./audio-pipeline');
const Transcriber = require('./transcriber');
const AIResponder = require('./ai-responder');
const MeetingMemory = require('./meeting-memory');
const Live2DCanvas = require('./live2d-canvas');
const CalendarSync = require('./calendar-sync');

const LOG = '[MeetBot]';

// --- Core components ---
const memory = new MeetingMemory();
const audioPipeline = new AudioPipeline();
const transcriber = new Transcriber(audioPipeline);
const aiResponder = new AIResponder(audioPipeline, memory);
const meetJoiner = new MeetJoiner();
const live2d = new Live2DCanvas();
const calendar = new CalendarSync();

// --- Wire up events ---
transcriber.on('transcript', (entry) => {
  // Prefer Meet UI speaker detection over Resemblyzer
  const meetSpeakers = meetJoiner.getActiveSpeakers();
  if (meetSpeakers.length === 1) {
    // Single speaker — high confidence attribution
    entry.speaker = meetSpeakers[0].name;
  } else if (meetSpeakers.length > 1) {
    // Multiple speakers — list them
    entry.speaker = meetSpeakers.map(s => s.name).join('+');
  }
  // Fallback: keep Resemblyzer result (entry.speaker from transcriber)
  
  memory.addEntry(entry);
  if (config.live2dEnabled && live2d.active) {
    live2d.setStatus('thinking', `[${entry.speaker || '?'}]: ${entry.text}`, 
      { sttMs: entry.sttMs || 0 });
  }
  aiResponder._sttLatency = entry.sttMs || 0;
  aiResponder.onTranscript(entry);
});

transcriber.on('voice-start', () => {
  if (config.live2dEnabled && live2d.active) {
    live2d.setStatus('listening');
  }
});

transcriber.on('voice-end', () => {
  if (config.live2dEnabled && live2d.active) {
    live2d.setStatus('transcribing');
  }
});

// Install Live2D overrides BEFORE Meet page navigates
meetJoiner.on('browser-ready', async (page) => {
  if (config.live2dEnabled) {
    console.log(LOG, 'Installing Live2D WebCodecs overrides...');
    await live2d.installOverrides(page);
  }
});

meetJoiner.on('joined', async () => {
  console.log(LOG, 'Joined meeting — starting audio pipeline');
  audioPipeline.startCapture();
  transcriber.start();
  aiResponder.connect();

  // Inject Live2D renderer directly into Meet page (HD, 30fps+)
  if (config.live2dEnabled && meetJoiner.page) {
    await live2d.start(null); // No browser needed, renders in-page
    const success = await live2d.injectIntoMeet(meetJoiner.page);
    if (success) {
      console.log(LOG, 'Live2D avatar active as camera feed (WebCodecs mode)');
    }
  }
});

// Lip sync during TTS playback
aiResponder.on('skip', () => {
  if (config.live2dEnabled && live2d.active) {
    live2d.setStatus('idle');
  }
});

aiResponder.on('speaking-start', (stats) => {
  if (config.live2dEnabled && meetJoiner.page && live2d.active) {
    live2d.setStatus('speaking', null, stats);
    live2d.startSpeaking();
  }
});

aiResponder.on('speaking-end', () => {
  if (config.live2dEnabled && meetJoiner.page && live2d.active) {
    live2d.stopSpeaking();
  }
});

async function endMeetingWithSummary() {
  await stopPipeline();
  calendar.onMeetingEnded();
  
  // Get summary prompt BEFORE ending meeting (which resets entries)
  // Pass bot name to include in summary context
  const summaryPrompt = memory.getSummaryPrompt(config.botName);
  const filePath = await memory.endMeeting();
  if (filePath) {
    console.log(LOG, `Transcript saved: ${filePath}`);
  }
  
  // Auto-generate and send summary to Telegram via Gateway
  if (summaryPrompt && aiResponder.connected) {
    console.log(LOG, 'Generating meeting summary...');
    try {
      const crypto = require('crypto');
      const id = `meet-summary-${crypto.randomUUID().substring(0, 8)}`;
      aiResponder._send({
        type: 'req',
        id,
        method: 'chat.send',
        params: {
          sessionKey: config.gwSessionKey,
          message: summaryPrompt,
          idempotencyKey: crypto.randomUUID(),
        },
      });
      console.log(LOG, 'Summary request sent to Gateway');
    } catch (err) {
      console.error(LOG, 'Failed to send summary:', err.message);
    }
    // Give time for the summary to be sent before disconnecting
    await new Promise(r => setTimeout(r, 15000));
    aiResponder.disconnect();
  }
}

meetJoiner.on('meeting-ended', async () => {
  console.log(LOG, 'Meeting ended — cleaning up');
  await endMeetingWithSummary();
});

// Auto-leave when alone for 5 minutes
meetJoiner.on('auto-leave', async () => {
  console.log(LOG, 'Auto-leaving (alone in meeting)');
  await endMeetingWithSummary();
});

// Active speaker detection from Meet UI (blue border)
meetJoiner.on('active-speakers', (speakers) => {
  const names = speakers.map(s => s.name).join(', ');
  console.log(LOG, `Speaking: ${names}`);
});

// --- Calendar auto-join ---
calendar.on('join', async ({ meetLink, event }) => {
  if (meetJoiner.getState() !== 'idle' && meetJoiner.getState() !== 'error') {
    console.log(LOG, `Calendar: can't auto-join "${event.summary}" — already in a meeting`);
    return;
  }

  console.log(LOG, `Calendar: auto-joining "${event.summary}"`);
  memory.startMeeting(meetLink, event.summary);
  const meetId = extractMeetId(meetLink);
  aiResponder.setMeetingId(meetId);
  transcriber.setMeetingId(meetId);

  meetJoiner.join(meetLink).catch(err => {
    console.error(LOG, 'Calendar auto-join error:', err.message);
  });
});

calendar.on('leave', async ({ event }) => {
  if (meetJoiner.getState() === 'idle') return;

  console.log(LOG, `Calendar: event "${event.summary}" ended — auto-leaving`);
  meetJoiner.leave().then(async () => {
    await endMeetingWithSummary();
  }).catch(err => {
    console.error(LOG, 'Calendar auto-leave error:', err.message);
  });
});

meetJoiner.on('left', async () => {
  console.log(LOG, 'Left meeting');
  await stopPipeline();
});

meetJoiner.on('error', (err) => {
  console.error(LOG, 'Meet error:', err.message);
});

memory.on('meeting-ended', async (info) => {
  console.log(LOG, `Meeting summary available: ${info.entryCount} entries, duration: ${Math.round(info.duration / 60000)}min`);

  // Auto-generate and send summary via Gateway WS
  if (info.entryCount > 0 && info.transcript) {
    try {
      console.log(LOG, 'Generating auto-summary via AI...');
      const duration = Math.round(info.duration / 60000);
      const summaryPrompt = `You are a meeting assistant. Summarize this meeting transcript concisely.\n`
        + `Meeting: ${memory.meetLink || 'Unknown'}\n`
        + `Bot Facilitator: ${config.botName}\n`
        + `Duration: ${duration} minutes\n\n`
        + `Include:\n`
        + `- Key topics discussed\n- Decisions made\n- Action items (who does what)\n\n`
        + `Transcript:\n${info.transcript.substring(0, 8000)}\n\n`
        + `Reply with a clean markdown summary.`;

      const WebSocket = require('ws');
      const crypto = require('crypto');

      // Use a temporary WS connection if AI responder is disconnected
      const ws = new WebSocket(config.gatewayWsUrl, {
        headers: { 'Origin': 'http://127.0.0.1:18789' },
      });

      ws.on('open', () => {
        // Wait for challenge then auth
      });

      let authenticated = false;
      ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'event' && msg.event === 'connect.challenge') {
            ws.send(JSON.stringify({
              type: 'req', id: 'summary-auth',
              method: 'connect',
              params: {
                client: { id: 'meet-bot-summary', displayName: 'Meet Bot Summary', mode: 'backend', version: '1.0.0', platform: 'node' },
                role: 'operator', scopes: ['operator.admin'],
                minProtocol: 3, maxProtocol: 3,
                auth: { token: config.gatewayToken },
              },
            }));
          } else if (msg.type === 'hello-ok' || (msg.type === 'res' && msg.ok && msg.payload?.type === 'hello-ok')) {
            authenticated = true;
            // Send summary request
            ws.send(JSON.stringify({
              type: 'req', id: 'summary-req',
              method: 'chat.send',
              params: {
                sessionKey: `${config.gwSessionKey}-summary`,
                message: summaryPrompt,
                idempotencyKey: crypto.randomUUID(),
              },
            }));
            console.log(LOG, 'Summary request sent to Gateway');
          } else if (msg.type === 'event' && msg.event === 'agent') {
            const p = msg.payload || {};
            if (p.stream === 'assistant' && p.data?.text) {
              console.log(LOG, `Meeting summary:\n${p.data.text.substring(0, 500)}...`);
            }
            if (p.stream === 'lifecycle' && p.data?.phase === 'end') {
              // Done, close connection
              setTimeout(() => ws.close(), 1000);
            }
          }
        } catch (e) { /* ignore */ }
      });

      // Auto-close after 60s
      setTimeout(() => { try { ws.close(); } catch(e) {} }, 60000);
    } catch (err) {
      console.error(LOG, 'Auto-summary error:', err.message);
    }
  }
});

async function stopPipeline() {
  transcriber.stop();
  audioPipeline.stopCapture();
  aiResponder.disconnect();
  live2d.stop();
}

// --- HTTP API ---
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${config.meetPort}`);
  const method = req.method;

  // Serve static files from /public
  if (method === 'GET' && (url.pathname.startsWith('/live2d') || url.pathname === '/live2d.html' || url.pathname.startsWith('/dashboard'))) {
    const safePath = url.pathname.replace(/\.\./g, '');
    const filePath = pathModule.join(__dirname, '..', 'public', safePath);

    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = pathModule.extname(filePath).toLowerCase();
        const mimeTypes = {
          '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json',
          '.png': 'image/png', '.jpg': 'image/jpeg', '.moc3': 'application/octet-stream',
          '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
        };
        res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
        res.setHeader('Access-Control-Allow-Origin', '*');
        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
        return;
      }
    } catch (e) { /* fall through to 404 */ }

    res.writeHead(404);
    res.end('Not found');
    return;
  }

  res.setHeader('Content-Type', 'application/json');

  try {
    if (method === 'GET' && url.pathname === '/health') {
      return respond(res, 200, { ok: true, state: meetJoiner.getState() });
    }

    if (method === 'GET' && url.pathname === '/status') {
      return respond(res, 200, {
        state: meetJoiner.getState(),
        meetLink: meetJoiner.meetLink,
        transcriptEntries: memory.entries.length,
        capturing: audioPipeline.capturing,
        calendar: {
          enabled: calendar.enabled,
          currentEvent: calendar.currentEvent?.summary || null,
        },
      });
    }

    if (method === 'GET' && url.pathname === '/transcript') {
      return respond(res, 200, {
        entries: memory.getTranscript(),
        formatted: memory.getFormattedTranscript(),
      });
    }

    if (method === 'POST' && url.pathname === '/join') {
      const body = await readBody(req);
      const { meetLink, botName } = body;

      if (!meetLink) {
        return respond(res, 400, { error: 'meetLink is required' });
      }

      if (meetJoiner.getState() !== 'idle' && meetJoiner.getState() !== 'error') {
        return respond(res, 409, { error: `Cannot join: state is ${meetJoiner.getState()}` });
      }

      // Start join asynchronously
      memory.startMeeting(meetLink, '');
      const meetId = extractMeetId(meetLink);
      aiResponder.setMeetingId(meetId);
      transcriber.setMeetingId(meetId);

      meetJoiner.join(meetLink, botName).catch(err => {
        console.error(LOG, 'Join error:', err.message);
      });

      return respond(res, 202, { status: 'joining', meetLink });
    }

    if (method === 'POST' && url.pathname === '/leave') {
      if (meetJoiner.getState() === 'idle') {
        return respond(res, 400, { error: 'Not in a meeting' });
      }

      meetJoiner.leave().then(async () => {
        await endMeetingWithSummary();
      }).catch(err => {
        console.error(LOG, 'Leave error:', err.message);
      });

      return respond(res, 202, { status: 'leaving' });
    }

    // Unmute: send Ctrl+D to Meet page
    if (method === 'POST' && url.pathname === '/unmute') {
      const page = meetJoiner.page;
      if (!page) return respond(res, 400, { error: 'Not in a meeting' });
      try {
        await page.keyboard.down('Control');
        await page.keyboard.press('KeyD');
        await page.keyboard.up('Control');
        return respond(res, 200, { status: 'unmute sent' });
      } catch (e) {
        return respond(res, 500, { error: e.message });
      }
    }

    // Reset speakers
    if (method === 'POST' && url.pathname === '/reset-speakers') {
      try {
        const speakerUrl = process.env.SPEAKER_URL || 'http://127.0.0.1:3201';
        const r = await fetch(speakerUrl + '/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const data = await r.json();
        return respond(res, 200, data);
      } catch (e) {
        return respond(res, 500, { error: e.message });
      }
    }

    respond(res, 404, { error: 'Not found' });
  } catch (err) {
    console.error(LOG, 'Request error:', err.message);
    respond(res, 500, { error: err.message });
  }
});

function respond(res, status, data) {
  res.writeHead(status);
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function extractMeetId(link) {
  const match = link.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})/);
  return match ? match[1] : 'unknown';
}

// --- Stdin commands for testing ---
if (process.stdin.isTTY !== undefined) {
  const readline = require('readline');
  const rl = readline.createInterface({ input: process.stdin });

  rl.on('line', async (line) => {
    const parts = line.trim().split(/\s+/);
    const cmd = parts[0];

    switch (cmd) {
      case 'join':
        if (!parts[1]) {
          console.log('Usage: join <meet-link> [bot-name]');
          break;
        }
        memory.startMeeting(parts[1]);
        const cliMeetId = extractMeetId(parts[1]);
        aiResponder.setMeetingId(cliMeetId);
        transcriber.setMeetingId(cliMeetId);
        meetJoiner.join(parts[1], parts[2]).catch(e => console.error(e.message));
        break;

      case 'leave':
        meetJoiner.leave().then(() => memory.endMeeting()).catch(e => console.error(e.message));
        break;

      case 'status':
        console.log({
          state: meetJoiner.getState(),
          capturing: audioPipeline.capturing,
          transcripts: memory.entries.length,
        });
        break;

      case 'transcript':
        console.log(memory.getFormattedTranscript() || '(empty)');
        break;

      case 'quit':
      case 'exit':
        await meetJoiner.leave().catch(() => {});
        process.exit(0);
        break;

      default:
        console.log('Commands: join <link> [name], leave, status, transcript, quit');
    }
  });
}

// --- Start server ---
server.listen(config.meetPort, () => {
  console.log(LOG, `HTTP API listening on port ${config.meetPort}`);
  console.log(LOG, `Bot name: ${config.botName}`);
  console.log(LOG, `Whisper: ${config.whisperUrl}`);
  console.log(LOG, `Gateway: ${config.gatewayWsUrl}`);
  console.log(LOG, `TTS: ${config.ttsEngine} (${config.ttsEngine === 'kokoro' ? config.kokoroUrl : config.ttsVoice})`);
  console.log(LOG, `Live2D: ${config.live2dEnabled ? config.live2dModel : 'disabled'}`);
  console.log(LOG, `Calendar: ${config.calendarIcsUrl ? 'enabled' : 'disabled (set GOOGLE_CALENDAR_ICS to enable)'}`);
  console.log(LOG, 'Ready. POST /join to start.');

  // Start calendar sync
  calendar.start();

  // --- Auto-join on startup if MEETING_URL env var is set ---
  if (process.env.MEETING_URL) {
    const meetingUrl = process.env.MEETING_URL;
    const botName = process.env.BOT_NAME || config.botName;
    console.log(LOG, `Auto-joining meeting from MEETING_URL env: ${meetingUrl}`);
    setTimeout(async () => {
      try {
        memory.startMeeting(meetingUrl, '');
        const meetId = extractMeetId(meetingUrl);
        aiResponder.setMeetingId(meetId);
        transcriber.setMeetingId(meetId);
        await meetJoiner.join(meetingUrl, botName);
      } catch (err) {
        console.error(LOG, 'Auto-join error:', err.message);
      }
    }, 1000);
  }
});

// --- Graceful shutdown ---
async function shutdown(signal) {
  console.log(LOG, `${signal} received, shutting down...`);
  try {
    await meetJoiner.leave();
    await memory.endMeeting();
  } catch (e) { /* ignore */ }
  server.close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
  console.error(LOG, 'Uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error(LOG, 'Unhandled rejection:', err);
});
