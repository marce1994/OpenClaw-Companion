FROM node:22-bookworm

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    pulseaudio \
    xvfb \
    ffmpeg \
    python3 python3-pip \
    alsa-utils \
    procps \
    dbus \
    libegl1-mesa \
    curl \
    xdotool \
    && (apt-get install -y --no-install-recommends libswiftshader-vk 2>/dev/null || true) \
    && pip3 install --break-system-packages edge-tts \
    && rm -rf /var/lib/apt/lists/*

ENV CHROME_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV DISPLAY=:99

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY scripts/ ./scripts/
RUN chmod +x scripts/*.sh

COPY src/ ./src/
COPY public/ ./public/

RUN mkdir -p /data/meetings

EXPOSE 3300

ENTRYPOINT ["./scripts/entrypoint.sh"]
CMD ["node", "src/index.js"]
