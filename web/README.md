# OpenClaw Companion — Web Client

Browser-based client for the OpenClaw Companion voice server. Built with React, TypeScript, and Vite.

## Features

- **Push-to-talk voice** — hold to record, release to send
- **Streaming text + audio** — sentences appear and play as they arrive
- **Live2D avatars** — 7 animated models with emotion-reactive expressions
- **Dual display mode** — orb visualizer or Live2D avatar
- **Smart Listen** — ambient always-on listening with wake word detection
- **Speaker identification** — recognizes enrolled voices
- **Barge-in** — interrupt the AI mid-response
- **Text chat with markdown** — full markdown rendering, code block artifacts
- **File & image attachments** — send photos and documents for AI analysis
- **Inline buttons** — interactive response options
- **TTS engine switching** — change between Kokoro, Edge, and XTTS at runtime
- **Speaker profile management** — enroll, rename, reset speaker profiles
- **Auto-reconnect** — reconnects automatically if the WebSocket drops

## Prerequisites

- **Node.js 18+** and npm
- A running [voice server](../server/README.md)

## Quick Start

### Development

```bash
cd web
npm install
npm run dev
```

The dev server starts at `http://localhost:5173`. Open it in your browser and configure the server URL and auth token.

### Production Build

```bash
npm install
npm run build
```

This produces a `dist/` directory with static files ready for deployment.

## Deployment

### Static Hosting (GitHub Pages, Netlify, Vercel, etc.)

Deploy the `dist/` folder to any static hosting service.

**Important:** If your web client is served over HTTPS (which GitHub Pages, Netlify, etc. enforce), the voice server **must** use WSS (TLS). Browsers block `ws://` connections from HTTPS pages. See [TLS setup](../server/README.md#tls--wss-setup) in the server docs.

### Nginx

```nginx
server {
    listen 80;
    server_name companion.example.com;
    root /var/www/companion/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

### Subdirectory Hosting

If deploying under a subdirectory (e.g., `https://example.com/companion/`), configure the Vite base path:

```ts
// vite.config.ts
export default defineConfig({
  base: '/companion/',
  // ...
})
```

Then rebuild: `npm run build`.

## Configuration

On first load, open **Settings** (gear icon) and configure:

| Setting | Description |
|---------|-------------|
| **Server URL** | Voice server WebSocket URL (e.g., `ws://192.168.1.100:3200` or `wss://your-host:3443`) |
| **Auth Token** | Shared secret matching the server's `AUTH_TOKEN` |

Settings are saved to localStorage and persist across sessions.

### HTTPS → WSS Requirement

| Web Client URL | Required Server URL |
|----------------|-------------------|
| `http://...` | `ws://server:3200` ✅ |
| `https://...` | `wss://server:3443` ✅ |
| `https://...` | `ws://server:3200` ❌ Blocked by browser |

## Audio

- Records PCM audio at 16kHz, mono, 16-bit
- Encodes to WAV in the browser
- Sends base64-encoded WAV over WebSocket
- Receives audio chunks (MP3/WAV depending on TTS engine) and plays them sequentially

## Tech Stack

- **React 19** + TypeScript
- **Vite** — build tool with HMR
- **pixi-live2d-display** — Live2D avatar rendering
- **WebSocket API** — real-time communication with voice server
