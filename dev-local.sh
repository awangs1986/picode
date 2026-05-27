#!/usr/bin/env bash
set -e

PI_MONO_DIR="/Users/ShixinGuo/code/pi/pi-mono"
CODING_AGENT_DIR="$PI_MONO_DIR/packages/coding-agent"
CLI="$CODING_AGENT_DIR/dist/cli.js"

echo "Starting pi-mono watch mode in background..."
(cd "$CODING_AGENT_DIR" && npx tsgo -p tsconfig.build.json --watch --preserveWatchOutput) &
WATCH_PID=$!
trap "echo 'Stopping watch...'; kill $WATCH_PID 2>/dev/null" EXIT INT TERM

# Wait for initial build
echo "Waiting for initial build..."
for i in $(seq 1 30); do
  [ -f "$CLI" ] && break
  sleep 1
done

if [ ! -f "$CLI" ]; then
  echo "Error: $CLI not found after waiting. Check pi-mono build."
  exit 1
fi

# Give tsc a bit more time to finish the first full compile
sleep 3

echo ""
echo "Starting pi with local pi-mono code..."
echo "  CLI:     $CLI"
echo "  Static:  $(pwd)/public"
echo ""

PI_STUDIO_STATIC_DIR=$(pwd)/public node "$CLI"
