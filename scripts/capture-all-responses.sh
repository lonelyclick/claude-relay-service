#!/bin/bash
set -e

VERSIONS="2.1.90 2.1.91 2.1.92 2.1.94 2.1.96 2.1.97 2.1.98"
CAPTURE_PORT=9998

rm -rf scripts/captured-responses

node scripts/capture-response.mjs &
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
  echo "Capturing response for v${VERSION}"
  echo "========================================="

  sudo npm install -g @anthropic-ai/claude-code@${VERSION} 2>&1 | tail -1
  INSTALLED=$(claude --version 2>/dev/null | head -1)
  echo "Installed: ${INSTALLED}"

  ANTHROPIC_BASE_URL=http://127.0.0.1:${CAPTURE_PORT} claude -p "say ok" --max-turns 1 2>/dev/null || echo "(may have errored)"

  echo "Done with v${VERSION}"
done

echo ""
echo "========================================="
echo "All response captures complete"
echo "========================================="
ls -la scripts/captured-responses/*.txt 2>/dev/null || echo "No response files found"
