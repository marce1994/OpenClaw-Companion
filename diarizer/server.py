"""
Diart Speaker Diarization Service
Real-time streaming speaker diarization via WebSocket.

Receives raw PCM audio (16kHz, 16-bit, mono) and emits speaker labels in real-time.
Uses pyannote segmentation + embedding models with incremental clustering.
"""

import asyncio
import json
import logging
import os
import signal
import sys
from typing import Optional

import numpy as np
import torch
import torchaudio
# Monkey-patch: torchaudio 2.6+ removed set_audio_backend, but diart calls it
if not hasattr(torchaudio, 'set_audio_backend'):
    torchaudio.set_audio_backend = lambda x: None
from websockets.asyncio.server import serve

logging.basicConfig(level=logging.INFO, format='[Diarizer] %(message)s')
log = logging.getLogger('diarizer')

# Config
HOST = os.getenv('HOST', '0.0.0.0')
WS_PORT = int(os.getenv('WS_PORT', '3202'))
HTTP_PORT = int(os.getenv('HTTP_PORT', '3203'))
HF_TOKEN = os.getenv('HF_TOKEN', '')
SAMPLE_RATE = 16000
LATENCY = float(os.getenv('LATENCY', '2.0'))  # seconds
STEP = float(os.getenv('STEP', '0.5'))  # processing window step
TAU_ACTIVE = float(os.getenv('TAU_ACTIVE', '0.5'))  # voice activity threshold
DELTA_NEW = float(os.getenv('DELTA_NEW', '1.0'))  # new speaker threshold
DEVICE = 'cuda' if torch.cuda.is_available() else 'cpu'

log.info(f'Device: {DEVICE}, Latency: {LATENCY}s, Step: {STEP}s')
log.info(f'HF Token: {"set" if HF_TOKEN else "NOT SET"}')

# Import diart
from diart import SpeakerDiarization
from diart.inference import StreamingInference
from diart.sources import AudioSource
import rx.subject


class WebSocketAudioSource(AudioSource):
    """Custom audio source that receives PCM from WebSocket."""
    
    def __init__(self, sample_rate=16000, block_duration=0.5):
        self._sample_rate = sample_rate
        self._block_duration = block_duration
        self._subject = rx.subject.Subject()
        self._closed = False
    
    @property
    def sample_rate(self) -> int:
        return self._sample_rate
    
    @property
    def duration(self) -> Optional[float]:
        return None  # Infinite stream
    
    def read(self):
        return self._subject
    
    def close(self):
        self._closed = True
        self._subject.on_completed()
    
    def push_audio(self, pcm_data: np.ndarray):
        """Push PCM samples as float32 numpy array, shape (n_samples, 1)."""
        if not self._closed:
            # Diart expects (n_channels=1, n_samples) torch tensor
            waveform = torch.from_numpy(pcm_data).float().unsqueeze(0)
            self._subject.on_next(waveform)


