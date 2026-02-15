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

  _extractMeetId(link) {
    const match = link.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})/);
    return match ? match[1] : 'meeting';
  }
}

module.exports = MeetingMemory;
