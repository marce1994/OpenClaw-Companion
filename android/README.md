# OpenClaw Companion — Android App

Voice-first AI assistant Android app with animated Live2D avatars. Connects to the OpenClaw Companion voice server via WebSocket.

## Features

- **Push-to-talk voice** — hold the mic button to record, release to send
- **Live2D avatars** — 7 animated models with 9 emotion states
- **Dual display mode** — switch between orb visualizer and Live2D avatar
- **Smart Listen** — ambient always-on listening with wake word detection
- **Speaker identification** — recognizes enrolled voices, auto-enrollment
- **Barge-in** — interrupt the AI mid-response by starting to speak
- **Text chat with markdown** — full markdown rendering with code block artifacts
- **File & image attachments** — send photos and documents for AI analysis
- **Inline buttons** — interactive response options from the AI
- **TTS engine switching** — change between Kokoro, Edge, and XTTS at runtime
- **Speaker profile management** — enroll, rename, reset speaker profiles
- **Auto-reconnect** — reconnects automatically if the WebSocket drops
- **Headphone media button** — trigger recording via wired/Bluetooth headset button
- **Lock screen support** — foreground service keeps the app active with screen off
- **Haptic feedback** — vibration on recording start
- **Replay** — tap to hear the last response again
- **i18n** — English (default) and Spanish

## Build

### Option A — Docker Build (No Android SDK Needed)

```bash
cd android

# Build the Docker image with all SDK tools
docker build -f Dockerfile -t openclaw-companion-builder .

# Extract the APK from the container
docker cp $(docker create openclaw-companion-builder):/app/app/build/outputs/apk/debug/app-debug.apk ./openclaw-companion.apk

# Install on device
adb install openclaw-companion.apk
```

### Option B — Android Studio

1. Open the `android/` directory in Android Studio
2. Wait for Gradle sync to complete
3. **Build → Build APK(s)**
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
| Server URL | — | Voice server address (e.g., `http://192.168.1.100:3200`) |
| Auth Token | — | Shared secret (must match server's `AUTH_TOKEN`) |
| Auto-play | On | Automatically play audio responses |
| Vibrate | On | Haptic feedback on recording start |

The server URL can use any reachable address — LAN IP, Tailscale IP, or a public URL. Use `http://` for plain WS or `https://` for WSS.

## Permissions

| Permission | Purpose |
|------------|---------|
| `RECORD_AUDIO` | Microphone access for voice input |
| `INTERNET` | WebSocket communication with voice server |
| `FOREGROUND_SERVICE` | Background operation with screen off |
| `FOREGROUND_SERVICE_MICROPHONE` | Mic access in foreground service |
| `WAKE_LOCK` | Keep CPU active during recording |
| `VIBRATE` | Haptic feedback |

## Audio Pipeline

1. Records PCM audio (16kHz, mono, 16-bit)
2. Encodes to WAV in-memory
3. Sends base64-encoded WAV over WebSocket
4. Receives sentence-by-sentence audio chunks (MP3/WAV)
5. Plays chunks sequentially via audio queue

## Live2D Avatars

The app includes 7 Live2D models with 9 emotion expressions:

**Emotions:** happy, sad, surprised, thinking, confused, laughing, neutral, angry, love

The avatar animates in real-time based on emotion tags in the AI response. Users can switch between the orb visualizer (audio-reactive) and Live2D avatar mode.

## i18n

The app supports:
- **English** (default)
- **Spanish**

Language follows the device locale. Translations are in `app/src/main/res/values-es/`.
