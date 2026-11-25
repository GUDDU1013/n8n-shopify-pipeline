# Automated Supplier-to-Shopify AI Pipeline (n8n on Render Free)

Self-hosted n8n workflow featuring:
- Live Prospect Web Form (`/form/supplier-demo-form`) supporting Single SKU or Google Sheet Batch ingestion
- Multimodal Gemini Vision AI enrichment + SEO/GEO copywriting
- Deterministic 2.4x wholesale markup + .99 psychological rounding
- 20MP+ Shopify image safety downscaling
- Direct Shopify GraphQL Draft creation via OAuth Client Credentials
- Consolidated Browser HTML Report + Slack/Email alert readiness

## Deploy on Render.com (Free Tier)
1. Connect this private GitHub repository on Render (`New -> Web Service` or `New -> Blueprint`).
2. Add Environment Variables (`GEMINI_API_KEY`, `SHOPIFY_SHOP`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `N8N_OWNER_EMAIL`, `N8N_OWNER_PASSWORD`).
3. Once live, open `https://<your-service>.onrender.com/form/supplier-demo-form`.
