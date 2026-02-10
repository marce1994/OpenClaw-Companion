# Android App

Push-to-talk voice assistant Android app that connects to the OpenClaw Companion bridge server via WebSocket.

## Build

### With Docker (no Android SDK needed)

```bash
docker build -t openclaw-companion-apk .
docker run --rm openclaw-companion-apk > openclaw-companion.apk
adb install openclaw-companion.apk
```

### With Android Studio

1. Open this directory in Android Studio
2. Sync Gradle
3. Build → Build APK(s)
4. APK is at `app/build/outputs/apk/debug/app-debug.apk`

### Build Configuration

| Setting | Value |
|---------|-------|
| Min SDK | 26 (Android 8.0) |
| Target SDK | 34 (Android 14) |
| Kotlin | 1.9.22 |
| Gradle | 8.5 |
| AGP | 8.2.2 |

## Configuration

On first launch, open **Settings** (gear icon) and configure:

| Setting | Default | Description |
|---------|---------|-------------|
| Server URL | — | Bridge server address (e.g. `http://192.168.1.100:3200`) |
| Auth Token | — | Shared secret (must match server's `AUTH_TOKEN`) |
| Auto-play | On | Automatically play audio responses |
| Vibrate | On | Haptic feedback on recording start |

The server URL can use any reachable address — LAN IP, Tailscale IP, or a public URL.

## Features

- **Push-to-talk** — hold the mic button to record, release to send
- **Text input** — type messages via keyboard
- **Audio playback queue** — sentences play in order as they arrive from the server
- **Auto-reconnect** — reconnects automatically if the WebSocket drops
- **Headphone media button** — trigger recording via wired/Bluetooth headset button
- **Lock screen support** — foreground service keeps the app active with screen off
- **Emotion display** — avatar reacts based on detected emotion in the response
- **Replay** — tap to hear the last response again

## Audio Pipeline

1. Records PCM audio (16kHz, mono, 16-bit)
2. Encodes to WAV in-memory
3. Sends base64-encoded WAV over WebSocket
4. Receives sentence-by-sentence MP3 audio chunks
5. Plays chunks sequentially via audio queue

## i18n

The app supports:
- **English** (default)
- **Spanish**

Language follows the device locale. Translations are in `app/src/main/res/values-es/`.

## Permissions

| Permission | Purpose |
|------------|---------|
| `RECORD_AUDIO` | Microphone access |
| `INTERNET` | Server communication |
| `FOREGROUND_SERVICE` | Background operation |
| `FOREGROUND_SERVICE_MICROPHONE` | Mic in foreground service |
| `WAKE_LOCK` | Keep CPU active during recording |
| `VIBRATE` | Haptic feedback |