class DiarizationService:
    def __init__(self):
        self.pipeline = None
        self.clients = set()
        self.speaker_map = {}  # Map internal IDs to friendly names
        self.speaker_count = 0
        self.current_speakers = {}  # Track who's speaking now
        
    def init_pipeline(self):
        log.info('Loading diarization pipeline...')
        self.pipeline = SpeakerDiarization(
            segmentation_model="pyannote/segmentation-3.0",
            embedding_model="pyannote/embedding",
            latency=LATENCY,
            step=STEP,
            tau_active=TAU_ACTIVE,
            delta_new=DELTA_NEW,
            device=torch.device(DEVICE),
        )
        log.info('Pipeline loaded!')
    
    def _get_speaker_name(self, label: int) -> str:
        if label not in self.speaker_map:
            self.speaker_count += 1
            self.speaker_map[label] = f'Speaker_{self.speaker_count}'
        return self.speaker_map[label]
    
    async def handle_ws(self, websocket):
        client_id = id(websocket)
        log.info(f'Client connected: {client_id}')
        self.clients.add(websocket)
        
        # Create per-client audio source and inference
        source = WebSocketAudioSource(
            sample_rate=SAMPLE_RATE,
            block_duration=STEP,
        )
        
        # Track active speakers for this client
        active_speakers = {}
        
        def on_diarization(annotation, audio):
            """Called by diart with diarization results."""
            try:
                # annotation is a pyannote.core.Annotation
                current = {}
                for segment, _, label in annotation.itertracks(yield_label=True):
                    speaker = self._get_speaker_name(label)
                    current[speaker] = {
                        'start': round(segment.start, 2),
                        'end': round(segment.end, 2),
                    }
                
                # Detect changes
                started = set(current.keys()) - set(active_speakers.keys())
                ended = set(active_speakers.keys()) - set(current.keys())
                
                for s in started:
                    msg = json.dumps({
                        'type': 'speaker-start',
                        'speaker': s,
                        'start': current[s]['start'],
                    })
                    asyncio.get_event_loop().call_soon_threadsafe(
                        asyncio.ensure_future,
                        self._broadcast(msg, websocket)
                    )
                
                for s in ended:
                    msg = json.dumps({
                        'type': 'speaker-end',
                        'speaker': s,
                        'end': active_speakers[s]['end'],
                    })
                    asyncio.get_event_loop().call_soon_threadsafe(
                        asyncio.ensure_future,
                        self._broadcast(msg, websocket)
                    )
                
                # Always send current state
                if current:
                    msg = json.dumps({
                        'type': 'speakers',
                        'speakers': current,
                        'count': len(self.speaker_map),
                    })
                    asyncio.get_event_loop().call_soon_threadsafe(
                        asyncio.ensure_future,
                        self._broadcast(msg, websocket)
                    )
                
                active_speakers.clear()
                active_speakers.update(current)
                
            except Exception as e:
                log.error(f'Diarization callback error: {e}')
        
        # Start inference in background thread
        inference = StreamingInference(
            pipeline=self.pipeline,
            source=source,
            do_plot=False,
        )
        inference.attach_observers(on_diarization)
        
        import threading
        inference_thread = threading.Thread(
            target=lambda: inference(),
            daemon=True,
        )
        inference_thread.start()
        log.info(f'Inference started for client {client_id}')
        
        try:
            # Buffer for accumulating PCM bytes
            pcm_buffer = b''
            chunk_size = int(STEP * SAMPLE_RATE * 2)  # bytes per step
            
            async for message in websocket:
                if isinstance(message, bytes):
                    pcm_buffer += message
                    
                    # Process in chunks matching the step size
                    while len(pcm_buffer) >= chunk_size:
                        chunk = pcm_buffer[:chunk_size]
                        pcm_buffer = pcm_buffer[chunk_size:]
                        
                        # Convert to float32 numpy
                        samples = np.frombuffer(chunk, dtype=np.int16).astype(np.float32) / 32768.0
                        source.push_audio(samples)
                
                elif isinstance(message, str):
                    try:
                        cmd = json.loads(message)
                        if cmd.get('type') == 'rename':
                            old = cmd.get('old')
                            new = cmd.get('new')
                            for k, v in self.speaker_map.items():
                                if v == old:
                                    self.speaker_map[k] = new
                                    log.info(f'Renamed: {old} → {new}')
                                    break
                        elif cmd.get('type') == 'status':
                            await websocket.send(json.dumps({
                                'type': 'status',
                                'speakers': dict(self.speaker_map),
                                'count': self.speaker_count,
                                'active': active_speakers,
                            }))
                    except json.JSONDecodeError:
                        pass
                        
        except Exception as e:
            log.info(f'Client {client_id} disconnected: {e}')
        finally:
            self.clients.discard(websocket)
            source.close()
            log.info(f'Client {client_id} cleaned up')
    
    async def _broadcast(self, msg, target_ws):
        try:
            await target_ws.send(msg)
        except Exception:
            pass
    
    async def run(self):
        self.init_pipeline()
        
        log.info(f'WebSocket server starting on {HOST}:{WS_PORT}')
        async with serve(self.handle_ws, HOST, WS_PORT):
            log.info(f'✅ Diarization service ready on ws://{HOST}:{WS_PORT}')
            await asyncio.Future()  # Run forever


async def main():
    service = DiarizationService()
    await service.run()


if __name__ == '__main__':
    asyncio.run(main())
