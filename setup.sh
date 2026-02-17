#!/bin/bash
# ╔══════════════════════════════════════════════════════════════════════════╗
# ║  OpenClaw Companion — Interactive Setup                                ║
# ╚══════════════════════════════════════════════════════════════════════════╝

set -e

BOLD='\033[1m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${BOLD}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║  🐾 OpenClaw Companion Setup                               ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check Docker
if ! command -v docker &> /dev/null; then
    echo "❌ Docker not found. Install it first: https://docs.docker.com/get-docker/"
    exit 1
fi

if ! docker compose version &> /dev/null && ! docker-compose version &> /dev/null; then
    echo "❌ Docker Compose not found. Install it first."
    exit 1
fi

COMPOSE_CMD="docker compose"
if ! docker compose version &> /dev/null; then
    COMPOSE_CMD="docker-compose"
fi

echo -e "${GREEN}✅ Docker found${NC}"
echo ""

# Check GPU
HAS_GPU=false
if command -v nvidia-smi &> /dev/null && nvidia-smi &> /dev/null; then
    HAS_GPU=true
    GPU_NAME=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1)
    echo -e "${GREEN}✅ GPU detected: ${GPU_NAME}${NC}"
else
    echo -e "${YELLOW}⚠️  No NVIDIA GPU detected. Will use CPU mode (slower STT/TTS).${NC}"
fi
echo ""

# Create .env from template
if [ -f .env ]; then
    echo -e "${YELLOW}⚠️  .env already exists. Overwrite? (y/N)${NC}"
    read -r overwrite
    if [[ ! "$overwrite" =~ ^[Yy]$ ]]; then
        echo "Keeping existing .env"
        echo ""
    else
        cp .env.example .env
    fi
else
    cp .env.example .env
fi

# Interactive configuration
echo -e "${BOLD}─── Configuration ───${NC}"
echo ""

# Gateway URL
echo -e "${CYAN}OpenClaw Gateway WebSocket URL${NC}"
echo "  Default: ws://127.0.0.1:18789"
echo "  (If OpenClaw runs on another machine, use its IP)"
read -p "  Gateway WS URL [ws://127.0.0.1:18789]: " gw_url
gw_url=${gw_url:-ws://127.0.0.1:18789}
sed -i "s|GATEWAY_WS_URL=.*|GATEWAY_WS_URL=${gw_url}|" .env

# Gateway Token
echo ""
echo -e "${CYAN}OpenClaw Gateway Token${NC}"
echo "  Find in your openclaw.json → gateway.auth.token"
read -p "  Token: " gw_token
if [ -n "$gw_token" ]; then
    sed -i "s|GATEWAY_TOKEN=.*|GATEWAY_TOKEN=${gw_token}|" .env
fi

# Auth Token
echo ""
echo -e "${CYAN}Voice Server Auth Token${NC}"
echo "  Shared secret between the app and server (pick anything)"
read -p "  Auth token [auto-generate]: " auth_token
if [ -z "$auth_token" ]; then
    auth_token=$(openssl rand -hex 16 2>/dev/null || head -c 32 /dev/urandom | xxd -p)
    echo "  Generated: $auth_token"
fi
sed -i "s|AUTH_TOKEN=.*|AUTH_TOKEN=${auth_token}|" .env

# TTS Engine
echo ""
echo -e "${CYAN}TTS Engine${NC}"
if [ "$HAS_GPU" = true ]; then
    echo "  1) kokoro — Local GPU, fast (~340ms), multiple voices [recommended]"
    echo "  2) edge   — Microsoft Cloud, free, no GPU needed (~2s)"
    read -p "  Choice [1]: " tts_choice
    tts_choice=${tts_choice:-1}
else
    echo "  1) edge   — Microsoft Cloud, free (~2s) [recommended for CPU]"
    echo "  2) kokoro — Local CPU (~1s, slower than GPU)"
    read -p "  Choice [1]: " tts_choice
    tts_choice=${tts_choice:-1}
fi

if [ "$HAS_GPU" = true ]; then
    [ "$tts_choice" = "1" ] && tts_engine="kokoro" || tts_engine="edge"
else
    [ "$tts_choice" = "1" ] && tts_engine="edge" || tts_engine="kokoro"
fi
sed -i "s|TTS_ENGINE=.*|TTS_ENGINE=${tts_engine}|" .env

# Bot Name
echo ""
read -p "Bot name [assistant]: " bot_name
bot_name=${bot_name:-assistant}
sed -i "s|BOT_NAME=.*|BOT_NAME=${bot_name}|" .env

# Owner Name
read -p "Your name [User]: " owner_name
owner_name=${owner_name:-User}
sed -i "s|OWNER_NAME=.*|OWNER_NAME=${owner_name}|" .env

# HuggingFace Token
echo ""
echo -e "${CYAN}HuggingFace Token (optional)${NC}"
echo "  Needed for Systran STT model + speaker diarization"
echo "  Get one at: https://huggingface.co/settings/tokens"
read -p "  HF Token (leave empty to skip): " hf_token
if [ -n "$hf_token" ]; then
    sed -i "s|HF_TOKEN=.*|HF_TOKEN=${hf_token}|" .env
fi

# Meet Bot
echo ""
echo -e "${CYAN}Enable Google Meet Bot? (y/N)${NC}"
read -r enable_meet
PROFILES=""
if [ "$HAS_GPU" = true ]; then
    PROFILES="--profile gpu"
fi
if [[ "$enable_meet" =~ ^[Yy]$ ]]; then
    PROFILES="$PROFILES --profile meet"
fi

echo ""
echo -e "${BOLD}─── Summary ───${NC}"
echo "  Gateway:    $gw_url"
echo "  TTS Engine: $tts_engine"
echo "  Bot Name:   $bot_name"
echo "  GPU:        $HAS_GPU"
echo "  Meet Bot:   ${enable_meet:-no}"
echo ""

# Launch
echo -e "${BOLD}Ready to launch! 🚀${NC}"
read -p "Start services now? (Y/n): " start_now
start_now=${start_now:-Y}

if [[ "$start_now" =~ ^[Yy]$ ]]; then
    echo ""
    echo -e "${CYAN}Starting services...${NC}"
    $COMPOSE_CMD $PROFILES up -d
    echo ""
    echo -e "${GREEN}✅ OpenClaw Companion is running!${NC}"
    echo ""
    echo "  Voice Server: ws://localhost:${VOICE_PORT:-3200}"
    echo "  STT Engine:   http://localhost:${STT_PORT:-9000}"
    if [ "$tts_engine" = "kokoro" ]; then
        echo "  Kokoro TTS:   http://localhost:${KOKORO_PORT:-5004}"
    fi
    if [[ "$enable_meet" =~ ^[Yy]$ ]]; then
        echo "  Meet Bot:     http://localhost:${MEET_PORT:-3300}"
    fi
    echo ""
    echo "  Configure the Android/Web app with:"
    echo "    Server URL: ws://YOUR_IP:${VOICE_PORT:-3200}"
    echo "    Token:      $auth_token"
    echo ""
    echo "  View logs: $COMPOSE_CMD $PROFILES logs -f"
    echo "  Stop:      $COMPOSE_CMD $PROFILES down"
else
    echo ""
    echo "To start later:"
    echo "  $COMPOSE_CMD $PROFILES up -d"
fi
