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
   * Cleanup orphaned meet-worker containers on startup
   * Finds containers with label openclaw.companion.role=meet-worker and removes them
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
          if (containerInfo.State !== 'exited') {
            console.log(`🧹 Stopping orphaned meet-worker: ${containerInfo.Names[0] || containerInfo.Id.slice(0, 12)}`);
            await container.stop({ t: 10 });
          }
          console.log(`🧹 Removing orphaned meet-worker: ${containerInfo.Names[0] || containerInfo.Id.slice(0, 12)}`);
          await container.remove();
        } catch (err) {
          console.error(`⚠️ Failed to remove orphaned container ${containerInfo.Id.slice(0, 12)}: ${err.message}`);
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
      // Create container
      const container = await this.docker.createContainer({
        Image: 'meet-bot:v6',
        name: containerName,
        Hostname: containerName,
        HostConfig: {
          NetworkMode: 'host',
          AutoRemove: true,
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
          `KOKORO_URL=http://127.0.0.1:8880`,
          `HAIKU_MODEL=anthropic/claude-haiku-4-5`,
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

      // Set admission timeout (5 min)
      const admissionTimer = setTimeout(() => {
        this._destroyMeeting(meetingId, 'Admission timeout');
      }, 5 * 60 * 1000);
      this.admissionTimers.set(meetingId, admissionTimer);

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
   * Destroy a meeting: stop container, clean up state
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
