FROM ghcr.io/n8n-io/n8n:2.35.7

USER root
COPY --from=mwader/static-ffmpeg:7.1 /ffmpeg /usr/local/bin/ffmpeg
RUN chmod 755 /usr/local/bin/ffmpeg && ffmpeg -version | head -n 1 && mkdir -p /app/n8n-data /home/node/.n8n && chmod -R 777 /app /home/node/.n8n

COPY workflow.json /app/workflow.json
COPY entrypoint.sh /app/entrypoint.sh
COPY proxy.js /app/proxy.js
COPY engine.js /app/engine.js
COPY ui.html /app/ui.html
RUN chmod +x /app/entrypoint.sh && chmod 644 /app/workflow.json /app/proxy.js /app/engine.js /app/ui.html

ENV HOME=/home/node \
    N8N_USER_FOLDER=/app/n8n-data \
    N8N_LISTEN_ADDRESS=0.0.0.0 \
    N8N_PROTOCOL=https \
    N8N_PROXY_HOPS=2 \
    N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS=false \
    N8N_DIAGNOSTICS_ENABLED=false \
    N8N_VERSION_NOTIFICATIONS_ENABLED=false \
    N8N_BLOCK_ENV_ACCESS_IN_NODE=false \
    N8N_PYTHON_ENABLED=false \
    N8N_RUNNERS_MAX_OLD_SPACE_SIZE=80 \
    N8N_RUNNERS_GRANT_TOKEN_TTL=180 \
    NODES_INCLUDE='["n8n-nodes-base.formTrigger","n8n-nodes-base.form","n8n-nodes-base.code","n8n-nodes-base.httpRequest","n8n-nodes-base.scheduleTrigger","n8n-nodes-base.slack","n8n-nodes-base.googleSheets","n8n-nodes-base.set","n8n-nodes-base.if"]' \
    DB_SQLITE_POOL_SIZE=1 \
    EXECUTIONS_DATA_PRUNE=true \
    EXECUTIONS_DATA_MAX_AGE=24 \
    NODE_OPTIONS=--max-old-space-size=224

USER node

# Pre-migrate SQLite, import & publish workflow into non-VOLUME /app/n8n-data during build!
RUN n8n import:workflow --input=/app/workflow.json && \
    n8n publish:workflow --id=67VqEYKQdxEn1RfQ && \
    rm -f /app/n8n-data/.n8n/config && \
    ls -la /app/n8n-data/.n8n

EXPOSE 10000

ENTRYPOINT ["/bin/sh", "/app/entrypoint.sh"]
