FROM python:3.11

WORKDIR /app

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg libsndfile1 libportaudio2 && \
    rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir --upgrade pip setuptools wheel

# PyTorch 2.6 + CUDA 12.4
RUN pip install --no-cache-dir \
    torch torchaudio --index-url https://download.pytorch.org/whl/cu124

# Pin numpy<2, pandas for compatibility
RUN pip install --no-cache-dir "numpy<2" "pandas==2.0.3" websockets

# pyannote.audio 3.3.2 (compatible with torch 2.6, unlike 3.4.0)
RUN pip install --no-cache-dir "pyannote.audio==3.3.2"

# diart with --no-deps to avoid pulling incompatible versions
RUN pip install --no-cache-dir --no-deps diart
RUN pip install --no-cache-dir rx rxpy einops rich optuna sounddevice websocket-client

COPY server.py .

ENV PYTHONUNBUFFERED=1
EXPOSE 3202

CMD ["python", "server.py"]
