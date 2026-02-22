#!/usr/bin/env python3
"""Minimal faster-whisper HTTP server. No FastAPI, no Gradio, no model manager.
Loads model once at startup, keeps it in GPU memory forever."""

import io
import json
import time
import wave
import numpy as np
from http.server import HTTPServer, BaseHTTPRequestHandler
from faster_whisper import WhisperModel
import os

MODEL_NAME = os.environ.get("MODEL", "Systran/faster-whisper-large-v3-turbo")
DEVICE = os.environ.get("DEVICE", "cuda")
COMPUTE_TYPE = os.environ.get("COMPUTE_TYPE", "int8")
PORT = int(os.environ.get("PORT", "9000"))
# Restrict to these languages (empty = auto-detect all)
ALLOWED_LANGUAGES = os.environ.get("ALLOWED_LANGUAGES", "es,en").split(",") if os.environ.get("ALLOWED_LANGUAGES") else []

print(f"Loading {MODEL_NAME} on {DEVICE} ({COMPUTE_TYPE})...")
t0 = time.time()
model = WhisperModel(MODEL_NAME, device=DEVICE, compute_type=COMPUTE_TYPE, num_workers=3)
print(f"Model loaded in {time.time()-t0:.1f}s")


def transcribe_audio(audio_bytes, response_format="json", language=None):
    """Transcribe raw audio bytes (WAV or PCM)."""
    # Try to parse as WAV
    try:
        with wave.open(io.BytesIO(audio_bytes)) as wf:
            frames = wf.readframes(wf.getnframes())
            sr = wf.getframerate()
            ch = wf.getnchannels()
            sw = wf.getsampwidth()
        audio = np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0
        if ch > 1:
            audio = audio.reshape(-1, ch).mean(axis=1)
        if sr != 16000:
            # Simple resample
            ratio = 16000 / sr
            indices = np.arange(0, len(audio), 1/ratio).astype(int)
            indices = indices[indices < len(audio)]
            audio = audio[indices]
    except Exception:
        # Assume raw PCM 16-bit 16kHz mono
        audio = np.frombuffer(audio_bytes, dtype=np.int16).astype(np.float32) / 32768.0

    t0 = time.time()
    segments, info = model.transcribe(
        audio,
        beam_size=1,
        best_of=1,
        language=language,
        vad_filter=False,
        without_timestamps=True,
    )
    
    text_parts = []
    for seg in segments:
        text_parts.append(seg.text)
    
    text = "".join(text_parts).strip()
    elapsed = time.time() - t0
    
    result = {
        "text": text,
        "language": info.language if info else None,
        "duration": info.duration if info else 0,
        "inference_ms": int(elapsed * 1000),
    }
    
    if response_format == "verbose_json":
        result["segments"] = [{"text": t} for t in text_parts]
    
    return result


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)
        
        content_type = self.headers.get("Content-Type", "")
        response_format = "json"
        audio_data = None
        language = None  # None = auto-detect
        
        if "multipart/form-data" in content_type:
            # Parse multipart manually (minimal, no deps)
            boundary = content_type.split("boundary=")[1].strip()
            parts = body.split(f"--{boundary}".encode())
            for part in parts:
                part_str = part[:min(500, len(part))]
                if b'name="file"' in part_str or b'name="audio"' in part_str:
                    idx = part.find(b"\r\n\r\n")
                    if idx >= 0:
                        audio_data = part[idx+4:]
                        if audio_data.endswith(b"\r\n"):
                            audio_data = audio_data[:-2]
                elif b'name="response_format"' in part_str:
                    idx = part.find(b"\r\n\r\n")
                    if idx >= 0:
                        val = part[idx+4:].strip().decode("utf-8", errors="ignore").strip()
                        if val in ("json", "verbose_json"):
                            response_format = val
                elif b'name="language"' in part_str:
                    idx = part.find(b"\r\n\r\n")
                    if idx >= 0:
                        language = part[idx+4:].strip().decode("utf-8", errors="ignore").strip() or None
        elif "audio/" in content_type or "application/octet-stream" in content_type:
            audio_data = body
        else:
            audio_data = body
        
        if not audio_data or len(audio_data) < 100:
            self._respond(400, {"error": "No audio data"})
            return
        
        try:
            result = transcribe_audio(audio_data, response_format, language)
            # Filter by allowed languages
            if ALLOWED_LANGUAGES and result.get("language") and result["language"] not in ALLOWED_LANGUAGES:
                result = {"text": "", "language": result["language"], "duration": result.get("duration", 0),
                          "inference_ms": result.get("inference_ms", 0), "filtered": f"language {result['language']} not in {ALLOWED_LANGUAGES}"}
            self._respond(200, result)
        except Exception as e:
            self._respond(500, {"error": str(e)})
    
    def do_GET(self):
        if self.path == "/health":
            self._respond(200, {"status": "ok", "model": MODEL_NAME})
        else:
            self._respond(404, {"error": "Not found"})
    
    def _respond(self, code, data):
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    
    def log_message(self, format, *args):
        # Suppress default logging
        pass


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Whisper server ready on :{PORT}")
    server.serve_forever()
