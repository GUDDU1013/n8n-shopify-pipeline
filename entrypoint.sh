#!/bin/sh
set -e

export PORT="${PORT:-10000}"
export N8N_PORT="5678"
export N8N_LISTEN_ADDRESS="127.0.0.1"

if [ -n "$RENDER_EXTERNAL_URL" ]; then
  CLEAN_URL="${RENDER_EXTERNAL_URL%/}"
  export N8N_WEBHOOK_URL="${N8N_WEBHOOK_URL:-${CLEAN_URL}/}"
  export N8N_EDITOR_BASE_URL="${N8N_EDITOR_BASE_URL:-${CLEAN_URL}/}"
fi

if [ -n "$RENDER_EXTERNAL_HOSTNAME" ]; then
  export N8N_HOST="${N8N_HOST:-$RENDER_EXTERNAL_HOSTNAME}"
fi

# Safety fallback if database missing
if [ ! -f /app/n8n-data/.n8n/database.sqlite ]; then
  echo "[Boot] Importing Project 03 workflow..."
  n8n import:workflow --input=/app/workflow.json || true
  n8n publish:workflow --id=67VqEYKQdxEn1RfQ || true
fi

# Lightweight gatekeeper proxy on $PORT -> 127.0.0.1:5678
NODE_OPTIONS=--max-old-space-size=96 node /app/proxy.js &

# Single non-overlapping owner setup after n8n internal healthz responds 200
node -e '
const http = require("http");
const email = process.env.N8N_OWNER_EMAIL;
const password = process.env.N8N_OWNER_PASSWORD;
if (!email || !password) process.exit(0);
const payload = JSON.stringify({ email, firstName: "Ridam", lastName: "Chakraborty", password });
let busy = false;
const timer = setInterval(() => {
  if (busy) return;
  busy = true;
  http.get("http://127.0.0.1:5678/healthz", { timeout: 3000 }, (hr) => {
    hr.resume();
    if (hr.statusCode !== 200) { busy = false; return; }
    const req = http.request("http://127.0.0.1:5678/rest/owner/setup", {
      method: "POST",
      timeout: 30000,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
    }, (res) => {
      res.resume();
      busy = false;
      if (res.statusCode === 200 || res.statusCode === 400 || res.statusCode === 403) {
        console.log("[Boot] Owner setup state:", res.statusCode);
        clearInterval(timer);
      }
    });
    req.on("error", () => { busy = false; });
    req.on("timeout", () => { req.destroy(); busy = false; });
    req.write(payload);
    req.end();
  }).on("error", () => { busy = false; });
}, 10000);
' &

exec n8n start
