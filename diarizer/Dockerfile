FROM python:3.12-slim

WORKDIR /app

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg libsndfile1 build-essential && \
    rm -rf /var/lib/apt/lists/*

# Install PyTorch with CUDA support + diart
RUN pip install --no-cache-dir \
    torch torchaudio --index-url https://download.pytorch.org/whl/cu124 && \
    pip install --no-cache-dir \
    diart \
    websockets \
    pyannote.audio

COPY server.py .

ENV PYTHONUNBUFFERED=1
EXPOSE 3202

CMD ["python", "server.py"]
