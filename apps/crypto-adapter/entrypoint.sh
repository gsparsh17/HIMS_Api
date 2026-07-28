#!/bin/sh
set -eu
java -Dserver.port=8091 -jar /app/fidelius-engine.jar >/tmp/fidelius-engine.log 2>&1 &
ENGINE_PID=$!
trap 'kill ${ENGINE_PID} 2>/dev/null || true' INT TERM EXIT
for i in $(seq 1 30); do
  if wget -q -O- http://127.0.0.1:8091/health >/dev/null 2>&1; then
    exec node /app/facade/server.js
  fi
  sleep 1
done
echo "Fidelius engine failed to become healthy" >&2
exit 1
