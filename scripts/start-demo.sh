#!/usr/bin/env bash

set -Eeuo pipefail

MODE="${1:-demo}"
PORT="${PORT:-5173}"
SKIP_INSTALL="${SKIP_INSTALL:-0}"

case "$MODE" in
  demo|mock|dev)
    ;;
  *)
    echo "Usage: bash scripts/start-demo.sh [demo|mock|dev]"
    echo "Optional environment variables: PORT=5173 SKIP_INSTALL=1"
    exit 2
    ;;
esac

if ! [[ "$PORT" =~ ^[0-9]+$ ]] || (( PORT < 1 || PORT > 65535 )); then
  echo "PORT must be an integer between 1 and 65535."
  exit 2
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found. Install Node.js 20 LTS or newer."
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm was not found. Install npm with Node.js."
  exit 1
fi

NODE_VERSION="$(node --version)"
NODE_MAJOR="$(node -p "Number(process.versions.node.split('.')[0])")"
if (( NODE_MAJOR < 20 )); then
  echo "OneLive requires Node.js 20 or newer. Current version: $NODE_VERSION"
  exit 1
fi

echo
echo "OneLive launcher"
echo "Project : $PROJECT_ROOT"
echo "Mode    : $MODE"
echo "Node    : $NODE_VERSION"
echo "Port    : $PORT"

if [[ ! -d node_modules ]]; then
  if [[ "$SKIP_INSTALL" == "1" ]]; then
    echo "Warning: node_modules is missing and SKIP_INSTALL=1 was used."
  else
    echo
    echo "Installing dependencies..."
    npm install
  fi
else
  echo "Dependencies found. Run npm install manually after package changes."
fi

LAN_ADDRESS=""
case "$(uname -s)" in
  Darwin)
    LAN_ADDRESS="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
    ;;
  Linux)
    if command -v hostname >/dev/null 2>&1; then
      LAN_ADDRESS="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
    fi
    ;;
esac

export PORT

case "$MODE" in
  demo)
    export DEMO_HTTPS=true
    export DEMO_MOCK=false
    NPM_SCRIPT="demo"
    SCHEME="https"
    ;;
  mock)
    export DEMO_HTTPS=false
    export DEMO_MOCK=true
    NPM_SCRIPT="demo:mock"
    SCHEME="http"
    ;;
  dev)
    export DEMO_HTTPS=false
    export DEMO_MOCK=false
    NPM_SCRIPT="dev"
    SCHEME="http"
    ;;
esac

echo
echo "Expected local URL: ${SCHEME}://localhost:${PORT}"
if [[ -n "$LAN_ADDRESS" ]]; then
  echo "Expected LAN URL  : ${SCHEME}://${LAN_ADDRESS}:${PORT}"
else
  echo "LAN address was not detected; use the URL printed by the OneLive server."
fi

if [[ "$MODE" == "demo" ]]; then
  echo
  echo "Phone note:"
  echo "  Open the LAN HTTPS URL once and accept the local certificate."
  echo "  Then scan the session QR code shown in the control room."
  echo "  If the phone or certificate fails, switch to Local Camera or Mock Source."
elif [[ "$MODE" == "mock" ]]; then
  echo
  echo "Mock mode needs no phone, API key, or external network."
fi

echo
echo "Starting npm run ${NPM_SCRIPT} ..."
exec npm run "$NPM_SCRIPT"
