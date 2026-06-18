#!/usr/bin/env bash
set -euo pipefail

# Testnet smoke test for @human.tech/plugin-waap
# Prerequisites:
#   - ElizaOS CLI installed (npm i -g @elizaos/cli)
#   - OPENAI_API_KEY set in environment
#
# Usage:
#   bash test/integration/smoke-test.sh

echo "=== WaaP Plugin Smoke Test ==="
echo ""

# 1. Check prerequisites
command -v elizaos >/dev/null 2>&1 || { echo "ERROR: elizaos CLI not found. Install with: npm i -g @elizaos/cli"; exit 1; }

if [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "ERROR: OPENAI_API_KEY not set"
  exit 1
fi

echo "Prerequisites OK"
echo ""

# 2. Create temp directory
SMOKE_DIR=$(mktemp -d)
trap "rm -rf $SMOKE_DIR" EXIT
cd "$SMOKE_DIR"

echo "Working in: $SMOKE_DIR"

# 3. Create character file
cat > character.json << 'CHAR'
{
  "name": "waap-smoke-test",
  "plugins": [
    "@elizaos/plugin-sql",
    "@elizaos/plugin-openai",
    "@elizaos/plugin-bootstrap",
    "@human.tech/plugin-waap"
  ],
  "settings": {},
  "bio": ["Smoke test agent"],
  "system": "You are a test agent with a WaaP wallet. Respond concisely."
}
CHAR

echo "Character file created"
echo ""

# 4. Start ElizaOS in background
echo "Starting ElizaOS..."
elizaos start --character ./character.json &
ELIZA_PID=$!
sleep 10  # Wait for startup

# Check if it started
if ! kill -0 $ELIZA_PID 2>/dev/null; then
  echo "ERROR: ElizaOS failed to start"
  exit 1
fi

echo "ElizaOS running (PID: $ELIZA_PID)"
echo ""

# 5. Health check
HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/healthz)
if [ "$HTTP_STATUS" != "200" ]; then
  echo "ERROR: Health check failed (HTTP $HTTP_STATUS)"
  kill $ELIZA_PID 2>/dev/null
  exit 1
fi
echo "Health check: OK"

# 6. List agents
AGENTS=$(curl -s http://localhost:3000/api/agents)
echo "Agents: $AGENTS"
echo ""

echo "=== Smoke test complete ==="
echo ""
echo "To test interactively:"
echo "  1. Open http://localhost:3000 in your browser"
echo "  2. Chat with the waap-smoke-test agent"
echo "  3. Try: 'create a wallet', 'what is my balance?', 'switch to sepolia'"
echo ""
echo "Press Ctrl+C to stop"

# Wait for manual testing
wait $ELIZA_PID
