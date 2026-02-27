const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const config = require('./config');

const LOG = '[Memory]';

class MeetingMemory extends EventEmitter {
  constructor() {
    super();
    this.entries = [];
    this.meetingStart = null;
    this.meetingEnd = null;
    this.topic = '';
    this.meetLink = '';
  }

  startMeeting(meetLink, topic = '') {
    this.entries = [];
    this.meetingStart = new Date();
    this.meetingEnd = null;
    this.meetLink = meetLink;
    this.topic = topic || this._extractMeetId(meetLink);
    console.log(LOG, `Meeting started: ${this.topic}`);
  }

  addEntry(entry) {
    this.entries.push({
      text: entry.text,
      speaker: entry.speaker || 'Unknown',
      timestamp: entry.timestamp || Date.now(),
    });
  }

  getTranscript() {
    return [...this.entries];
  }

  getFormattedTranscript() {
    if (this.entries.length === 0) return '';

    return this.entries.map(e => {
      const time = new Date(e.timestamp).toLocaleTimeString('en-US', { hour12: false });
      const speaker = e.speaker || 'Participant';
      return `[${time}] ${speaker}: ${e.text}`;
    }).join('\n');
  }

  async endMeeting() {
    this.meetingEnd = new Date();
    console.log(LOG, `Meeting ended. ${this.entries.length} transcript entries.`);

    if (this.entries.length === 0) {
      console.log(LOG, 'No transcript entries to save.');
      return null;
    }

    try {
      // Save raw transcript
      const filePath = this._saveTranscript();
      console.log(LOG, `Transcript saved to ${filePath}`);

      // Emit summary event (the AI responder or external code can generate summary)
      this.emit('meeting-ended', {
        transcript: this.getFormattedTranscript(),
        filePath,
        duration: this.meetingEnd - this.meetingStart,
        entryCount: this.entries.length,
        topic: this.topic,
      });

      return filePath;
    } catch (err) {
      console.error(LOG, 'Error saving transcript:', err.message);
      return null;
    }
  }

  _saveTranscript() {
    const dir = config.meetingsDir;
    fs.mkdirSync(dir, { recursive: true });

    const dateStr = this.meetingStart.toISOString().replace(/[:.]/g, '-').substring(0, 16);
    const safeTopic = this.topic.replace(/[^a-zA-Z0-9-]/g, '_').substring(0, 50);
    const filename = `${dateStr}-${safeTopic}.md`;
    const filePath = path.join(dir, filename);

    const duration = this.meetingEnd
      ? this._formatDuration(this.meetingEnd - this.meetingStart)
      : 'unknown';

    let content = `# Meeting Transcript\n\n`;
    content += `- **Date:** ${this.meetingStart.toISOString()}\n`;
    content += `- **Duration:** ${duration}\n`;
    content += `- **Meet Link:** ${this.meetLink}\n`;
    content += `- **Entries:** ${this.entries.length}\n\n`;
    content += `---\n\n`;
    content += this.getFormattedTranscript();
    content += `\n`;

    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
  }

  _formatDuration(ms) {
    const totalSec = Math.floor(ms / 1000);
    const hours = Math.floor(totalSec / 3600);
    const minutes = Math.floor((totalSec % 3600) / 60);
    const seconds = totalSec % 60;
    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
    return `${minutes}m ${seconds}s`;
  }

  /**
   * Generate a meeting summary using the AI via a callback.
   * Returns the formatted transcript for the caller to send to the AI.
   * Includes meeting URL, duration, and bot name for context.
   */
  getSummaryPrompt(botName = 'Bot') {
    const transcript = this.getFormattedTranscript();
    if (!transcript || this.entries.length < 3) return null;

    const duration = this.meetingEnd && this.meetingStart
      ? this._formatDuration(this.meetingEnd - this.meetingStart)
      : 'unknown';

    const meetingUrl = this.meetLink || 'Unknown';

    return `Generate a concise meeting summary for the following meeting.
Meeting: ${meetingUrl}
Bot Facilitator: ${botName}
Duration: ${duration}
Topic: ${this.topic || 'Unknown'}
Participants: ${[...new Set(this.entries.map(e => e.speaker).filter(s => s && s !== 'Unknown'))].join(', ') || 'Unknown'}

Include:
1. Key topics discussed
2. Decisions made
3. Action items (with owners if clear)

Keep it under 200 words. Format with bullet points.

Transcript:
${transcript}`;
  }

  /**
   * Export meeting data for post-meeting summary pipeline.
   * Saves transcripts.json, participants.json, metadata.json to meetingsDir.
   */
  exportForSummary(participants = []) {
    const meetId = this._extractMeetId(this.meetLink);
    const exportDir = path.join(config.meetingsDir, meetId);
    fs.mkdirSync(exportDir, { recursive: true });

    // transcripts.json
    fs.writeFileSync(
      path.join(exportDir, 'transcripts.json'),
      JSON.stringify(this.entries, null, 2),
      'utf8'
    );

    // participants.json — normalize to [{name, joinedAt}]
    const normalizedParticipants = (participants || []).map(p =>
      typeof p === 'string' ? { name: p, joinedAt: null } : p
    );
    fs.writeFileSync(
      path.join(exportDir, 'participants.json'),
      JSON.stringify(normalizedParticipants, null, 2),
      'utf8'
    );

    // metadata.json
    const duration = this.meetingEnd && this.meetingStart
      ? this._formatDuration(this.meetingEnd - this.meetingStart)
      : 'unknown';
    fs.writeFileSync(
      path.join(exportDir, 'metadata.json'),
      JSON.stringify({
        meetLink: this.meetLink,
        topic: this.topic,
        date: (this.meetingStart || new Date()).toISOString().split('T')[0],
        startedAt: this.meetingStart?.toISOString(),
        endedAt: this.meetingEnd?.toISOString(),
        duration,
        entryCount: this.entries.length,
      }, null, 2),
      'utf8'
    );

    console.log(LOG, `Meeting data exported to ${exportDir}`);
    return exportDir;
  }

  _extractMeetId(link) {
    const match = link.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})/);
    return match ? match[1] : 'meeting';
  }
}

module.exports = MeetingMemory;
