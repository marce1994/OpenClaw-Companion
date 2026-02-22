/**
 * Status Dashboard — returns an HTML page showing active meetings,
 * GPU service health, and system resources. Auto-refreshes every 10s.
 */

const os = require('os');

/**
 * Generate dashboard HTML
 * @param {import('./orchestrator').MeetOrchestrator} orchestrator
 * @returns {Promise<string>} HTML string
 */
async function generateDashboard(orchestrator) {
  const meetings = await orchestrator.listMeetings();
  const whisperOk = await pingService(process.env.WHISPER_URL || 'http://127.0.0.1:9000');
  const kokoroOk = await pingService('http://127.0.0.1:8880');

  const uptime = formatDuration(process.uptime());
  const memUsed = Math.round(process.memoryUsage.rss?.() || process.memoryUsage().rss) / 1024 / 1024;
  const totalMem = Math.round(os.totalmem() / 1024 / 1024);
  const freeMem = Math.round(os.freemem() / 1024 / 1024);

  const meetingRows = meetings.length === 0
    ? '<tr><td colspan="5" style="text-align:center;color:#888">No active meetings</td></tr>'
    : meetings.map(m => `
      <tr>
        <td><code>${m.meetingId}</code></td>
        <td>${m.botName}</td>
        <td><span class="badge badge-${m.status === 'admitted' ? 'green' : m.status === 'running' ? 'blue' : 'yellow'}">${m.status}</span></td>
        <td>${formatDuration(m.duration)}</td>
        <td><a href="${m.meetUrl}" target="_blank">${m.meetUrl.substring(0, 40)}</a></td>
      </tr>`).join('');

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="10">
<title>OpenClaw Companion — Meetings Dashboard</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 900px; margin: 2rem auto; padding: 0 1rem; background: #0d1117; color: #c9d1d9; }
  h1 { color: #58a6ff; }
  h2 { color: #8b949e; margin-top: 2rem; }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
  th, td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid #21262d; }
  th { color: #8b949e; font-weight: 600; }
  .badge { padding: 2px 8px; border-radius: 12px; font-size: 0.85rem; font-weight: 600; }
  .badge-green { background: #238636; color: #fff; }
  .badge-blue { background: #1f6feb; color: #fff; }
  .badge-yellow { background: #9e6a03; color: #fff; }
  .badge-red { background: #da3633; color: #fff; }
  .badge-gray { background: #30363d; color: #8b949e; }
  .status-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin: 1rem 0; }
  .status-card { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 1rem; }
  .status-card h3 { margin: 0 0 0.5rem; color: #8b949e; font-size: 0.85rem; text-transform: uppercase; }
  .status-card .value { font-size: 1.5rem; font-weight: 700; }
  code { background: #161b22; padding: 2px 6px; border-radius: 4px; font-size: 0.9rem; }
  a { color: #58a6ff; text-decoration: none; }
  .refresh { color: #484f58; font-size: 0.8rem; margin-top: 2rem; }
</style>
</head><body>
<h1>🎬 OpenClaw Companion</h1>

<div class="status-grid">
  <div class="status-card">
    <h3>Active Meetings</h3>
    <div class="value">${meetings.length} / ${orchestrator.maxMeetings}</div>
  </div>
  <div class="status-card">
    <h3>Whisper STT</h3>
    <div class="value"><span class="badge badge-${whisperOk ? 'green' : 'red'}">${whisperOk ? 'Online' : 'Offline'}</span></div>
  </div>
  <div class="status-card">
    <h3>Kokoro TTS</h3>
    <div class="value"><span class="badge badge-${kokoroOk ? 'green' : 'red'}">${kokoroOk ? 'Online' : 'Offline'}</span></div>
  </div>
  <div class="status-card">
    <h3>Uptime</h3>
    <div class="value">${uptime}</div>
  </div>
  <div class="status-card">
    <h3>Memory</h3>
    <div class="value">${Math.round(memUsed)}MB <span style="color:#484f58;font-size:0.8rem">/ ${totalMem}MB (${freeMem}MB free)</span></div>
  </div>
</div>

<h2>Meetings</h2>
<table>
  <thead><tr><th>ID</th><th>Bot</th><th>Status</th><th>Duration</th><th>URL</th></tr></thead>
  <tbody>${meetingRows}</tbody>
</table>

<p class="refresh">Auto-refreshes every 10 seconds. Last updated: ${new Date().toISOString()}</p>
</body></html>`;
}

/** Ping a service to check if it's online */
async function pingService(url) {
  try {
    const base = url.replace(/\/(?:asr|v1).*$/, '');
    const resp = await fetch(base, { signal: AbortSignal.timeout(3000) });
    return resp.ok || resp.status === 404; // 404 = server up, just wrong path
  } catch {
    return false;
  }
}

function formatDuration(seconds) {
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

module.exports = { generateDashboard };
