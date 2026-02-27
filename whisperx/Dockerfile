FROM python:3.11-slim

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg libsndfile1 git && \
    rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir --upgrade pip setuptools wheel

# Install PyTorch with CUDA (single version, shared by all)
RUN pip install --no-cache-dir \
    torch torchaudio --index-url https://download.pytorch.org/whl/cu124

# Install whisperx (--no-deps to avoid pulling duplicate torch)
# Then install its actual deps minus torch
RUN pip install --no-cache-dir --no-deps whisperx && \
    pip install --no-cache-dir \
    faster-whisper ctranslate2 transformers \
    pyannote.audio pyannote.core pyannote.pipeline \
    nltk pandas onnxruntime

# Flask for REST API
RUN pip install --no-cache-dir flask gunicorn

WORKDIR /app
COPY server.py .

ENV WHISPER_MODEL=large-v3-turbo
ENV HF_TOKEN=""
ENV DEVICE=cuda
ENV COMPUTE_TYPE=float16

EXPOSE 8088

CMD ["gunicorn", "-b", "0.0.0.0:8088", "-w", "1", "--timeout", "600", "server:app"]
