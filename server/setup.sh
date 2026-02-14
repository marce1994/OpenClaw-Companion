#!/bin/bash

#########################################################################
# OpenClaw Companion Voice Server Setup Script
# 
# This script sets up the complete voice server stack with interactive
# configuration and health checks.
#########################################################################

set -euo pipefail

# Color definitions
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Emoji definitions
CHECK='✅'
CROSS='❌'
WARN='⚠️'
INFO='ℹ️'
ARROW='→'
LOADING='⏳'
ROCKET='🚀'

# Configuration defaults
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${SCRIPT_DIR}/.env"
DOCKERFILE="${SCRIPT_DIR}/Dockerfile"

#########################################################################
# Helper Functions
#########################################################################

log_header() {
    echo ""
    echo -e "${BLUE}╔════════════════════════════════════════════════════════╗${NC}"
    echo -e "${BLUE}║${NC} $1"
    echo -e "${BLUE}╚════════════════════════════════════════════════════════╝${NC}"
    echo ""
}

log_success() {
    echo -e "${GREEN}${CHECK}${NC} $1"
}

log_error() {
    echo -e "${RED}${CROSS}${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}${WARN}${NC} $1"
}

log_info() {
    echo -e "${CYAN}${INFO}${NC} $1"
}

log_step() {
    echo -e "${BLUE}${ARROW}${NC} $1"
}

prompt() {
    local prompt_text="$1"
    local default="$2"
    local input
    
    if [ -n "$default" ]; then
        echo -ne "${CYAN}?${NC} ${prompt_text} ${BLUE}[${default}]${NC}: "
    else
        echo -ne "${CYAN}?${NC} ${prompt_text}: "
    fi
    
    read -r input
    
    if [ -z "$input" ] && [ -n "$default" ]; then
        echo "$default"
    else
        echo "$input"
    fi
}

prompt_yes_no() {
    local prompt_text="$1"
    local default="$2"
    local response
    
    if [ "$default" == "y" ]; then
        echo -ne "${CYAN}?${NC} ${prompt_text} ${BLUE}[Y/n]${NC}: "
    else
        echo -ne "${CYAN}?${NC} ${prompt_text} ${BLUE}[y/N]${NC}: "
    fi
    
    read -r response
    
    case "$response" in
        [yY])
            echo "y"
            return 0
            ;;
        [nN])
            echo "n"
            return 1
            ;;
        *)
            if [ "$default" == "y" ]; then
                echo "y"
                return 0
            else
                echo "n"
                return 1
            fi
            ;;
    esac
}

generate_token() {
    openssl rand -hex 32
}

#########################################################################
# Prerequisites Check
#########################################################################

check_prerequisites() {
    log_header "Checking Prerequisites"
    
    local all_good=true
    
    # Check Docker
    if command -v docker &> /dev/null; then
        local docker_version=$(docker --version)
        log_success "Docker installed: $docker_version"
    else
        log_error "Docker not found. Please install Docker first."
        all_good=false
    fi
    
    # Check Docker Compose v2
    if command -v docker compose &> /dev/null; then
        local compose_version=$(docker compose version | head -n1)
        log_success "Docker Compose installed: $compose_version"
    else
        log_error "Docker Compose v2 not found. Please install Docker Desktop or Docker Compose v2."
        all_good=false
    fi
    
    # Check if Docker daemon is running
    if docker ps &> /dev/null; then
        log_success "Docker daemon is running"
    else
        log_error "Docker daemon is not running. Please start Docker."
        all_good=false
    fi
    
    # Check if Dockerfile exists
    if [ -f "$DOCKERFILE" ]; then
        log_success "Dockerfile found"
    else
        log_warning "Dockerfile not found at $DOCKERFILE. You'll need to create it."
    fi
    
    if [ "$all_good" == false ]; then
        echo ""
        log_error "Prerequisites check failed. Please fix the issues above."
        exit 1
    fi
    
    echo ""
}

#########################################################################
# Interactive Configuration
#########################################################################

