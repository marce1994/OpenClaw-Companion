"""
WhisperX Diarized Transcription API
Ephemeral GPU container — starts, transcribes one file, can serve multiple requests.
POST /transcribe with audio file → returns diarized transcript JSON.
"""

import os
import sys
import tempfile
import json
import logging
from flask import Flask, request, jsonify

logging.basicConfig(level=logging.INFO, format='[WhisperX] %(message)s')
log = logging.getLogger('whisperx')

app = Flask(__name__)

# Lazy-loaded model
_model = None
_align_model = None
_diarize_pipeline = None

HF_TOKEN = os.environ.get('HF_TOKEN', '')
DEVICE = 'cuda'
COMPUTE_TYPE = 'float16'
MODEL_NAME = 'large-v3-turbo'


def get_model():
    global _model
    if _model is None:
        import whisperx
        log.info(f'Loading WhisperX model: {MODEL_NAME}...')
        _model = whisperx.load_model(MODEL_NAME, DEVICE, compute_type=COMPUTE_TYPE)
        log.info('Model loaded.')
    return _model


def get_diarize_pipeline():
    global _diarize_pipeline
    if _diarize_pipeline is None:
        import whisperx
        if not HF_TOKEN:
            raise ValueError('HF_TOKEN required for diarization (pyannote gated models)')
        log.info('Loading diarization pipeline...')
        _diarize_pipeline = whisperx.DiarizationPipeline(use_auth_token=HF_TOKEN, device=DEVICE)
        log.info('Diarization pipeline loaded.')
    return _diarize_pipeline


@app.route('/health', methods=['GET'])
def health():
    return jsonify({'ok': True})


@app.route('/transcribe', methods=['POST'])
def transcribe():
    """
    Transcribe and optionally diarize an audio file.
    
    Form params:
      - file: audio file (required)
      - diarize: 'true' to enable speaker diarization (default: false)
      - language: language code (optional, auto-detected if omitted)
      - min_speakers: minimum speakers for diarization
      - max_speakers: maximum speakers for diarization
    """
    import whisperx

    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400

    audio_file = request.files['file']
    diarize = request.form.get('diarize', 'false').lower() == 'true'
    language = request.form.get('language', None) or None
    min_speakers = int(request.form.get('min_speakers', 0)) or None
    max_speakers = int(request.form.get('max_speakers', 0)) or None

    # Save to temp file
    with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
        audio_file.save(f)
        tmp_path = f.name

    try:
        # Load audio
        log.info(f'Loading audio: {tmp_path}')
        audio = whisperx.load_audio(tmp_path)

        # Transcribe
        model = get_model()
        log.info(f'Transcribing (lang={language or "auto"})...')
        result = model.transcribe(audio, language=language, batch_size=16)
        detected_lang = result.get('language', language or 'unknown')
        log.info(f'Transcription done. Language: {detected_lang}, segments: {len(result["segments"])}')

        # Align
        log.info('Aligning...')
        align_model, align_metadata = whisperx.load_align_model(
            language_code=detected_lang, device=DEVICE
        )
        result = whisperx.align(
            result['segments'], align_model, align_metadata, audio, DEVICE,
            return_char_alignments=False
        )

        # Diarize
        if diarize:
            log.info(f'Diarizing (min={min_speakers}, max={max_speakers})...')
            pipeline = get_diarize_pipeline()
            diarize_segments = pipeline(
                tmp_path,
                min_speakers=min_speakers,
                max_speakers=max_speakers
            )
            result = whisperx.assign_word_speakers(diarize_segments, result)
            log.info('Diarization done.')

        # Build response
        segments = []
        for seg in result.get('segments', []):
            segments.append({
                'start': round(seg.get('start', 0), 2),
                'end': round(seg.get('end', 0), 2),
                'text': seg.get('text', '').strip(),
                'speaker': seg.get('speaker', None),
            })

        return jsonify({
            'language': detected_lang,
            'segments': segments,
        })

    except Exception as e:
        log.error(f'Error: {e}', exc_info=True)
        return jsonify({'error': str(e)}), 500
    finally:
        os.unlink(tmp_path)


if __name__ == '__main__':
    port = int(os.environ.get('PORT', '9090'))
    log.info(f'Starting WhisperX API on port {port}')
    # Pre-load model on startup
    get_model()
    app.run(host='0.0.0.0', port=port, threaded=False)
