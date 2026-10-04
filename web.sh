#!/usr/bin/env bash
# Start Ollama (with the model) and the TypeScript harness. Ctrl+C stops the host.
# Usage: ./web.sh

cd "$(dirname "$0")" || exit 1

./ollama.sh start > /dev/null || { echo "Could not start Ollama."; exit 1; }
echo "Ollama is up with the model loaded."

echo
echo "  Open the web harness at:  http://localhost:5000"
echo "  Stop it with Ctrl+C (Ollama keeps running; stop it with ./ollama.sh stop)"
echo

export MYHARNESS_PORT="${MYHARNESS_PORT:-5000}"
npm run start:ts