interactive_config() {
    log_header "OpenClaw Companion Configuration"
    
    # Gateway configuration
    log_step "Gateway Connection"
    GATEWAY_WS_URL=$(prompt "OpenClaw Gateway WebSocket URL" "ws://localhost:18789")
    GATEWAY_TOKEN=$(prompt "OpenClaw Gateway Authentication Token" "")
    
    if [ -z "$GATEWAY_TOKEN" ]; then
        log_error "Gateway token cannot be empty"
        exit 1
    fi
    
    # Bot configuration
    echo ""
    log_step "Bot Configuration"
    BOT_NAME=$(prompt "Bot Name" "jarvis")
    OWNER_NAME=$(prompt "Owner Name" "Pablo")
    
    # Language selection
    echo ""
    log_step "Language & Voice Configuration"
    echo "Select language for TTS:"
    echo "  1) Spanish (default)"
    echo "  2) English"
    echo "  3) French"
    echo "  4) German"
    echo "  5) Italian"
    
    read -p "Choose language [1-5]: " lang_choice
    
    case "$lang_choice" in
        1|"")
            LANGUAGE="es"
            TTS_VOICE="es-AR-TomasNeural"
            WHISPER_LANGUAGE="es"
            ;;
        2)
            LANGUAGE="en"
            TTS_VOICE="en-US-AriaNeural"
            WHISPER_LANGUAGE="en"
            ;;
        3)
            LANGUAGE="fr"
            TTS_VOICE="fr-FR-DeniseNeural"
            WHISPER_LANGUAGE="fr"
            ;;
        4)
            LANGUAGE="de"
            TTS_VOICE="de-DE-ConradNeural"
            WHISPER_LANGUAGE="de"
            ;;
        5)
            LANGUAGE="it"
            TTS_VOICE="it-IT-IsabellaNeural"
            WHISPER_LANGUAGE="it"
            ;;
        *)
            LANGUAGE="es"
            TTS_VOICE="es-AR-TomasNeural"
            WHISPER_LANGUAGE="es"
            ;;
    esac
    
    log_success "Language set to: $LANGUAGE"
    
    # Hardware configuration
    echo ""
    log_step "Hardware Configuration"
    GPU_RESPONSE=$(prompt_yes_no "Do you have GPU available (NVIDIA)?" "n")
    
    if [ "$GPU_RESPONSE" == "y" ]; then
        GPU_ENABLED=true
        WHISPER_IMAGE="onerahmet/openai-whisper-asr-webservice:latest-gpu"
        KOKORO_IMAGE="ghcr.io/remsky/kokoro-fastapi-gpu:latest"
        WHISPER_RUNTIME="nvidia"
        KOKORO_RUNTIME="nvidia"
        log_success "GPU acceleration enabled"
    else
        GPU_ENABLED=false
        WHISPER_IMAGE="onerahmet/openai-whisper-asr-webservice:latest"
        KOKORO_IMAGE="ghcr.io/remsky/kokoro-fastapi-cpu:latest"
        WHISPER_RUNTIME="runc"
        KOKORO_RUNTIME="runc"
        log_success "CPU mode enabled"
    fi
    
    # TTS Engine selection
    echo ""
    log_step "Text-to-Speech Engine"
    echo "Select TTS engine:"
    echo "  1) Edge TTS (free, default, no GPU needed) ⭐"
    echo "  2) Kokoro TTS (local, requires GPU)"
    
    read -p "Choose TTS engine [1-2]: " tts_choice
    
    case "$tts_choice" in
        2)
            TTS_ENGINE="kokoro"
            KOKORO_VOICE="em_alex"
            log_success "TTS engine: Kokoro (local)"
            ;;
        1|*)
            TTS_ENGINE="edge"
            KOKORO_VOICE="em_alex"
            log_success "TTS engine: Edge TTS"
            ;;
    esac
    
    # Generate auth token if not set
    echo ""
    log_step "Security"
    AUTH_TOKEN=$(generate_token)
    log_success "Generated authentication token: ${AUTH_TOKEN:0:16}..."
    
    echo ""
}

#########################################################################
# Connectivity Tests
#########################################################################

test_connectivity() {
    log_header "Testing Connectivity"
    
    log_step "Testing gateway URL: $GATEWAY_WS_URL"
    local gw_host_port="${GATEWAY_WS_URL#ws://}"
    gw_host_port="${gw_host_port#wss://}"
    gw_host_port="${gw_host_port%%/*}"
    local gw_host="${gw_host_port%%:*}"
    local gw_port="${gw_host_port##*:}"
    if timeout 3 bash -c "echo > /dev/tcp/$gw_host/$gw_port" 2>/dev/null; then
        log_success "Gateway is reachable at $gw_host:$gw_port"
    else
        log_warning "Could not reach gateway (may be fine if remote/firewalled)"
    fi
    
    echo ""
}

#########################################################################
# Generate .env File
#########################################################################

generate_env_file() {
    log_header "Generating Configuration File"
    
    cat > "$ENV_FILE" << EOF
# OpenClaw Companion Voice Server - Auto-generated Configuration
# Generated: $(date)

# ===== Gateway Connection =====
GATEWAY_WS_URL=$GATEWAY_WS_URL
GATEWAY_TOKEN=$GATEWAY_TOKEN

# ===== Authentication =====
AUTH_TOKEN=$AUTH_TOKEN

# ===== Speech-to-Text (Whisper) =====
WHISPER_URL=http://127.0.0.1:9000/asr?language=${WHISPER_LANGUAGE}&output=json
WHISPER_IMAGE=$WHISPER_IMAGE

# ===== Text-to-Speech Configuration =====
TTS_ENGINE=$TTS_ENGINE
TTS_VOICE=$TTS_VOICE
KOKORO_URL=http://127.0.0.1:5004
KOKORO_VOICE=$KOKORO_VOICE

# ===== Bot Configuration =====
BOT_NAME=$BOT_NAME
OWNER_NAME=$OWNER_NAME

# ===== Gateway Integration =====
GW_SESSION_KEY=voice
USE_GATEWAY_WS=true

# ===== Ports =====
PORT=3200
WHISPER_PORT=9000
EOF
    
    log_success "Configuration saved to: $ENV_FILE"
    echo ""
}

