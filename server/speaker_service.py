#!/usr/bin/env python3
"""Speaker identification microservice using Resemblyzer.
Runs as HTTP server on port 3201 inside the voice server container.

Auto-enrollment: first speaker becomes owner, subsequent speakers get
auto-assigned IDs and are saved for consistent identification."""

import json
import os
import sys
import io
import numpy as np
from http.server import HTTPServer, BaseHTTPRequestHandler
from resemblyzer import VoiceEncoder, preprocess_wav
import soundfile as sf
from duckduckgo_search import DDGS

PROFILES_DIR = os.environ.get('SPEAKER_PROFILES_DIR', '/data/speakers')
SIMILARITY_THRESHOLD = float(os.environ.get('SIMILARITY_THRESHOLD', '0.70'))
AUTO_ENROLL_THRESHOLD = float(os.environ.get('AUTO_ENROLL_THRESHOLD', '0.65'))
OWNER_NAME = os.environ.get('OWNER_NAME', 'Pablo')
PORT = int(os.environ.get('SPEAKER_PORT', '3201'))
# How many samples to collect before auto-enrolling owner
OWNER_ENROLL_SAMPLES = int(os.environ.get('OWNER_ENROLL_SAMPLES', '3'))

# Load encoder once at startup
print("🔊 Loading voice encoder model...", flush=True)
encoder = VoiceEncoder()
print("✅ Voice encoder ready", flush=True)

# In-memory speaker profiles: { name: embedding_array }
profiles = {}

# Auto-enrollment state
owner_enrolled = False
owner_samples = []  # List of embeddings collected before enrollment
unknown_counter = 0
# Temporary embeddings for unknown speakers (session-persistent)
unknown_cache = []  # List of { id: str, embeddings: [np.array], count: int }
UNKNOWN_ENROLL_SAMPLES = 3  # Auto-enroll unknowns after N consistent samples


def load_profiles():
    """Load all saved speaker profiles from disk."""
    global profiles, owner_enrolled
    os.makedirs(PROFILES_DIR, exist_ok=True)
    for fname in os.listdir(PROFILES_DIR):
        if fname.endswith('.npy'):
            name = fname[:-4]
            profiles[name] = np.load(os.path.join(PROFILES_DIR, fname))
            print(f"  📋 Loaded profile: {name}", flush=True)
    if OWNER_NAME in profiles:
        owner_enrolled = True
        print(f"  👑 Owner profile found: {OWNER_NAME}", flush=True)
    print(f"✅ {len(profiles)} speaker profiles loaded", flush=True)


def save_profile(name, embedding):
    """Save a speaker profile to disk."""
    os.makedirs(PROFILES_DIR, exist_ok=True)
    path = os.path.join(PROFILES_DIR, f"{name}.npy")
    np.save(path, embedding)
    profiles[name] = embedding
    print(f"💾 Saved profile: {name}", flush=True)


def average_embeddings(embeddings):
    """Compute average of multiple embeddings (more robust than single sample)."""
    if len(embeddings) == 1:
        return embeddings[0]
    stacked = np.stack(embeddings)
    avg = stacked.mean(axis=0)
    avg = avg / np.linalg.norm(avg)  # Re-normalize
    return avg


def cosine_sim(a, b):
    """Cosine similarity between two embeddings."""
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


def get_embedding(wav_bytes):
    """Get speaker embedding from WAV audio bytes."""
    audio, sr = sf.read(io.BytesIO(wav_bytes))
    if len(audio.shape) > 1:
        audio = audio.mean(axis=1)
    if sr != 16000:
        import librosa
        audio = librosa.resample(audio, orig_sr=sr, target_sr=16000)
    wav = preprocess_wav(audio, source_sr=16000)
    if len(wav) < 1600:  # Less than 0.1s
        return None
    embedding = encoder.embed_utterance(wav)
    return embedding


def identify_speaker(embedding):
    """Compare embedding against all profiles. Returns (name, similarity) or (None, best_sim)."""
    if not profiles:
        return None, 0.0

    best_name = None
    best_sim = 0.0

    for name, profile_emb in profiles.items():
        sim = cosine_sim(embedding, profile_emb)
        if sim > best_sim:
            best_sim = sim
            best_name = name

    if best_sim >= SIMILARITY_THRESHOLD:
        return best_name, best_sim
    return None, best_sim


