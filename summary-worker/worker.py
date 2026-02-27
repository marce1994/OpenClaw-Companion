#!/usr/bin/env python3
"""
Post-Meeting Summary Worker
Ephemeral container that processes meeting data and generates a summary.

Pipeline:
1. Read transcripts, check relevance via Gemini Flash
2. If relevant → diarize audio via WhisperX container
3. Map speakers to participant names
4. Generate structured summary via Gemini Flash
5. Send to Telegram
6. Save as markdown
7. Ingest into Cognee
"""

import os
import sys
import json
import time
import subprocess
import logging
import requests
from pathlib import Path
from difflib import SequenceMatcher

logging.basicConfig(level=logging.INFO, format='[SummaryWorker] %(message)s')
log = logging.getLogger('worker')

# Config from env
DATA_DIR = os.environ.get('MEETING_DATA_DIR', os.environ.get('DATA_DIR', '/data'))
OPENROUTER_API_KEY = os.environ.get('OPENROUTER_API_KEY', '')
TELEGRAM_BOT_TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN', '')
TELEGRAM_CHAT_ID = os.environ.get('TELEGRAM_CHAT_ID', '')
COGNEE_URL = os.environ.get('COGNEE_URL', 'http://172.17.0.1:8000')
COGNEE_USER = os.environ.get('COGNEE_USER', 'jarvis@openclaw.dev')
COGNEE_PASS = os.environ.get('COGNEE_PASSWORD', os.environ.get('COGNEE_PASS', ''))
DOCKER_SOCKET = os.environ.get('DOCKER_SOCKET', '/var/run/docker.sock')
WHISPERX_IMAGE = os.environ.get('WHISPERX_IMAGE', 'whisperx-api:latest')
HF_TOKEN = os.environ.get('HF_TOKEN', '')
MEETING_ID = os.environ.get('MEETING_ID', 'unknown')

GEMINI_MODEL = 'google/gemini-2.0-flash-001'


