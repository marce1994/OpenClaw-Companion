/**
 * MeetOrchestrator — Manages ephemeral meet-bot worker containers
 *
 * Responsibilities:
 * - Create/destroy worker containers via Docker API
 * - Track container lifecycle and health
 * - Auto-cleanup orphaned containers on startup
 * - Enforce admission timeout (5 min) and max concurrent meetings
 *
 * Worker container lifecycle:
 * 1. Created with unique GW_SESSION_KEY=meet-{shortId}
 * 2. Connects to Gateway WS with that key
 * 3. Gateway sends "admitted" event → worker starts meeting
 * 4. Worker runs until meeting ends or container times out
 * 5. Container removed from Docker
 */

const Docker = require('dockerode');
const crypto = require('crypto');

class MeetOrchestrator {
  constructor(dockerSocket = '/var/run/docker.sock', maxConcurrentMeetings = 5) {
    this.docker = new Docker({ socketPath: dockerSocket });
    this.maxMeetings = maxConcurrentMeetings;
    this.meetings = new Map(); // meetingId → {containerId, startedAt, status, meetUrl, botName, participants, transcriptCount}
    this.admissionTimers = new Map(); // meetingId → timeoutHandle
    this.healthCheckInterval = null;
    
    console.log(`🎬 MeetOrchestrator initialized (max ${maxConcurrentMeetings} concurrent meetings)`);
  }

  /**
   * Generate a unique short ID for the meeting
   */
  _generateShortId() {
    return crypto.randomBytes(6).toString('hex');
  }

  /**
   * Re-adopt or cleanup orphaned meet-worker containers on startup
   * Running workers are re-adopted into the meetings map; exited ones are removed
   */
  async cleanupOrphans() {
    try {
      const containers = await this.docker.listContainers({
        all: true,
        filters: {
          label: ['openclaw.companion.role=meet-worker']
        }
      });

      for (const containerInfo of containers) {
        const container = this.docker.getContainer(containerInfo.Id);
        try {
          if (containerInfo.State === 'running') {
            // Re-adopt running worker
            const meetingId = containerInfo.Labels['openclaw.companion.meeting'] || containerInfo.Id.slice(0, 12);
            const name = containerInfo.Names[0]?.replace(/^\//, '') || containerInfo.Id.slice(0, 12);
            console.log(`♻️ Re-adopting running meet-worker: ${name} (meeting ${meetingId})`);

            // Try to get status from worker
            let meetUrl = '', workerState = 'in-meeting', transcriptCount = 0;
            try {
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 3000);
              const res = await fetch('http://127.0.0.1:3300/status', { signal: controller.signal });
              clearTimeout(timeout);
              const status = await res.json();
              meetUrl = status.meetLink || '';
              workerState = status.state || 'in-meeting';
              transcriptCount = status.transcriptEntries || 0;
            } catch (_) { /* worker not responding, assume in-meeting */ }

            this.meetings.set(meetingId, {
              containerId: containerInfo.Id,
              startedAt: new Date(containerInfo.Created * 1000).getTime(),
              status: workerState,
              meetUrl,
              botName: 'Jarvis',
              participants: 0,
              transcriptCount,
              containerName: name,
            });

            if (!this.healthCheckInterval) this._startHealthCheck();
          } else {
            // Remove exited containers
            console.log(`🧹 Removing exited meet-worker: ${containerInfo.Names[0] || containerInfo.Id.slice(0, 12)}`);
            await container.remove();
          }
        } catch (err) {
          console.error(`⚠️ Failed to handle orphaned container ${containerInfo.Id.slice(0, 12)}: ${err.message}`);
        }
      }
    } catch (err) {
      console.error(`⚠️ Orphan cleanup failed: ${err.message}`);
    }
  }

