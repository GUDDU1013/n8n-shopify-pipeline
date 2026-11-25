#!/bin/sh
set -e

export N8N_PORT="${PORT:-10000}"

if [ -n "$RENDER_EXTERNAL_URL" ]; then
  CLEAN_URL="${RENDER_EXTERNAL_URL%/}"
  export WEBHOOK_URL="${WEBHOOK_URL:-${CLEAN_URL}/}"
  export N8N_EDITOR_BASE_URL="${N8N_EDITOR_BASE_URL:-${CLEAN_URL}/}"
fi

if [ -n "$RENDER_EXTERNAL_HOSTNAME" ]; then
  export N8N_HOST="${N8N_HOST:-$RENDER_EXTERNAL_HOSTNAME}"
fi

mkdir -p /home/node/.n8n

if [ ! -f /home/node/.n8n/.imported ]; then
  echo "[Boot] Importing Project 03 workflow..."
  n8n import:workflow --input=/app/workflow.json || true
  echo "[Boot] Publishing Project 03 workflow..."
  n8n publish:workflow --id=67VqEYKQdxEn1RfQ || true
  touch /home/node/.n8n/.imported
fi

# Auto-setup owner account once server listens to protect n8n Editor while keeping public form active
node -e '
const http = require("http");
const port = process.env.N8N_PORT || "10000";
const email = process.env.N8N_OWNER_EMAIL;
const password = process.env.N8N_OWNER_PASSWORD;
if (!email || !password) process.exit(0);
const payload = JSON.stringify({ email, firstName: "Ridam", lastName: "Chakraborty", password });
const timer = setInterval(() => {
  const req = http.request("http://127.0.0.1:" + port + "/rest/owner/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
  }, res => {
    res.resume();
    if (res.statusCode === 200 || res.statusCode === 400 || res.statusCode === 403) {
      console.log("[Boot] Owner setup state:", res.statusCode);
      clearInterval(timer);
    }
  });
  req.on("error", () => {});
  req.write(payload);
  req.end();
}, 3000);
' &

exec n8n start