def try_auto_enroll_owner(embedding):
    """Collect samples from the first speaker and enroll as owner.
    Returns True if this embedding belongs to the owner (enrolled or collecting)."""
    global owner_enrolled, owner_samples

    if owner_enrolled:
        return False  # Already enrolled, use normal identification

    # First sample ever — just start collecting
    if not owner_samples:
        owner_samples.append(embedding)
        print(f"👑 Owner sample 1/{OWNER_ENROLL_SAMPLES} collected", flush=True)
        return True

    # Check if this sample is consistent with previous owner samples
    avg = average_embeddings(owner_samples)
    sim = cosine_sim(embedding, avg)

    if sim >= AUTO_ENROLL_THRESHOLD:
        # Same person — add sample
        owner_samples.append(embedding)
        print(f"👑 Owner sample {len(owner_samples)}/{OWNER_ENROLL_SAMPLES} (sim={sim:.3f})", flush=True)

        if len(owner_samples) >= OWNER_ENROLL_SAMPLES:
            # Enough samples — enroll!
            final_embedding = average_embeddings(owner_samples)
            save_profile(OWNER_NAME, final_embedding)
            owner_enrolled = True
            owner_samples = []
            print(f"👑✅ Owner auto-enrolled as '{OWNER_NAME}'!", flush=True)
        return True
    else:
        # Different person speaking — don't add to owner samples
        print(f"👤 Different speaker during owner enrollment (sim={sim:.3f})", flush=True)
        return False


def find_or_create_unknown(embedding):
    """Find matching unknown speaker or create new one. Auto-enrolls after N samples."""
    global unknown_counter

    # Check against existing unknowns
    for entry in unknown_cache:
        avg = average_embeddings(entry['embeddings'])
        sim = cosine_sim(embedding, avg)
        if sim >= AUTO_ENROLL_THRESHOLD:
            entry['embeddings'].append(embedding)
            entry['count'] += 1

            # Auto-enroll after enough samples
            if entry['count'] >= UNKNOWN_ENROLL_SAMPLES and entry['id'] not in profiles:
                final_emb = average_embeddings(entry['embeddings'])
                save_profile(entry['id'], final_emb)
                print(f"👤✅ Auto-enrolled unknown as '{entry['id']}'", flush=True)
            else:
                # Update saved profile if already enrolled
                if entry['id'] in profiles:
                    profiles[entry['id']] = average_embeddings(entry['embeddings'][-10:])

            return entry['id'], sim

    # New unknown speaker
    unknown_counter += 1
    uid = f"Speaker_{unknown_counter}"
    unknown_cache.append({
        'id': uid,
        'embeddings': [embedding],
        'count': 1,
    })
    print(f"👤 New unknown speaker: {uid}", flush=True)
    return uid, 0.0


def reset_all():
    """Reset all profiles and enrollment state."""
    global owner_enrolled, owner_samples, unknown_counter, unknown_cache
    profiles.clear()
    owner_enrolled = False
    owner_samples = []
    unknown_counter = 0
    unknown_cache = []
    for fname in os.listdir(PROFILES_DIR):
        if fname.endswith('.npy'):
            os.remove(os.path.join(PROFILES_DIR, fname))
    print("🗑️ All profiles reset", flush=True)


class SpeakerHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def _respond(self, code, data):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())

    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)

        if self.path == '/identify':
            try:
                embedding = get_embedding(body)
                if embedding is None:
                    self._respond(200, {"speaker": None, "error": "Audio too short"})
                    return

                has_profiles = len(profiles) > 0

                # Step 1: If owner not enrolled yet, try auto-enrollment
                if not owner_enrolled:
                    is_owner_candidate = try_auto_enroll_owner(embedding)
                    if is_owner_candidate:
                        # Treat as owner while collecting samples
                        self._respond(200, {
                            "speaker": OWNER_NAME,
                            "similarity": 1.0,
                            "known": True,
                            "hasProfiles": True,
                            "autoEnrolling": True,
                            "samples": len(owner_samples),
                            "needed": OWNER_ENROLL_SAMPLES,
                        })
                        return

                # Step 2: Try to identify against saved profiles
                name, sim = identify_speaker(embedding)
                if name:
                    # Refine profile with new sample (running average of last 10)
                    print(f"🎯 Identified: {name} (sim={sim:.3f})", flush=True)
                    self._respond(200, {
                        "speaker": name,
                        "similarity": sim,
                        "known": True,
                        "hasProfiles": True,
                    })
                    return

                # Step 3: Unknown speaker — track and maybe auto-enroll
                uid, usim = find_or_create_unknown(embedding)
                print(f"❓ Unknown → {uid} (best_known={sim:.3f})", flush=True)
                self._respond(200, {
                    "speaker": uid,
                    "similarity": sim,
                    "known": False,
                    "hasProfiles": has_profiles,
                })

            except Exception as e:
                print(f"❌ Identify error: {e}", flush=True)
                self._respond(500, {"error": str(e)})

        elif self.path == '/enroll':
            name = self.headers.get('X-Speaker-Name', '').strip()
            if not name:
                self._respond(400, {"error": "X-Speaker-Name header required"})
                return
            try:
                embedding = get_embedding(body)
                if embedding is None:
                    self._respond(400, {"error": "Audio too short for enrollment"})
                    return
                save_profile(name, embedding)
                self._respond(200, {"status": "enrolled", "speaker": name})
            except Exception as e:
                self._respond(500, {"error": str(e)})

        elif self.path == '/enroll_append':
            name = self.headers.get('X-Speaker-Name', '').strip()
            if not name:
                self._respond(400, {"error": "X-Speaker-Name header required"})
                return
            try:
                new_emb = get_embedding(body)
                if new_emb is None:
                    self._respond(400, {"error": "Audio too short"})
                    return
                if name in profiles:
                    profiles[name] = (profiles[name] + new_emb) / 2
                    save_profile(name, profiles[name])
                    self._respond(200, {"status": "updated", "speaker": name})
                else:
                    save_profile(name, new_emb)
                    self._respond(200, {"status": "enrolled", "speaker": name})
            except Exception as e:
                self._respond(500, {"error": str(e)})

        elif self.path == '/rename':
            """Rename a speaker profile."""
            old_name = self.headers.get('X-Old-Name', '').strip()
            new_name = self.headers.get('X-New-Name', '').strip()
            if not old_name or not new_name:
                self._respond(400, {"error": "X-Old-Name and X-New-Name headers required"})
                return
            if old_name not in profiles:
                # Check unknown_cache too
                found = False
                for entry in unknown_cache:
                    if entry['id'] == old_name:
                        emb = average_embeddings(entry['embeddings'])
                        save_profile(new_name, emb)
                        entry['id'] = new_name
                        found = True
                        break
                if not found:
                    self._respond(404, {"error": f"Profile '{old_name}' not found"})
                    return
            else:
                emb = profiles.pop(old_name)
                # Remove old file
                old_path = os.path.join(PROFILES_DIR, f"{old_name}.npy")
                if os.path.exists(old_path):
                    os.remove(old_path)
                save_profile(new_name, emb)
            print(f"📝 Renamed '{old_name}' → '{new_name}'", flush=True)
            self._respond(200, {"status": "renamed", "old": old_name, "new": new_name})

        elif self.path == '/reset':
            """Reset all profiles and enrollment state."""
            reset_all()
            self._respond(200, {"status": "reset"})

        else:
            self._respond(404, {"error": "Not found"})

    def do_GET(self):
        if self.path == '/health':
            self._respond(200, {
                "status": "ok",
                "profiles": list(profiles.keys()),
                "ownerEnrolled": owner_enrolled,
                "ownerSamples": len(owner_samples),
            })
        elif self.path == '/profiles':
            self._respond(200, {
                "profiles": list(profiles.keys()),
                "count": len(profiles),
                "ownerEnrolled": owner_enrolled,
            })
        elif self.path.startswith('/search?'):
            from urllib.parse import urlparse, parse_qs
            params = parse_qs(urlparse(self.path).query)
            query = params.get('q', [''])[0]
            max_results = int(params.get('max', ['5'])[0])
            if not query:
                self._respond(400, {"error": "q parameter required"})
                return
            try:
                with DDGS() as ddgs:
                    results = list(ddgs.text(query, max_results=max_results))
                print(f"🔍 Search '{query}': {len(results)} results", flush=True)
                self._respond(200, {"results": results})
            except Exception as e:
                print(f"❌ Search error: {e}", flush=True)
                self._respond(500, {"error": str(e)})
        else:
            self._respond(404, {"error": "Not found"})


if __name__ == '__main__':
    load_profiles()
    server = HTTPServer(('127.0.0.1', PORT), SpeakerHandler)
    print(f"🔊 Speaker service on 127.0.0.1:{PORT}", flush=True)
    server.serve_forever()