  /**
   * Create and start a worker container for a meeting
   */
  async joinMeeting(meetUrl, botName = 'Jarvis', gatewayToken = '', gatewayWsUrl = 'ws://127.0.0.1:18789') {
    // Check max concurrent meetings
    const activeMeetings = Array.from(this.meetings.values()).filter(m => 
      m.status === 'pending' || m.status === 'admitted' || m.status === 'running'
    );
    
    if (activeMeetings.length >= this.maxMeetings) {
      throw new Error(`Max concurrent meetings (${this.maxMeetings}) reached`);
    }

    const meetingId = this._generateShortId();
    const sessionKey = `meet-${meetingId}`;
    const containerName = `meet-bot-${meetingId}`;

    try {
      // Shared meetings directory for data exchange with summary-worker
      const meetingsHostDir = process.env.MEETINGS_HOST_DIR || '/tmp/meetings';

      // Create container
      const container = await this.docker.createContainer({
        Image: process.env.MEET_BOT_IMAGE || 'meet-bot:latest',
        name: containerName,
        Hostname: containerName,
        HostConfig: {
          NetworkMode: 'host',
          AutoRemove: false,
          Binds: [
            `${meetingsHostDir}:/data/meetings`,
          ],
        },
        Labels: {
          'openclaw.companion.meeting': meetingId,
          'openclaw.companion.role': 'meet-worker',
        },
        Env: [
          `MEETING_URL=${meetUrl}`,
          `BOT_NAME=${botName}`,
          `GATEWAY_WS_URL=${gatewayWsUrl}`,
          `GATEWAY_TOKEN=${gatewayToken}`,
          `GW_SESSION_KEY=${sessionKey}`,
          `WHISPER_URL=http://127.0.0.1:9000`,
          `KOKORO_URL=http://127.0.0.1:5004`,
          `HAIKU_MODEL=anthropic/claude-haiku-4-5`,
          `MEETINGS_DIR=/data/meetings`,
          `RECORD_AUDIO=true`,
        ],
      });

      // Start container
      await container.start();

      // Register meeting
      this.meetings.set(meetingId, {
        containerId: container.id,
        startedAt: Date.now(),
        status: 'pending', // Waiting for "admitted" from Gateway
        meetUrl,
        botName,
        participants: 0,
        transcriptCount: 0,
        containerName,
      });

      console.log(`🎬 Started worker for meeting ${meetingId}: ${meetUrl}`);

      // No admission timeout — container health check handles cleanup
      // Meet-bot auto-leaves after 5min alone, container exits, health check removes it

      // Start health check if not already running
      if (!this.healthCheckInterval) {
        this._startHealthCheck();
      }

      return { meetingId, status: 'pending' };
    } catch (err) {
      console.error(`❌ Failed to join meeting: ${err.message}`);
      throw err;
    }
  }

  /**
   * Stop and remove a worker container
   */
  async leaveMeeting(meetingId) {
    if (!this.meetings.has(meetingId)) {
      throw new Error(`Meeting ${meetingId} not found`);
    }

    await this._destroyMeeting(meetingId, 'User requested');
    return { ok: true };
  }

  /**
   * Mark a meeting as admitted (called by Gateway when worker connects)
   */
  markAdmitted(meetingId) {
    const meeting = this.meetings.get(meetingId);
    if (meeting) {
      meeting.status = 'admitted';
      // Clear admission timeout
      const timer = this.admissionTimers.get(meetingId);
      if (timer) {
        clearTimeout(timer);
        this.admissionTimers.delete(meetingId);
      }
      console.log(`✅ Meeting ${meetingId} admitted`);
    }
  }

  /**
   * Update meeting status (called by worker via gateway)
   */
  updateMeetingStatus(meetingId, statusUpdate) {
    const meeting = this.meetings.get(meetingId);
    if (meeting) {
      meeting.status = statusUpdate.status || meeting.status;
      if (statusUpdate.participants !== undefined) meeting.participants = statusUpdate.participants;
      if (statusUpdate.transcriptCount !== undefined) meeting.transcriptCount = statusUpdate.transcriptCount;
    }
  }

