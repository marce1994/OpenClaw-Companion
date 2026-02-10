FROM python:3.12-slim AS base

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    nodejs npm libsndfile1 ffmpeg gcc python3-dev bash && \
    rm -rf /var/lib/apt/lists/*

# PyTorch CPU-only (much smaller than full torch)
RUN pip install --no-cache-dir \
    torch --index-url https://download.pytorch.org/whl/cpu

# Python packages: edge-tts + resemblyzer + web search
RUN pip install --no-cache-dir \
    edge-tts \
    resemblyzer \
    soundfile \
    numpy \
    scipy \
    librosa \
    duckduckgo-search

# Warm up: download the pretrained model at build time
RUN python -c "from resemblyzer import VoiceEncoder; VoiceEncoder()" 

WORKDIR /app
COPY package.json .
RUN npm install
COPY index.js .
COPY speaker_service.py .
COPY start.sh .
RUN chmod +x start.sh

RUN mkdir -p /data/speakers

EXPOSE 3200
CMD ["bash", "./start.sh"]
