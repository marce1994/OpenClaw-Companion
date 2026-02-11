#!/usr/bin/env python3
"""Speaker identification microservice using Resemblyzer.
Runs as HTTP server on port 3201 inside the voice server container."""

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
SIMILARITY_THRESHOLD = float(os.environ.get('SIMILARITY_THRESHOLD', '0.75'))
PORT = int(os.environ.get('SPEAKER_PORT', '3201'))

# Load encoder once at startup
print("🔊 Loading voice encoder model...", flush=True)
encoder = VoiceEncoder()
print("✅ Voice encoder ready", flush=True)

# In-memory speaker profiles: { name: embedding_array }
profiles = {}

def load_profiles():
    """Load all saved speaker profiles from disk."""
    global profiles
    os.makedirs(PROFILES_DIR, exist_ok=True)
    for fname in os.listdir(PROFILES_DIR):
        if fname.endswith('.npy'):
            name = fname[:-4]
            profiles[name] = np.load(os.path.join(PROFILES_DIR, fname))
            print(f"  📋 Loaded profile: {name}", flush=True)
    print(f"✅ {len(profiles)} speaker profiles loaded", flush=True)

def save_profile(name, embedding):
    """Save a speaker profile to disk."""
    os.makedirs(PROFILES_DIR, exist_ok=True)
    path = os.path.join(PROFILES_DIR, f"{name}.npy")
    np.save(path, embedding)
    profiles[name] = embedding
    print(f"💾 Saved profile: {name}", flush=True)

def get_embedding(wav_bytes):
    """Get speaker embedding from WAV audio bytes."""
    audio, sr = sf.read(io.BytesIO(wav_bytes))
    # Convert to mono if stereo
    if len(audio.shape) > 1:
        audio = audio.mean(axis=1)
    # Resample to 16kHz if needed
    if sr != 16000:
        import librosa
        audio = librosa.resample(audio, orig_sr=sr, target_sr=16000)
    wav = preprocess_wav(audio, source_sr=16000)
    if len(wav) < 1600:  # Less than 0.1s
        return None
    embedding = encoder.embed_utterance(wav)
    return embedding

def identify_speaker(embedding):
    """Compare embedding against all profiles. Returns (name, similarity) or (None, 0)."""
    if not profiles:
        return None, 0.0
    
    best_name = None
    best_sim = 0.0
    
    for name, profile_emb in profiles.items():
        sim = np.dot(embedding, profile_emb) / (np.linalg.norm(embedding) * np.linalg.norm(profile_emb))
        if sim > best_sim:
            best_sim = float(sim)
            best_name = name
    
    if best_sim >= SIMILARITY_THRESHOLD:
        return best_name, best_sim
    return None, best_sim

# Auto-increment for unknown speakers
unknown_counter = 0
# Map embedding hash to assigned ID for session continuity
unknown_embeddings = []  # List of (id, embedding)

def get_or_assign_unknown(embedding):
    """Assign a consistent ID to unknown speakers within a session."""
    global unknown_counter
    
    for uid, uemb in unknown_embeddings:
        sim = float(np.dot(embedding, uemb) / (np.linalg.norm(embedding) * np.linalg.norm(uemb)))
        if sim >= SIMILARITY_THRESHOLD:
            return uid, sim
    
    unknown_counter += 1
    uid = f"Speaker_{unknown_counter}"
    unknown_embeddings.append((uid, embedding))
    return uid, 0.0


class SpeakerHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # Suppress default logging
    
    def _respond(self, code, data):
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(data).encode())
    
    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length)
        
        if self.path == '/identify':
            # Receive WAV audio, return speaker identification
            try:
                embedding = get_embedding(body)
                if embedding is None:
                    self._respond(200, {"speaker": None, "error": "Audio too short"})
                    return
                
                name, sim = identify_speaker(embedding)
                has_profiles = len(profiles) > 0
                if name:
                    print(f"🎯 Identified: {name} (sim={sim:.3f})", flush=True)
                    self._respond(200, {"speaker": name, "similarity": sim, "known": True, "hasProfiles": has_profiles})
                else:
                    # Assign unknown speaker ID
                    uid, usim = get_or_assign_unknown(embedding)
                    print(f"❓ Unknown speaker → {uid} (best_known_sim={sim:.3f})", flush=True)
                    self._respond(200, {"speaker": uid, "similarity": sim, "known": False, "hasProfiles": has_profiles})
            except Exception as e:
                print(f"❌ Identify error: {e}", flush=True)
                self._respond(500, {"error": str(e)})
        
        elif self.path == '/enroll':
            # Receive WAV audio + name in header, save profile
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
                print(f"❌ Enroll error: {e}", flush=True)
                self._respond(500, {"error": str(e)})
        
        elif self.path == '/enroll_append':
            # Append audio to existing profile (average embeddings for better accuracy)
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
                    # Running average
                    profiles[name] = (profiles[name] + new_emb) / 2
                    save_profile(name, profiles[name])
                    self._respond(200, {"status": "updated", "speaker": name})
                else:
                    save_profile(name, new_emb)
                    self._respond(200, {"status": "enrolled", "speaker": name})
            except Exception as e:
                self._respond(500, {"error": str(e)})
        
        else:
            self._respond(404, {"error": "Not found"})
    
    def do_GET(self):
        if self.path == '/health':
            self._respond(200, {"status": "ok", "profiles": list(profiles.keys())})
        elif self.path == '/profiles':
            self._respond(200, {"profiles": list(profiles.keys()), "count": len(profiles)})
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
