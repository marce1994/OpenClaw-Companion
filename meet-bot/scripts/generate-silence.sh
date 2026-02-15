#!/bin/bash
# Generate a 1-second silence WAV file for Chrome's --use-file-for-fake-audio-capture
# 16-bit PCM, 48kHz, mono (Chrome expects 48kHz for WebRTC)
ffmpeg -y -f lavfi -i anullsrc=r=48000:cl=mono -t 1 -c:a pcm_s16le /tmp/silence.wav 2>/dev/null
echo "[Silence] Generated /tmp/silence.wav"
