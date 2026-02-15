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
  memory.addEntry(entry);
  aiResponder.onTranscript(entry);
});

meetJoiner.on('joined', async () => {
  console.log(LOG, 'Joined meeting — starting audio pipeline');
  audioPipeline.startCapture();
  transcriber.start();
  aiResponder.connect();

  // Inject Live2D avatar into Meet page
  if (config.live2dEnabled && meetJoiner.page) {
    const success = await live2d.injectIntoMeet(meetJoiner.page);
    if (success) {
      console.log(LOG, 'Live2D avatar active as camera feed');

      // Try to enable camera in Meet now that we have Live2D
      try {
        await meetJoiner.page.evaluate(() => {
          // Click camera toggle to turn it ON
          const camBtn = document.querySelector(
            '[aria-label*="camera" i][data-is-muted="true"], ' +
            '[aria-label*="cámara" i][data-is-muted="true"]'
          );
          if (camBtn) {
            camBtn.click();
            console.log('[MeetBot] Enabled camera for Live2D');
          }
        });
      } catch (e) {
        console.log(LOG, 'Could not auto-enable camera:', e.message);
      }
    }
  }
});

// Lip sync during TTS playback
aiResponder.on('speaking-start', () => {
  if (config.live2dEnabled && meetJoiner.page && live2d.active) {
    live2d.startLipSync(meetJoiner.page);
  }
});

aiResponder.on('speaking-end', () => {
  if (config.live2dEnabled && meetJoiner.page && live2d.active) {
    live2d.stopLipSync(meetJoiner.page);
  }
});

meetJoiner.on('meeting-ended', async () => {
  console.log(LOG, 'Meeting ended — cleaning up');
  await stopPipeline();
  calendar.onMeetingEnded();
  const filePath = await memory.endMeeting();
  if (filePath) {
    console.log(LOG, `Transcript saved: ${filePath}`);
  }
});

// --- Calendar auto-join ---
calendar.on('join', async ({ meetLink, event }) => {
  if (meetJoiner.getState() !== 'idle' && meetJoiner.getState() !== 'error') {
    console.log(LOG, `Calendar: can't auto-join "${event.summary}" — already in a meeting`);
    return;
  }

  console.log(LOG, `Calendar: auto-joining "${event.summary}"`);
  memory.startMeeting(meetLink, event.summary);
  aiResponder.setMeetingId(extractMeetId(meetLink));

  meetJoiner.join(meetLink).catch(err => {
    console.error(LOG, 'Calendar auto-join error:', err.message);
  });
});

calendar.on('leave', async ({ event }) => {
  if (meetJoiner.getState() === 'idle') return;

  console.log(LOG, `Calendar: event "${event.summary}" ended — auto-leaving`);
  meetJoiner.leave().then(async () => {
    const filePath = await memory.endMeeting();
    if (filePath) console.log(LOG, `Transcript saved: ${filePath}`);
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

memory.on('meeting-ended', (info) => {
  console.log(LOG, `Meeting summary available: ${info.entryCount} entries, duration: ${Math.round(info.duration / 60000)}min`);
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
  if (method === 'GET' && (url.pathname.startsWith('/live2d') || url.pathname === '/live2d.html')) {
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
      aiResponder.setMeetingId(extractMeetId(meetLink));

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
        const filePath = await memory.endMeeting();
        console.log(LOG, 'Left and saved transcript:', filePath);
      }).catch(err => {
        console.error(LOG, 'Leave error:', err.message);
      });

      return respond(res, 202, { status: 'leaving' });
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
        aiResponder.setMeetingId(extractMeetId(parts[1]));
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
