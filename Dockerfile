FROM ghcr.io/n8n-io/n8n:2.35.7

USER root
RUN mkdir -p /app /home/node/.n8n && chmod -R 777 /app /home/node/.n8n

COPY workflow.json /app/workflow.json
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh && chmod 644 /app/workflow.json

ENV HOME=/home/node \
    N8N_USER_FOLDER=/home/node/.n8n \
    N8N_LISTEN_ADDRESS=0.0.0.0 \
    N8N_PROTOCOL=https \
    N8N_PROXY_HOPS=1 \
    N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS=false \
    N8N_DIAGNOSTICS_ENABLED=false \
    N8N_VERSION_NOTIFICATIONS_ENABLED=false \
    N8N_BLOCK_ENV_ACCESS_IN_NODE=false \
    N8N_PYTHON_ENABLED=false \
    N8N_RUNNERS_MAX_OLD_SPACE_SIZE=128 \
    NODES_INCLUDE='["n8n-nodes-base.formTrigger","n8n-nodes-base.form","n8n-nodes-base.code","n8n-nodes-base.httpRequest","n8n-nodes-base.scheduleTrigger","n8n-nodes-base.slack","n8n-nodes-base.googleSheets","n8n-nodes-base.set","n8n-nodes-base.if"]' \
    DB_SQLITE_POOL_SIZE=1 \
    EXECUTIONS_DATA_PRUNE=true \
    EXECUTIONS_DATA_MAX_AGE=24 \
    NODE_OPTIONS=--max-old-space-size=320

USER node

# Pre-migrate SQLite, import & publish workflow at Docker build time for instant runtime boot!
RUN n8n import:workflow --input=/app/workflow.json && \
    n8n publish:workflow --id=67VqEYKQdxEn1RfQ && \
    rm -f /home/node/.n8n/.n8n/config

EXPOSE 10000

ENTRYPOINT ["/bin/sh", "/app/entrypoint.sh"]