#########################################################################
# Docker Compose Operations
#########################################################################

start_services() {
    log_header "Starting Services"
    
    cd "$SCRIPT_DIR"
    
    log_step "Pulling latest images..."
    docker compose pull 2>&1 | grep -E "Pulling|Digest|Status" || true
    
    echo ""
    log_step "Starting containers (this may take a few minutes)..."
    docker compose up -d
    
    echo ""
    log_info "Waiting for services to be healthy..."
    
    # Wait for whisper
    local max_attempts=60
    local attempt=0
    
    while [ $attempt -lt $max_attempts ]; do
        if docker compose ps whisper 2>/dev/null | grep -q "healthy"; then
            log_success "Whisper (STT) is healthy"
            break
        fi
        
        if docker compose ps whisper 2>/dev/null | grep -q "Up"; then
            echo -ne "\r${LOADING} Waiting for Whisper to be ready... ($((attempt*5))s)"
            sleep 5
            ((attempt++))
        else
            log_error "Whisper container failed to start"
            docker compose logs whisper | tail -20
            exit 1
        fi
    done
    
    if [ $attempt -ge $max_attempts ]; then
        log_warning "Whisper health check timed out (may still be initializing)"
    fi
    
    echo ""
    
    # Wait for voice-server
    attempt=0
    while [ $attempt -lt 30 ]; do
        if docker compose ps voice-server 2>/dev/null | grep -q "healthy"; then
            log_success "Voice Server is healthy"
            break
        fi
        
        if docker compose ps voice-server 2>/dev/null | grep -q "Up"; then
            echo -ne "\r${LOADING} Waiting for Voice Server to be ready... ($((attempt*2))s)"
            sleep 2
            ((attempt++))
        else
            log_error "Voice Server container failed to start"
            docker compose logs voice-server | tail -20
            exit 1
        fi
    done
    
    echo ""
    log_success "Services started successfully"
    echo ""
}

#########################################################################
# Display Results
#########################################################################

show_connection_info() {
    log_header "Setup Complete! ${ROCKET}"
    
    local auth_token_display="${AUTH_TOKEN:0:16}...${AUTH_TOKEN: -8}"
    
    echo "Your Voice Server is ready to connect to OpenClaw Gateway"
    echo ""
    echo -e "${GREEN}Connection Information:${NC}"
    echo "  WebSocket URL:    ws://localhost:3200"
    echo "  WSS URL:          wss://localhost:3443 (if TLS configured)"
    echo "  Auth Token:       $auth_token_display"
    echo ""
    echo -e "${GREEN}Services:${NC}"
    echo "  Voice Server:     http://localhost:3200"
    echo "  Whisper (STT):    http://localhost:9000"
    echo "  Kokoro TTS:       http://localhost:5004"
    echo ""
    echo -e "${GREEN}Configuration:${NC}"
    echo "  Bot Name:         $BOT_NAME"
    echo "  Owner Name:       $OWNER_NAME"
    echo "  Language:         $LANGUAGE"
    echo "  TTS Engine:       $TTS_ENGINE"
    echo "  GPU Enabled:      $GPU_ENABLED"
    echo ""
    echo -e "${GREEN}Useful Commands:${NC}"
    echo "  docker compose logs -f              # View logs"
    echo "  docker compose ps                   # Check service status"
    echo "  docker compose restart              # Restart services"
    echo "  docker compose down                 # Stop all services"
    echo ""
    echo -e "${YELLOW}Next Steps:${NC}"
    echo "  1. Verify your gateway connection is working"
    echo "  2. Configure your OpenClaw client to connect to this server"
    echo "  3. Check logs if services fail to start"
    echo ""
}

#########################################################################
# Error Handling
#########################################################################

handle_error() {
    log_error "Setup failed"
    echo ""
    log_info "You can check the logs with:"
    echo "  docker compose logs -f"
    echo ""
    log_info "To retry setup, run: ./setup.sh"
    exit 1
}

trap handle_error ERR

#########################################################################
# Main Execution
#########################################################################

main() {
    clear
    echo -e "${CYAN}"
    cat << "EOF"
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║     OpenClaw Companion - Voice Server Setup                   ║
║                                                               ║
║     🎤 Complete voice assistance stack with                   ║
║        STT (Whisper), TTS (Edge/Kokoro), and                  ║
║        gateway integration                                    ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
EOF
    echo -e "${NC}"
    
    # Check if .env exists
    if [ -f "$ENV_FILE" ]; then
        log_info "Existing configuration found"
        reconfigure=$(prompt_yes_no "Reconfigure?" "n")
        if [ "$reconfigure" != "y" ]; then
            log_info "Using existing configuration"
            start_services
            show_connection_info
            exit 0
        fi
    fi
    
    # Run setup steps
    check_prerequisites
    interactive_config
    test_connectivity
    generate_env_file
    start_services
    show_connection_info
    
    log_success "Setup completed successfully!"
}

# Run main function
main "$@"
