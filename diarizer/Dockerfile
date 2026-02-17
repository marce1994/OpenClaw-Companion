FROM python:3.11

WORKDIR /app

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg libsndfile1 && \
    rm -rf /var/lib/apt/lists/*

# Install PyTorch with CUDA support
RUN pip install --no-cache-dir \
    torch torchaudio --index-url https://download.pytorch.org/whl/cu124

# Install deps (pandas wheel, then diart + pyannote)
RUN pip install --no-cache-dir pandas websockets
RUN pip install --no-cache-dir diart pyannote.audio

COPY server.py .

ENV PYTHONUNBUFFERED=1
EXPOSE 3202

CMD ["python", "server.py"]
