/**
 * Calendar Sync — Auto-join Google Meet meetings from Google Calendar.
 *
 * Uses the private ICS feed URL (no OAuth needed).
 * Set GOOGLE_CALENDAR_ICS env var to enable.
 *
 * Strategy: Fetch ICS once on startup + every CALENDAR_REFRESH_HOURS,
 * then schedule precise timers for each event. No polling.
 */

const { EventEmitter } = require('events');
const https = require('https');
const http = require('http');
const config = require('./config');

const LOG = '[Calendar]';

class CalendarSync extends EventEmitter {
  constructor() {
    super();
    this.enabled = !!config.calendarIcsUrl;
    this.refreshInterval = null;
    this.scheduledTimers = new Map(); // eventId -> { joinTimer, leaveTimer }
    this.currentEvent = null;
    this.refreshHours = config.calendarRefreshHours || 6;
    this.joinBeforeSec = config.calendarJoinBeforeSec || 60;
  }

  start() {
    if (!this.enabled) {
      console.log(LOG, 'Disabled (no GOOGLE_CALENDAR_ICS configured)');
      return;
    }

    console.log(LOG, `Enabled — refresh every ${this.refreshHours}h, join ${this.joinBeforeSec}s before start`);
    this._refresh();
    this.refreshInterval = setInterval(() => this._refresh(), this.refreshHours * 60 * 60 * 1000);
  }

  stop() {
    if (this.refreshInterval) { clearInterval(this.refreshInterval); this.refreshInterval = null; }
    for (const [id, timers] of this.scheduledTimers) {
      if (timers.joinTimer) clearTimeout(timers.joinTimer);
      if (timers.leaveTimer) clearTimeout(timers.leaveTimer);
    }
    this.scheduledTimers.clear();
  }

  async _refresh() {
    try {
      console.log(LOG, 'Fetching calendar...');
      const icsText = await this._fetchICS();
      const events = this._parseICS(icsText);
      const now = Date.now();

      // Filter: events with Meet links, starting within next refreshHours, not already past
      const relevant = events.filter(e => {
        if (!e.meetLink) return false;
        const startsIn = e.start.getTime() - now;
        return startsIn < this.refreshHours * 60 * 60 * 1000 && e.end.getTime() > now;
      });

      // Cancel timers for events no longer relevant
      for (const [id, timers] of this.scheduledTimers) {
        if (!relevant.find(e => (e.uid || e.meetLink) === id)) {
          if (timers.joinTimer) clearTimeout(timers.joinTimer);
          if (timers.leaveTimer) clearTimeout(timers.leaveTimer);
          this.scheduledTimers.delete(id);
        }
      }

      // Schedule new events
      let scheduled = 0;
      for (const event of relevant) {
        const eventId = event.uid || event.meetLink;
        if (this.scheduledTimers.has(eventId)) continue; // Already scheduled
        this._scheduleEvent(event, eventId);
        scheduled++;
      }

      console.log(LOG, `${relevant.length} upcoming events with Meet links, ${scheduled} newly scheduled`);

      if (relevant.length > 0) {
        for (const e of relevant) {
          const mins = Math.round((e.start.getTime() - now) / 60000);
          const when = mins <= 0 ? 'NOW (in progress)' : `in ${mins}min`;
          console.log(LOG, `  • "${e.summary}" ${when} — ${e.meetLink}`);
        }
      }
    } catch (err) {
      console.error(LOG, 'Refresh error:', err.message);
    }
  }

  _scheduleEvent(event, eventId) {
    const now = Date.now();
    const joinAt = event.start.getTime() - (this.joinBeforeSec * 1000);
    const leaveAt = event.end.getTime();
    const msUntilJoin = Math.max(0, joinAt - now);
    const msUntilLeave = Math.max(0, leaveAt - now);

    const timers = {};

    // Schedule join
    timers.joinTimer = setTimeout(() => {
      console.log(LOG, `Auto-joining: "${event.summary}"`);
      this.currentEvent = event;
      this.emit('join', { meetLink: event.meetLink, event });
    }, msUntilJoin);

    // Schedule leave
    timers.leaveTimer = setTimeout(() => {
      console.log(LOG, `Event "${event.summary}" ended — auto-leaving`);
      this.emit('leave', { event });
      this.currentEvent = null;
      this.scheduledTimers.delete(eventId);
    }, msUntilLeave);

    this.scheduledTimers.set(eventId, timers);
  }

