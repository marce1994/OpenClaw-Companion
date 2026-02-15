#!/bin/bash
set -e

echo "[Entrypoint] Cleaning up stale X locks..."
rm -f /tmp/.X99-lock /tmp/.X11-unix/X99 2>/dev/null || true

echo "[Entrypoint] Starting Xvfb on :99..."
Xvfb :99 -screen 0 1280x720x24 -ac +extension GLX +render -noreset &
XVFB_PID=$!
sleep 1

echo "[Entrypoint] Starting PulseAudio..."
pulseaudio --kill 2>/dev/null || true
rm -f /tmp/pulse-*/pid 2>/dev/null || true
sleep 0.5
pulseaudio --daemonize --no-cpu-limit --disable-shm=true --exit-idle-time=-1 \
  --system=false --log-level=warning 2>/dev/null || true
sleep 1

echo "[Entrypoint] Creating virtual audio devices..."

# TTS output sink — TTS audio goes here, its monitor feeds Chrome as mic
pactl load-module module-null-sink sink_name=tts_output sink_properties=device.description="TTS_Output"

# Create a virtual source from tts_output's monitor so Chrome picks it up as a mic
pactl load-module module-remap-source master=tts_output.monitor source_name=virtual_mic source_properties=device.description="Virtual_Mic"

# Meet capture sink — we route Meet's audio output here so we can record it
pactl load-module module-null-sink sink_name=meet_capture sink_properties=device.description="Meet_Capture"

# Set defaults
pactl set-default-sink meet_capture
pactl set-default-source virtual_mic

echo "[Entrypoint] Audio devices created:"
pactl list short sinks
pactl list short sources

echo "[Entrypoint] Generating silence.wav..."
./scripts/generate-silence.sh

echo "[Entrypoint] Setup complete. Starting application..."
exec "$@"