def llm_call(prompt, system='You are a helpful assistant.', max_tokens=2000):
    """Call Gemini Flash via OpenRouter."""
    if not OPENROUTER_API_KEY:
        log.error('No OPENROUTER_API_KEY set')
        return None

    resp = requests.post(
        'https://openrouter.ai/api/v1/chat/completions',
        headers={
            'Authorization': f'Bearer {OPENROUTER_API_KEY}',
            'Content-Type': 'application/json',
        },
        json={
            'model': GEMINI_MODEL,
            'messages': [
                {'role': 'system', 'content': system},
                {'role': 'user', 'content': prompt},
            ],
            'max_tokens': max_tokens,
        },
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()
    return data['choices'][0]['message']['content']


def check_relevance(transcripts):
    """Check if meeting is worth summarizing."""
    if len(transcripts) < 3:
        log.info(f'Only {len(transcripts)} transcript entries — skipping.')
        return False

    # Build a sample of the transcript
    sample_entries = transcripts[:30]  # First 30 entries
    sample_text = '\n'.join(
        f"[{e.get('speaker', '?')}]: {e.get('text', '')}" for e in sample_entries
    )

    prompt = f"""Analyze this meeting transcript excerpt and determine if it's worth generating a summary.

A meeting is NOT worth summarizing if:
- It's just silence/noise/hallucinations
- It's a very brief exchange (just greetings/goodbyes)
- It's test audio or gibberish
- Less than ~1 minute of actual conversation

A meeting IS worth summarizing if:
- There's substantive discussion on any topic
- Decisions were made or tasks assigned
- Information was shared

Transcript ({len(transcripts)} total entries, showing first {len(sample_entries)}):
{sample_text}

Answer with ONLY "yes" or "no" followed by a brief reason."""

    result = llm_call(prompt)
    if not result:
        return True  # Default to summarize if LLM fails

    answer = result.strip().lower()
    log.info(f'Relevance check: {answer[:100]}')
    return answer.startswith('yes')


def start_whisperx_container(audio_path):
    """Start WhisperX container, transcribe audio, return result."""
    import docker
    client = docker.DockerClient(base_url=f'unix://{DOCKER_SOCKET}')

    container_name = f'whisperx-{MEETING_ID}'
    audio_dir = str(Path(audio_path).parent)

    log.info(f'Starting WhisperX container: {container_name}')

    try:
        # Remove any existing container with same name
        try:
            old = client.containers.get(container_name)
            old.remove(force=True)
        except docker.errors.NotFound:
            pass

        container = client.containers.run(
            WHISPERX_IMAGE,
            name=container_name,
            detach=True,
            remove=False,
            environment={
                'HF_TOKEN': HF_TOKEN,
                'PORT': '8000',
            },
            volumes={
                audio_dir: {'bind': '/audio', 'mode': 'ro'},
            },
            device_requests=[
                docker.types.DeviceRequest(count=-1, capabilities=[['gpu']])
            ],
            network_mode='bridge',
        )

        # Wait for container to be ready
        log.info('Waiting for WhisperX to load model...')
        container_ip = None
        for attempt in range(120):  # Up to 4 minutes for model loading
            time.sleep(2)
            container.reload()
            if container.status != 'running':
                logs = container.logs().decode('utf-8', errors='replace')
                log.error(f'WhisperX container died:\n{logs[-1000:]}')
                return None

            # Get container IP
            if not container_ip:
                networks = container.attrs.get('NetworkSettings', {}).get('Networks', {})
                for net in networks.values():
                    container_ip = net.get('IPAddress')
                    if container_ip:
                        break

            if container_ip:
                try:
                    r = requests.get(f'http://{container_ip}:8000/docs', timeout=2)
                    if r.status_code == 200:
                        log.info(f'WhisperX ready at {container_ip}:8000')
                        break
                except requests.exceptions.ConnectionError:
                    pass

        if not container_ip:
            log.error('Could not get WhisperX container IP')
            return None

        # Send transcription request
        audio_filename = Path(audio_path).name
        log.info(f'Sending audio for diarized transcription...')

        with open(audio_path, 'rb') as f:
            resp = requests.post(
                f'http://{container_ip}:8000/transcribe',
                files={'file': (audio_filename, f, 'audio/wav')},
                data={
                    'diarize': 'true',
                    'min_speakers': '2',
                    'max_speakers': '10',
                },
                timeout=600,  # 10 min max for long meetings
            )

        resp.raise_for_status()
        result = resp.json()
        log.info(f'Diarization complete: {len(result.get("segments", []))} segments')
        return result

    except Exception as e:
        log.error(f'WhisperX error: {e}', exc_info=True)
        return None
    finally:
        try:
            container.stop(timeout=5)
            container.remove()
            log.info('WhisperX container cleaned up')
        except Exception:
            pass


def map_speakers(diarized_segments, participants):
    """
    Map SPEAKER_XX labels to real participant names.
    Uses the real-time transcripts (which have Meet UI speaker names) to correlate.
    """
    if not participants:
        return diarized_segments

    # participants is a list of {name, joinedAt} dicts
    participant_names = [p.get('name', '') for p in participants if p.get('name')]

    # Get unique speaker labels
    speaker_labels = set(s.get('speaker') for s in diarized_segments if s.get('speaker'))

    if not speaker_labels or not participant_names:
        return diarized_segments

    # Simple heuristic: if same number of speakers as participants, map by order of appearance
    # Otherwise just label as SPEAKER_01, etc.
    speaker_order = []
    seen = set()
    for seg in diarized_segments:
        sp = seg.get('speaker')
        if sp and sp not in seen:
            seen.add(sp)
            speaker_order.append(sp)

    # Map speakers to participants by order (imperfect but reasonable)
    mapping = {}
    for i, sp in enumerate(speaker_order):
        if i < len(participant_names):
            mapping[sp] = participant_names[i]
        else:
            mapping[sp] = sp

    for seg in diarized_segments:
        sp = seg.get('speaker')
        if sp and sp in mapping:
            seg['speaker'] = mapping[sp]

    log.info(f'Speaker mapping: {mapping}')
    return diarized_segments


def generate_summary(segments, transcripts, participants, meeting_id):
    """Generate structured meeting summary using Gemini Flash."""
    # Build full transcript text from diarized segments (preferred) or real-time transcripts
    if segments:
        transcript_text = '\n'.join(
            f"[{s.get('speaker', '?')}] ({s['start']:.1f}s-{s['end']:.1f}s): {s['text']}"
            for s in segments
        )
    else:
        transcript_text = '\n'.join(
            f"[{e.get('speaker', '?')}]: {e.get('text', '')}"
            for e in transcripts
        )

    participant_names = [p.get('name', '?') for p in (participants or [])]

    prompt = f"""Generate a structured meeting summary from this transcript.

Meeting ID: {meeting_id}
Participants: {', '.join(participant_names) if participant_names else 'Unknown'}

IMPORTANT: Write the summary in the same language as the predominant language of the transcript.

Format the summary as:

## 📋 Meeting Summary

**Participants:** [list]
**Duration:** [estimated from timestamps]

### 🗣️ Topics Discussed
- [topic 1]
- [topic 2]
...

### ✅ Decisions Made
- [decision 1]
...

### 📌 Action Items
- [ ] [action item] — [owner if known]
...

### 💡 Key Takeaways
- [insight 1]
...

Keep it concise but comprehensive. Use bullet points.

Transcript:
{transcript_text}"""

    return llm_call(prompt, system='You are a meeting summarizer. Be concise and structured.', max_tokens=3000)


def send_telegram(text):
    """Send summary to Telegram."""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        log.warning('Telegram not configured, skipping.')
        return

    # Telegram has a 4096 char limit, truncate if needed
    if len(text) > 4000:
        text = text[:3950] + '\n\n... (truncated)'

    try:
        resp = requests.post(
            f'https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage',
            json={
                'chat_id': TELEGRAM_CHAT_ID,
                'text': text,
                'parse_mode': 'Markdown',
                'disable_web_page_preview': True,
            },
            timeout=15,
        )
        if resp.status_code != 200:
            # Retry without parse_mode if Markdown fails
            log.warning(f'Telegram Markdown failed: {resp.text}, retrying plain text')
            resp = requests.post(
                f'https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage',
                json={
                    'chat_id': TELEGRAM_CHAT_ID,
                    'text': text,
                    'disable_web_page_preview': True,
                },
                timeout=15,
            )
        resp.raise_for_status()
        log.info('Summary sent to Telegram')
    except Exception as e:
        log.error(f'Telegram send error: {e}')


def ingest_cognee(summary_text, meeting_id):
    """Ingest summary into Cognee knowledge graph."""
    try:
        # Login
        resp = requests.post(
            f'{COGNEE_URL}/api/v1/auth/login',
            data={'username': COGNEE_USER, 'password': COGNEE_PASS},
            timeout=10,
        )
        resp.raise_for_status()
        token = resp.json().get('access_token')
        if not token:
            log.error('No Cognee access_token received')
            return

        headers = {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}

        # Add data
        resp = requests.post(
            f'{COGNEE_URL}/api/v1/add',
            headers=headers,
            json={'data': summary_text, 'dataset_name': f'meeting-{meeting_id}'},
            timeout=30,
        )
        resp.raise_for_status()
        log.info(f'Cognee: data added to dataset meeting-{meeting_id}')

        # Trigger cognify
        resp = requests.post(
            f'{COGNEE_URL}/api/v1/cognify',
            headers=headers,
            json={'dataset_name': f'meeting-{meeting_id}'},
            timeout=120,
        )
        resp.raise_for_status()
        log.info('Cognee: cognify triggered')

    except Exception as e:
        log.error(f'Cognee ingestion error: {e}')


def merge_audio_chunks(data_dir):
    """Merge audio chunks into a single WAV file using ffmpeg."""
    audio_dirs = sorted(Path(data_dir).glob('audio-chunks')) or sorted(Path(data_dir).glob('audio-*'))
    if not audio_dirs:
        log.warning('No audio directories found')
        return None

    # Use the most recent audio directory
    audio_dir = audio_dirs[-1]
    chunks = sorted(audio_dir.glob('chunk-*.wav'))
    if not chunks:
        log.warning(f'No audio chunks in {audio_dir}')
        return None

    output_path = Path(data_dir) / 'audio.wav'

    if len(chunks) == 1:
        # Just copy the single chunk
        import shutil
        shutil.copy2(str(chunks[0]), str(output_path))
    else:
        # Create file list for ffmpeg concat
        list_path = Path(data_dir) / 'chunks.txt'
        with open(list_path, 'w') as f:
            for chunk in chunks:
                f.write(f"file '{chunk}'\n")

        result = subprocess.run(
            ['ffmpeg', '-y', '-f', 'concat', '-safe', '0', '-i', str(list_path),
             '-c', 'copy', str(output_path)],
            capture_output=True, text=True, timeout=120,
        )
        list_path.unlink(missing_ok=True)

        if result.returncode != 0:
            log.error(f'ffmpeg merge failed: {result.stderr[:500]}')
            return None

    log.info(f'Merged {len(chunks)} chunks → {output_path} ({output_path.stat().st_size / 1024 / 1024:.1f}MB)')
    return str(output_path)


def main():
    log.info(f'=== Summary Worker started for meeting {MEETING_ID} ===')
    log.info(f'Data dir: {DATA_DIR}')

    data_dir = Path(DATA_DIR)

    # 1. Read transcripts
    transcripts_path = data_dir / 'transcripts.json'
    if not transcripts_path.exists():
        log.error('No transcripts.json found')
        sys.exit(1)

    with open(transcripts_path) as f:
        transcripts = json.load(f)

    log.info(f'Loaded {len(transcripts)} transcript entries')

    # Read participants
    participants_path = data_dir / 'participants.json'
    participants = []
    if participants_path.exists():
        with open(participants_path) as f:
            participants = json.load(f)
        log.info(f'Loaded {len(participants)} participants')

    # 2. Check relevance
    if not check_relevance(transcripts):
        log.info('Meeting not relevant for summary. Exiting.')
        sys.exit(0)

    # 3. Try to diarize with WhisperX (optional — needs audio + GPU + HF_TOKEN)
    diarized_segments = None
    audio_path = data_dir / 'audio.wav'

    if not audio_path.exists():
        # Try to merge audio chunks
        merged = merge_audio_chunks(str(data_dir))
        if merged:
            audio_path = Path(merged)

    if audio_path.exists() and HF_TOKEN:
        log.info('Audio available — attempting WhisperX diarization...')
        try:
            result = start_whisperx_container(str(audio_path))
            if result and result.get('segments'):
                diarized_segments = result['segments']
                diarized_segments = map_speakers(diarized_segments, participants)
        except Exception as e:
            log.warning(f'WhisperX diarization failed: {e} — falling back to real-time transcripts')
    else:
        if not audio_path.exists():
            log.info('No audio file — using real-time transcripts only')
        if not HF_TOKEN:
            log.info('No HF_TOKEN — skipping WhisperX diarization')

    # 4. Generate summary
    log.info('Generating summary...')
    summary = generate_summary(diarized_segments, transcripts, participants, MEETING_ID)
    if not summary:
        log.error('Failed to generate summary')
        sys.exit(1)

    log.info(f'Summary generated ({len(summary)} chars)')

    # 5. Save to file
    summary_path = data_dir / 'summary.md'
    with open(summary_path, 'w') as f:
        f.write(summary)
    log.info(f'Summary saved to {summary_path}')

    # 6. Send to Telegram
    send_telegram(summary)

    # 7. Ingest into Cognee
    ingest_cognee(summary, MEETING_ID)

    log.info('=== Summary Worker done ===')


if __name__ == '__main__':
    main()
