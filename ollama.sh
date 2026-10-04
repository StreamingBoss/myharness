#!/usr/bin/env bash
# Start/stop the Windows Ollama server from WSL2 and load/unload the model.
# Usage: ./ollama.sh start|stop|status

MODEL="qwen2.5:7b"
URL="http://localhost:11434"
OLLAMA_DIR='C:\Users\emman\AppData\Local\Programs\Ollama'

is_up() { curl -s -m 2 "$URL/api/version" > /dev/null; }

case "$1" in
  start)
    if ! is_up; then
      echo "Starting Ollama..."
      powershell.exe -Command "Start-Process '$OLLAMA_DIR\ollama app.exe'"
      for _ in $(seq 30); do is_up && break; sleep 1; done
      is_up || { echo "Ollama did not come up on $URL"; exit 1; }
    fi
    echo "Ollama is up. Loading $MODEL into memory..."
    # an empty prompt only loads the model; keep_alive -1 keeps it loaded until stop
    curl -s "$URL/api/generate" -d "{\"model\": \"$MODEL\", \"keep_alive\": -1}" > /dev/null
    curl -s "$URL/api/ps"; echo
    ;;
  stop)
    if is_up; then
      echo "Unloading $MODEL..."
      curl -s "$URL/api/generate" -d "{\"model\": \"$MODEL\", \"keep_alive\": 0}" > /dev/null
    fi
    echo "Stopping Ollama..."
    # the tray app respawns the server, so both processes must go
    powershell.exe -Command "Stop-Process -Name 'ollama app' -Force -ErrorAction SilentlyContinue; Stop-Process -Name 'ollama' -Force -ErrorAction SilentlyContinue"
    sleep 1
    is_up && echo "Ollama still responding!" || echo "Ollama stopped."
    ;;
  status)
    if is_up; then
      echo "Ollama is up. Loaded models:"
      curl -s "$URL/api/ps"; echo
    else
      echo "Ollama is down."
    fi
    ;;
  *)
    echo "Usage: $0 start|stop|status"
    exit 1
    ;;
esac