  /**
   * List all active meetings
   */
  listMeetings() {
    const result = [];
    for (const [meetingId, meeting] of this.meetings.entries()) {
      const now = Date.now();
      const duration = now - meeting.startedAt;
      result.push({
        meetingId,
        meetUrl: meeting.meetUrl,
        botName: meeting.botName,
        status: meeting.status,
        duration: Math.floor(duration / 1000), // seconds
        startedAt: new Date(meeting.startedAt).toISOString(),
      });
    }
    return result;
  }

  /**
   * Get status of a specific meeting
   */
  getMeetingStatus(meetingId) {
    if (!this.meetings.has(meetingId)) {
      return null;
    }

    const meeting = this.meetings.get(meetingId);
    const now = Date.now();
    const duration = now - meeting.startedAt;

    return {
      meetingId,
      meetUrl: meeting.meetUrl,
      botName: meeting.botName,
      status: meeting.status,
      duration: Math.floor(duration / 1000),
      startedAt: new Date(meeting.startedAt).toISOString(),
      participants: meeting.participants,
      transcriptCount: meeting.transcriptCount,
      containerName: meeting.containerName,
    };
  }

  /**
   * Get orchestrator status
   */
  getStatus() {
    const activeMeetings = Array.from(this.meetings.values()).filter(m =>
      m.status === 'pending' || m.status === 'admitted' || m.status === 'running'
    );

    return {
      activeMeetings: activeMeetings.length,
      maxMeetings: this.maxMeetings,
      meetings: this.listMeetings(),
    };
  }