  /**
   * Called when meeting ends naturally (someone ended it).
   * Clears the scheduled leave since it's no longer needed.
   */
  onMeetingEnded() {
    if (this.currentEvent) {
      const eventId = this.currentEvent.uid || this.currentEvent.meetLink;
      const timers = this.scheduledTimers.get(eventId);
      if (timers?.leaveTimer) {
        clearTimeout(timers.leaveTimer);
      }
      this.scheduledTimers.delete(eventId);
      this.currentEvent = null;
    }
  }

  _fetchICS() {
    return new Promise((resolve, reject) => {
      const url = new URL(config.calendarIcsUrl);
      const client = url.protocol === 'https:' ? https : http;

      const req = client.get(url, { timeout: 15000 }, (res) => {
        if (res.statusCode !== 200) {
          return reject(new Error(`ICS fetch failed: HTTP ${res.statusCode}`));
        }
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(data));
      });

      req.on('timeout', () => { req.destroy(); reject(new Error('ICS fetch timeout')); });
      req.on('error', reject);
    });
  }

  _parseICS(icsText) {
    const events = [];
    const blocks = icsText.split('BEGIN:VEVENT');

    for (let i = 1; i < blocks.length; i++) {
      const block = blocks[i].split('END:VEVENT')[0];
      const event = this._parseEvent(block);
      if (event) events.push(event);
    }

    return events;
  }

  _parseEvent(block) {
    const lines = this._unfoldLines(block);
    const props = {};

    for (const line of lines) {
      const match = line.match(/^([A-Z-]+)(?:;[^:]*)?:(.*)$/);
      if (match) {
        const key = match[1];
        const value = match[2];
        if (!props[key]) props[key] = value;
        else if (key === 'DESCRIPTION' || key === 'LOCATION') {
          props[key] += ' ' + value;
        }
      }
    }

    const start = this._parseDate(props['DTSTART']);
    const end = this._parseDate(props['DTEND']);
    if (!start || !end) return null;

    // Only care about events in the next 24 hours
    const now = Date.now();
    if (start.getTime() > now + 24 * 60 * 60 * 1000) return null;
    if (end.getTime() < now - 60 * 60 * 1000) return null;

    const allText = [
      props['DESCRIPTION'] || '',
      props['LOCATION'] || '',
      props['X-GOOGLE-CONFERENCE'] || '',
    ].join(' ');

    const meetLink = this._extractMeetLink(allText);

    return {
      uid: props['UID'] || null,
      summary: (props['SUMMARY'] || 'Untitled').replace(/\\,/g, ',').replace(/\\n/g, ' '),
      start,
      end,
      meetLink,
    };
  }

  _unfoldLines(text) {
    return text.replace(/\r\n[ \t]/g, '').replace(/\r/g, '').split('\n').filter(l => l.trim());
  }

  _parseDate(str) {
    if (!str) return null;
    const utcMatch = str.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/);
    if (utcMatch) {
      return new Date(Date.UTC(+utcMatch[1], +utcMatch[2]-1, +utcMatch[3], +utcMatch[4], +utcMatch[5], +utcMatch[6]));
    }
    const localMatch = str.match(/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/);
    if (localMatch) {
      return new Date(Date.UTC(+localMatch[1], +localMatch[2]-1, +localMatch[3], +localMatch[4], +localMatch[5], +localMatch[6]));
    }
    // All-day — skip (no Meet link for all-day events)
    return null;
  }

  _extractMeetLink(text) {
    const match = text.match(/https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/);
    return match ? match[0] : null;
  }
}

module.exports = CalendarSync;
