#!/bin/bash
set -e

VERSIONS="2.1.90 2.1.91 2.1.92 2.1.93 2.1.94 2.1.95 2.1.96 2.1.97 2.1.98"
CAPTURE_PORT=9999
OUTPUT_DIR="scripts/captured-bodies"

rm -rf "$OUTPUT_DIR"

# Start capture proxy in background
node scripts/capture-body.mjs &
CAPTURE_PID=$!
sleep 1

cleanup() {
  kill $CAPTURE_PID 2>/dev/null || true
  echo "Restoring claude@2.1.98..."
  sudo npm install -g @anthropic-ai/claude-code@2.1.98 2>/dev/null
}
trap cleanup EXIT

for VERSION in $VERSIONS; do
  echo ""
  echo "========================================="
  echo "Capturing v${VERSION}"
  echo "========================================="

  sudo npm install -g @anthropic-ai/claude-code@${VERSION} 2>&1 | tail -1

  INSTALLED=$(claude --version 2>/dev/null | head -1)
  echo "Installed: ${INSTALLED}"

  ANTHROPIC_BASE_URL=http://127.0.0.1:${CAPTURE_PORT} claude -p "say ok" --max-turns 1 2>/dev/null || echo "(request may have errored, body still captured)"

  echo "Done with v${VERSION}"
done

echo ""
echo "========================================="
echo "All captures complete"
echo "========================================="
ls -la "$OUTPUT_DIR"/*.json | grep -v headers