  /**
   * Health check: poll container status every 30s, detect crashes
   */
  _startHealthCheck() {
    this.healthCheckInterval = setInterval(async () => {
      for (const [meetingId, meeting] of this.meetings.entries()) {
        try {
          const container = this.docker.getContainer(meeting.containerId);
          const info = await container.inspect();

          // If container exited, clean up the meeting
          if (!info.State.Running) {
            const exitCode = info.State.ExitCode;
            const reason = `Container exited with code ${exitCode}`;
            console.warn(`⚠️ Meeting ${meetingId} container exited: ${reason}`);
            await this._destroyMeeting(meetingId, reason);
          } else {
            // Poll worker status via HTTP
            try {
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 5000);
              const res = await fetch(`http://127.0.0.1:3300/status`, { signal: controller.signal });
              clearTimeout(timeout);
              const workerStatus = await res.json();
              if (workerStatus.state && workerStatus.state !== meeting.status) {
                console.log(`📊 Meeting ${meetingId} status: ${meeting.status} → ${workerStatus.state}`);
                meeting.status = workerStatus.state;
              }
              if (workerStatus.transcriptEntries !== undefined) {
                meeting.transcriptCount = workerStatus.transcriptEntries;
              }
            } catch (_) { /* worker not ready yet, ignore */ }
          }
        } catch (err) {
          // Container not found or other error
          console.error(`⚠️ Health check failed for meeting ${meetingId}: ${err.message}`);
          await this._destroyMeeting(meetingId, `Health check error: ${err.message}`);
        }
      }

      // Stop health check if no more meetings
      if (this.meetings.size === 0 && this.healthCheckInterval) {
        clearInterval(this.healthCheckInterval);
        this.healthCheckInterval = null;
        console.log(`🧹 Health check stopped (no active meetings)`);
      }
    }, 30 * 1000); // Every 30 seconds
  }

  /**
   * Destroy a meeting: stop container, launch summary worker, clean up state
   */
  async _destroyMeeting(meetingId, reason = 'Unknown') {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) return;

    // Clear admission timer if still pending
    const timer = this.admissionTimers.get(meetingId);
    if (timer) {
      clearTimeout(timer);
      this.admissionTimers.delete(meetingId);
    }

    try {
      const container = this.docker.getContainer(meeting.containerId);
      try {
        await container.stop({ t: 10 });
      } catch (err) {
        // Already stopped
      }
      try {
        await container.remove();
      } catch (err) {
        // May fail if auto-remove is enabled
      }
    } catch (err) {
      console.error(`⚠️ Failed to destroy container for meeting ${meetingId}: ${err.message}`);
    }

    this.meetings.delete(meetingId);
    console.log(`🛑 Meeting ${meetingId} destroyed: ${reason}`);

    // Launch summary-worker (fire and forget)
    this._launchSummaryWorker(meetingId, meeting).catch(err => {
      console.error(`⚠️ Failed to launch summary worker for ${meetingId}: ${err.message}`);
    });
  }

  /**
   * Launch ephemeral summary-worker container for post-meeting processing.
   * The worker handles: WhisperX diarization → AI summary → Telegram → Cognee.
   */
  async _launchSummaryWorker(meetingId, meeting) {
    // Load summary config (fallback for env vars not set on voice-server)
    let cfg = {};
    try {
      const fs = require('fs');
      const cfgPath = require('path').join(__dirname, 'summary-config.json');
      if (fs.existsSync(cfgPath)) {
        cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      }
    } catch (_) {}

    const meetId = this._extractMeetId(meeting.meetUrl);
    const dataDir = process.env.MEETINGS_HOST_DIR || cfg.meetings_host_dir || '/tmp/meetings';
    const meetingDataDir = `${dataDir}/${meetId}`;
    const memoryDir = process.env.MEMORY_HOST_DIR || cfg.memory_host_dir || '/home/node/.openclaw/workspace/memory';
    const containerName = `summary-worker-${meetingId}`;

    console.log(`📝 Launching summary-worker for meeting ${meetingId} (${meetId})`);

    try {
      const container = await this.docker.createContainer({
        Image: 'summary-worker:latest',
        name: containerName,
        HostConfig: {
          NetworkMode: 'host',
          AutoRemove: true,
          Binds: [
            `${meetingDataDir}:/data`,
            `${memoryDir}:/memory`,
            '/var/run/docker.sock:/var/run/docker.sock',
          ],
        },
        Labels: {
          'openclaw.companion.role': 'summary-worker',
          'openclaw.companion.meeting': meetingId,
        },
        Env: [
          `MEETING_ID=${meetId}`,
          `MEETING_DATA_DIR=/data`,
          `MEMORY_DIR=/memory`,
          `OPENROUTER_API_KEY=${process.env.OPENROUTER_API_KEY || cfg.openrouter_api_key || ''}`,
          `TELEGRAM_BOT_TOKEN=${process.env.TELEGRAM_BOT_TOKEN || cfg.telegram_bot_token || ''}`,
          `TELEGRAM_CHAT_ID=${process.env.TELEGRAM_CHAT_ID || cfg.telegram_chat_id || ''}`,
          `COGNEE_URL=${process.env.COGNEE_URL || cfg.cognee_url || 'http://172.17.0.1:8000'}`,
          `COGNEE_USER=${process.env.COGNEE_USER || cfg.cognee_user || 'jarvis@openclaw.dev'}`,
          `COGNEE_PASSWORD=${process.env.COGNEE_PASSWORD || cfg.cognee_password || ''}`,
          `WHISPERX_IMAGE=${process.env.WHISPERX_IMAGE || cfg.whisperx_image || 'whisperx-api:latest'}`,
          `HF_TOKEN=${process.env.HF_TOKEN || cfg.hf_token || ''}`,
          `DOCKER_SOCKET=/var/run/docker.sock`,
        ],
      });

      await container.start();
      console.log(`📝 Summary worker started: ${containerName}`);
    } catch (err) {
      console.error(`❌ Summary worker launch failed: ${err.message}`);
    }
  }

  _extractMeetId(link) {
    if (!link) return 'unknown';
    const match = link.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})/);
    return match ? match[1] : 'unknown';
  }

  /**
   * Shutdown: stop all containers and health check
   */
  async shutdown() {
    console.log(`🛑 MeetOrchestrator shutting down...`);
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
      this.healthCheckInterval = null;
    }

    const meetingIds = Array.from(this.meetings.keys());
    for (const meetingId of meetingIds) {
      await this._destroyMeeting(meetingId, 'Orchestrator shutdown');
    }

    console.log(`✅ MeetOrchestrator shutdown complete`);
  }
}

module.exports = MeetOrchestrator;
