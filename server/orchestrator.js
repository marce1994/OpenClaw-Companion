/**
 * Meet Orchestrator — manages multiple ephemeral meet-bot worker containers
 * via Docker API. Each worker is an isolated meet-bot:v6 container with its
 * own Chromium, Xvfb, PulseAudio, and Live2D instance.
 *
 * Workers connect to the Gateway with unique session keys (meet-{shortId}).
 * Shared GPU services (Whisper, Kokoro) are accessed via localhost (host network).
 */

const crypto = require('crypto');
const Docker = require('dockerode');

const IMAGE = 'meet-bot:v6';
const LABEL_ROLE = 'openclaw.companion.role';
const LABEL_MEETING = 'openclaw.companion.meeting';
const ROLE_VALUE = 'meet-worker';

const HEALTH_POLL_MS = 30_000;       // Check container health every 30s
const ADMISSION_TIMEOUT_MS = 5 * 60_000; // 5 min to get admitted or destroy

class MeetOrchestrator {
  /**
   * @param {object} opts
   * @param {string} [opts.dockerSocket] — path to Docker socket
   * @param {number} [opts.maxMeetings] — max concurrent meetings (default 5)
   */
  constructor(opts = {}) {
    this.docker = new Docker({ socketPath: opts.dockerSocket || '/var/run/docker.sock' });
    this.maxMeetings = opts.maxMeetings || 5;

    // meetingId → { containerId, meetUrl, botName, startedAt, status, container }
    this.meetings = new Map();
    this._healthTimer = null;
  }

  /** Start orchestrator: clean up orphans and begin health monitoring */
  async start() {
    await this._cleanupOrphans();
    this._healthTimer = setInterval(() => this._healthCheck(), HEALTH_POLL_MS);
    console.log(`🎬 Orchestrator started (max ${this.maxMeetings} meetings)`);
  }

  /** Stop orchestrator: clear timers */
  stop() {
    if (this._healthTimer) clearInterval(this._healthTimer);
    for (const m of this.meetings.values()) {
      if (m._admissionTimer) clearTimeout(m._admissionTimer);
    }
    console.log('🎬 Orchestrator stopped');
  }

  /**
   * Join a meeting — spin up a new worker container.
   * @param {string} meetUrl — Google Meet URL
   * @param {string} [botName='Jarvis'] — display name for the bot
   * @returns {{ meetingId: string, status: string }}
   */
  async joinMeeting(meetUrl, botName = 'Jarvis') {
    if (this.meetings.size >= this.maxMeetings) {
      throw new Error(`Max concurrent meetings (${this.maxMeetings}) reached`);
    }

    const shortId = crypto.randomBytes(4).toString('hex');
    const meetingId = `meet-${shortId}`;
    const sessionKey = meetingId;

    const env = [
      `MEETING_URL=${meetUrl}`,
      `BOT_NAME=${botName}`,
      `GATEWAY_WS_URL=${process.env.GATEWAY_WS_URL || 'ws://127.0.0.1:18789'}`,
      `GATEWAY_TOKEN=${process.env.GATEWAY_TOKEN || ''}`,
      `GW_SESSION_KEY=${sessionKey}`,
      `WHISPER_URL=${process.env.WHISPER_URL || 'http://127.0.0.1:9000'}`,
      `KOKORO_URL=http://127.0.0.1:8880`,
      `HAIKU_MODEL=anthropic/claude-haiku-4-5`,
    ];

    console.log(`🚀 Starting worker ${meetingId} for ${meetUrl}`);

    const container = await this.docker.createContainer({
      Image: IMAGE,
      name: `meet-worker-${shortId}`,
      Env: env,
      Labels: {
        [LABEL_MEETING]: meetingId,
        [LABEL_ROLE]: ROLE_VALUE,
      },
      HostConfig: {
        NetworkMode: 'host',
        AutoRemove: true,
        // Give containers enough shm for Chromium
        ShmSize: 2 * 1024 * 1024 * 1024, // 2GB
      },
    });

    await container.start();

    const meeting = {
      meetingId,
      containerId: container.id,
      meetUrl,
      botName,
      sessionKey,
      startedAt: new Date(),
      status: 'starting',
      container,
      _admissionTimer: setTimeout(() => this._admissionTimeout(meetingId), ADMISSION_TIMEOUT_MS),
    };

    this.meetings.set(meetingId, meeting);
    console.log(`✅ Worker ${meetingId} started (container ${container.id.substring(0, 12)})`);

    return { meetingId, status: 'starting' };
  }

