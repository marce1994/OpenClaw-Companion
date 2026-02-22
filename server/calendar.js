/**
 * Calendar Auto-Join — fetches ICS from Google Calendar, parses events,
 * and automatically joins upcoming meetings with Google Meet links.
 *
 * Requires: GOOGLE_CALENDAR_ICS env var (ICS URL, optional).
 * Re-fetches every 30 minutes. Only joins meetings with Meet links.
 */

const https = require('https');
const http = require('http');
const ical = require('node-ical');

const FETCH_INTERVAL_MS = 30 * 60_000; // Re-fetch every 30 min
const JOIN_EARLY_MS = 30_000;           // Join 30s before start time

class CalendarAutoJoin {
  /**
   * @param {import('./orchestrator').MeetOrchestrator} orchestrator
   * @param {string} icsUrl — Google Calendar ICS URL
   */
  constructor(orchestrator, icsUrl, botName = 'Jarvis') {
    this.orchestrator = orchestrator;
    this.icsUrl = icsUrl;
    this.botName = botName;
    this._timers = [];       // setTimeout refs for upcoming joins
    this._fetchTimer = null;
    this._joinedEvents = new Set(); // event UIDs already joined (avoid duplicates)
  }

  /** Start polling calendar */
  start() {
    if (!this.icsUrl) {
      console.log('📅 Calendar auto-join disabled (no GOOGLE_CALENDAR_ICS)');
      return;
    }
    console.log('📅 Calendar auto-join enabled');
    this._fetchAndSchedule();
    this._fetchTimer = setInterval(() => this._fetchAndSchedule(), FETCH_INTERVAL_MS);
  }

  /** Stop polling */
  stop() {
    if (this._fetchTimer) clearInterval(this._fetchTimer);
    for (const t of this._timers) clearTimeout(t);
    this._timers = [];
  }

  /** Fetch ICS, parse events, schedule joins */
  async _fetchAndSchedule() {
    try {
      const icsText = await this._fetchICS(this.icsUrl);
      const events = ical.sync.parseICS(icsText);
      const now = Date.now();
      const horizon = now + FETCH_INTERVAL_MS + 5 * 60_000; // Look ahead ~35 min

      // Clear old timers
      for (const t of this._timers) clearTimeout(t);
      this._timers = [];

      let scheduled = 0;
      for (const [uid, event] of Object.entries(events)) {
        if (event.type !== 'VEVENT') continue;

        const start = event.start ? new Date(event.start).getTime() : 0;
        if (!start || start > horizon || start < now - 60_000) continue; // Skip past/far events

        // Extract Google Meet link from description, location, or hangoutLink
        const meetUrl = this._extractMeetUrl(event);
        if (!meetUrl) continue;

        // Deduplicate
        const eventKey = `${uid}-${start}`;
        if (this._joinedEvents.has(eventKey)) continue;

        const joinAt = Math.max(start - JOIN_EARLY_MS, now);
        const delayMs = joinAt - now;
        const title = event.summary || 'Meeting';

        const timer = setTimeout(async () => {
          if (this._joinedEvents.has(eventKey)) return;
          this._joinedEvents.add(eventKey);
          console.log(`📅 Auto-joining: "${title}" → ${meetUrl}`);
          try {
            await this.orchestrator.joinMeeting(meetUrl, this.botName);
          } catch (e) {
            console.error(`📅 Auto-join failed for "${title}": ${e.message}`);
          }
        }, delayMs);

        this._timers.push(timer);
        scheduled++;
        console.log(`📅 Scheduled: "${title}" in ${Math.round(delayMs / 1000)}s`);
      }

      if (scheduled > 0) console.log(`📅 ${scheduled} meeting(s) scheduled`);

      // Prune old joined set (keep last 200)
      if (this._joinedEvents.size > 200) {
        const arr = [...this._joinedEvents];
        this._joinedEvents = new Set(arr.slice(-100));
      }
    } catch (e) {
      console.error(`📅 Calendar fetch error: ${e.message}`);
    }
  }

  /** Extract Google Meet URL from event */
  _extractMeetUrl(event) {
    const fields = [
      event.location || '',
      event.description || '',
      event['GOOGLE-CONFERENCE'] || '',
      // Some ICS files have hangoutLink in x-props
      ...(event['x-google-conference'] ? [event['x-google-conference']] : []),
    ];
    for (const field of fields) {
      const match = field.match(/https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i);
      if (match) return match[0];
    }
    return null;
  }

  /** Fetch ICS text from URL */
  _fetchICS(url) {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https') ? https : http;
      client.get(url, { timeout: 15000 }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`ICS fetch HTTP ${res.statusCode}`));
          res.resume();
          return;
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      }).on('error', reject);
    });
  }
}

module.exports = { CalendarAutoJoin };
