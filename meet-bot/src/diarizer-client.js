/**
 * Diarizer Client — Connects to the Diart diarization service via WebSocket.
 * 
 * Forwards audio from AudioPipeline to the diarizer service and receives
 * real-time speaker labels. These labels are used to attribute transcripts
 * to the correct speaker.
 */

const { EventEmitter } = require('events');
const WebSocket = require('ws');

const LOG = '[DiarizClient]';
const RECONNECT_DELAY = 3000;

class DiarizerClient extends EventEmitter {
  constructor(audioPipeline) {
    super();
    this.audioPipeline = audioPipeline;
    this.url = process.env.DIARIZER_URL || 'ws://127.0.0.1:3202';
    this.ws = null;
    this.active = false;
    this.reconnecting = false;
    this.currentSpeakers = {};  // { Speaker_1: { start, end }, ... }
    this.speakerHistory = [];   // [{ speaker, start, end }]
    this._onAudio = (chunk) => this._sendAudio(chunk);
  }

  start() {
    if (this.active) return;
    this.active = true;
    this._connect();
    this.audioPipeline.on('audio', this._onAudio);
    console.log(LOG, `Started, connecting to ${this.url}`);
  }

  stop() {
    this.active = false;
    this.audioPipeline.off('audio', this._onAudio);
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    console.log(LOG, `Stopped. ${this.speakerHistory.length} speaker events recorded.`);
  }

  /**
   * Get the current active speaker(s).
   * Returns the speaker with the most recent activity.
   */
  getCurrentSpeaker() {
    const speakers = Object.keys(this.currentSpeakers);
    if (speakers.length === 0) return null;
    if (speakers.length === 1) return speakers[0];
    // Multiple speakers — return the one with latest end time
    let latest = null;
    let latestEnd = 0;
    for (const [name, info] of Object.entries(this.currentSpeakers)) {
      if (info.end > latestEnd) {
        latestEnd = info.end;
        latest = name;
      }
    }
    return latest;
  }

  /**
   * Get speaker at a specific timestamp (relative to stream start).
   * Looks back through history for the closest match.
   */
  getSpeakerAtTime(timestamp) {
    // Find the most recent speaker event before this timestamp
    for (let i = this.speakerHistory.length - 1; i >= 0; i--) {
      const event = this.speakerHistory[i];
      if (event.wallTime <= timestamp && timestamp - event.wallTime < 5000) {
        return event.speaker;
      }
    }
    return this.getCurrentSpeaker();
  }

  /**
   * Rename a speaker in the diarizer service.
   */
  rename(oldName, newName) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'rename', old: oldName, new: newName }));
      console.log(LOG, `Rename request: ${oldName} → ${newName}`);
    }
  }

  _connect() {
    if (!this.active) return;

    try {
      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        console.log(LOG, 'Connected to diarizer service');
        this.reconnecting = false;
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          
          if (msg.type === 'speakers') {
            this.currentSpeakers = msg.speakers || {};
            this.emit('speakers', this.currentSpeakers);
          } else if (msg.type === 'speaker-start') {
            this.speakerHistory.push({
              speaker: msg.speaker,
              event: 'start',
              streamTime: msg.start,
              wallTime: Date.now(),
            });
            this.emit('speaker-start', msg.speaker);
            console.log(LOG, `Speaker started: ${msg.speaker}`);
          } else if (msg.type === 'speaker-end') {
            this.speakerHistory.push({
              speaker: msg.speaker,
              event: 'end',
              streamTime: msg.end,
              wallTime: Date.now(),
            });
            this.emit('speaker-end', msg.speaker);
          } else if (msg.type === 'status') {
            console.log(LOG, `Status: ${JSON.stringify(msg)}`);
          }
        } catch (e) {
          // ignore parse errors
        }
      });

      this.ws.on('close', () => {
        if (this.active && !this.reconnecting) {
          this.reconnecting = true;
          console.log(LOG, `Disconnected, reconnecting in ${RECONNECT_DELAY}ms...`);
          setTimeout(() => this._connect(), RECONNECT_DELAY);
        }
      });

      this.ws.on('error', (err) => {
        if (!this.reconnecting) {
          console.error(LOG, `WS error: ${err.message}`);
        }
      });
    } catch (e) {
      console.error(LOG, `Connect error: ${e.message}`);
      if (this.active) {
        setTimeout(() => this._connect(), RECONNECT_DELAY);
      }
    }
  }

  _sendAudio(chunk) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(chunk);
    }
  }
}

module.exports = DiarizerClient;