  /**
   * Leave a meeting — stop and remove the worker container.
   * @param {string} meetingId
   */
  async leaveMeeting(meetingId) {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) throw new Error(`Meeting ${meetingId} not found`);

    console.log(`🛑 Stopping worker ${meetingId}`);
    if (meeting._admissionTimer) clearTimeout(meeting._admissionTimer);

    try {
      const container = this.docker.getContainer(meeting.containerId);
      await container.stop({ t: 10 }).catch(() => {}); // may already be stopped
    } catch (e) {
      console.warn(`⚠️ Error stopping container for ${meetingId}: ${e.message}`);
    }

    this.meetings.delete(meetingId);
    return { ok: true };
  }

  /** List all active meetings */
  async listMeetings() {
    const list = [];
    for (const m of this.meetings.values()) {
      list.push({
        meetingId: m.meetingId,
        meetUrl: m.meetUrl,
        botName: m.botName,
        status: m.status,
        startedAt: m.startedAt.toISOString(),
        duration: Math.floor((Date.now() - m.startedAt.getTime()) / 1000),
      });
    }
    return list;
  }

  /** Get detailed status for one meeting */
  async getMeetingStatus(meetingId) {
    const m = this.meetings.get(meetingId);
    if (!m) return null;

    let containerState = 'unknown';
    try {
      const info = await this.docker.getContainer(m.containerId).inspect();
      containerState = info.State?.Status || 'unknown';
    } catch { /* container may be gone */ }

    return {
      meetingId: m.meetingId,
      meetUrl: m.meetUrl,
      botName: m.botName,
      status: m.status,
      containerState,
      sessionKey: m.sessionKey,
      startedAt: m.startedAt.toISOString(),
      duration: Math.floor((Date.now() - m.startedAt.getTime()) / 1000),
    };
  }

  /** Mark a meeting as admitted (call from external signal if available) */
  markAdmitted(meetingId) {
    const m = this.meetings.get(meetingId);
    if (m) {
      m.status = 'admitted';
      if (m._admissionTimer) { clearTimeout(m._admissionTimer); m._admissionTimer = null; }
      console.log(`✅ Meeting ${meetingId} admitted`);
    }
  }

  // ─── Internal ───────────────────────────────────────────────────────────

  /** Admission timeout — destroy worker if not admitted within 5 min */
  async _admissionTimeout(meetingId) {
    const m = this.meetings.get(meetingId);
    if (!m || m.status === 'admitted') return;

    console.log(`⏰ Admission timeout for ${meetingId}, destroying worker`);
    try { await this.leaveMeeting(meetingId); } catch (e) {
      console.error(`Error cleaning up timed-out meeting ${meetingId}: ${e.message}`);
    }
  }

  /** Poll container status, detect crashes */
  async _healthCheck() {
    for (const [meetingId, m] of this.meetings) {
      try {
        const info = await this.docker.getContainer(m.containerId).inspect();
        const state = info.State?.Status;

        if (state === 'running') {
          if (m.status === 'starting') m.status = 'running';
        } else if (state === 'exited' || !state) {
          console.log(`💀 Worker ${meetingId} exited (state=${state})`);
          if (m._admissionTimer) clearTimeout(m._admissionTimer);
          this.meetings.delete(meetingId);
        }
      } catch (e) {
        // Container gone (auto-removed)
        console.log(`💀 Worker ${meetingId} disappeared: ${e.message}`);
        if (m._admissionTimer) clearTimeout(m._admissionTimer);
        this.meetings.delete(meetingId);
      }
    }
  }

  /** On startup: find and remove any leftover meet-worker containers */
  async _cleanupOrphans() {
    try {
      const containers = await this.docker.listContainers({
        all: true,
        filters: { label: [`${LABEL_ROLE}=${ROLE_VALUE}`] },
      });

      if (containers.length === 0) return;
      console.log(`🧹 Cleaning up ${containers.length} orphan meet-worker container(s)`);

      for (const c of containers) {
        try {
          const container = this.docker.getContainer(c.Id);
          if (c.State === 'running') await container.stop({ t: 5 }).catch(() => {});
          await container.remove({ force: true }).catch(() => {});
          console.log(`  ✓ Removed ${c.Names?.[0] || c.Id.substring(0, 12)}`);
        } catch (e) {
          console.warn(`  ✗ Failed to remove ${c.Id.substring(0, 12)}: ${e.message}`);
        }
      }
    } catch (e) {
      console.warn(`⚠️ Orphan cleanup failed (Docker socket available?): ${e.message}`);
    }
  }
}

module.exports = { MeetOrchestrator };
