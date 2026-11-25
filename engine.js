const https = require("https");
const http = require("http");
const crypto = require("crypto");

const FALLBACK_CATALOG = {
  BAG001: { title: "Village Cricket Co Professional Grade English Willow Bat", category: "Cricket Equipment", material: "English Willow", color: "Natural Wood / Green" },
  BAG002: { title: "Match-Regulation Four-Piece Red Leather Cricket Ball", category: "Cricket Balls", material: "Alum-Tanned Leather", color: "Classic Red" },
  BAG003: { title: "Tournament Standard Heavy Wooden Cricket Stumps & Wickets Set", category: "Cricket Accessories", material: "Hardwood", color: "Natural Timber" },
  BAT001: { title: "Village Cricket Co Professional Grade English Willow Bat", category: "Cricket Equipment", material: "English Willow", color: "Natural Wood / Green" },
  BAT002: { title: "Match-Regulation Four-Piece Red Leather Cricket Ball", category: "Cricket Balls", material: "Alum-Tanned Leather", color: "Classic Red" },
  BAT003: { title: "Tournament Standard Heavy Wooden Cricket Stumps & Wickets Set", category: "Cricket Accessories", material: "Hardwood", color: "Natural Timber" },
};

const jobs = new Map();
const JOB_TTL_MS = 30 * 60 * 1000;

function cleanupOldJobs() {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id);
  }
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function clampImageUrls(rawUrl) {
  const url = String(rawUrl || "").trim();
  let safeImageUrl = url;
  let aiImageUrl = url;
  if (url.includes("unsplash.com")) {
    const clean = url.split("?")[0];
    safeImageUrl = `${clean}?w=2048&fit=max&q=85&auto=format`;
    aiImageUrl = `${clean}?w=400&fit=max&q=70&auto=format`;
  } else if (url.includes("cloudinary.com") && url.includes("/upload/")) {
    safeImageUrl = url.replace("/upload/", "/upload/c_limit,w_2048,h_2048,q_auto/");
    aiImageUrl = url.replace("/upload/", "/upload/c_limit,w_400,h_400,q_auto/");
  } else if (url.includes("imgix.net")) {
    const sep = url.includes("?") ? "&" : "?";
    safeImageUrl = `${url}${sep}w=2048&fit=max&q=85`;
    aiImageUrl = `${url}${sep}w=400&fit=max&q=70`;
  }
  return { safeImageUrl, aiImageUrl };
}

function computePricing(row) {
  const wholesale = parseFloat(row.wholesale_cost) || 15.0;
  const retailPrice = (Math.floor(wholesale * 2.4) + 0.99).toFixed(2);
  const compareAtPrice = (Math.floor(wholesale * 3.5) + 0.99).toFixed(2);
  const profit = (parseFloat(retailPrice) - wholesale).toFixed(2);
  const margin = (((parseFloat(retailPrice) - wholesale) / parseFloat(retailPrice)) * 100).toFixed(1) + "%";
  const { safeImageUrl, aiImageUrl } = clampImageUrls(row.image_url);
  return {
    ...row,
    wholesale_cost: wholesale,
    retail_price: retailPrice,
    compare_at_price: compareAtPrice,
    profit_per_unit: profit,
    gross_margin: margin,
    safe_image_url: safeImageUrl,
    ai_image_url: aiImageUrl,
  };
}

function requestUrl(targetUrl, opts = {}, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const mod = parsed.protocol === "http:" ? http : https;
    const req = mod.request(
      parsed,
      {
        method: opts.method || "GET",
        headers: opts.headers || {},
        timeout: opts.timeout || 25000,
      },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirectCount < 5) {
          res.resume();
          const nextUrl = new URL(res.headers.location, parsed).toString();
          return resolve(requestUrl(nextUrl, { ...opts, method: res.statusCode === 303 ? "GET" : opts.method }, redirectCount + 1));
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          resolve({ status: res.statusCode, headers: res.headers, buffer: buf, text: buf.toString("utf8") });
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`Timeout calling ${parsed.hostname}`)));
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function fetchJson(url, opts = {}) {
  const res = await requestUrl(url, opts);
  let data = null;
  try {
    data = JSON.parse(res.text);
  } catch {
    data = { raw: res.text };
  }
  if (res.status >= 400) {
    throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}: ${res.text.slice(0, 220)}`);
  }
  return data;
}

async function ingestRows(payload) {
  const sheetUrl = String(payload.sheetUrl || payload["Google Sheet URL (Optional)"] || "").trim();
  const notifyTarget = String(payload.notifyTarget || payload["Notification Email or Slack Webhook (Optional)"] || "").trim();

  if (sheetUrl && sheetUrl.includes("docs.google.com/spreadsheets")) {
    const sheetIdMatch = sheetUrl.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    const gidMatch = sheetUrl.match(/[#&?]gid=([0-9]+)/);
    if (sheetIdMatch) {
      const sheetId = sheetIdMatch[1];
      const gid = gidMatch ? gidMatch[1] : "0";
      const exportUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`;
      const res = await requestUrl(exportUrl, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 15000 });
      if (res.status >= 400) {
        throw new Error(`Could not read Google Sheet (HTTP ${res.status}). Make sure sharing is set to "Anyone with link".`);
      }
      const lines = res.text.split(/\r?\n/).filter((l) => l.trim().length > 0);
      if (lines.length > 1) {
        const rows = [];
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map((c) => c.replace(/^"|"$/g, "").trim());
          if (cols.length >= 3 && (cols[0] || cols[1])) {
            rows.push(
              computePricing({
                sku: cols[0] || `SKU-ROW-${i}`,
                raw_name: cols[1] || `Product ${i}`,
                wholesale_cost: parseFloat(cols[2]) || 15.0,
                image_url: (cols[3] || "").trim(),
                source: "google_sheet",
                sheet_url: sheetUrl,
                sheet_row_index: i + 1,
                notify_target: notifyTarget,
              })
            );
          }
        }
        if (rows.length > 0) return { rows, notifyTarget };
      }
    }
    throw new Error("Google Sheet appears empty or invalid. Expected columns: SKU, Name, Cost, Image URL.");
  }

  return {
    notifyTarget,
    rows: [
      computePricing({
        sku: String(payload.sku || payload["Supplier SKU"] || "BAG-DEMO-01").trim() || "BAG-DEMO-01",
        raw_name: String(payload.rawName || payload["Raw Item Name"] || "Vintage Leather Travel Duffel Bag").trim() || "Vintage Leather Travel Duffel Bag",
        wholesale_cost: parseFloat(payload.wholesaleCost || payload["Wholesale Cost ($)"] || 35.0) || 35.0,
        image_url: String(payload.imageUrl || payload["Raw Product Image URL"] || "https://images.unsplash.com/photo-1553062407-98eeb64c6a62").trim(),
        source: "manual_demo",
        notify_target: notifyTarget,
      }),
    ],
  };
}

async function fetchImageBase64(imageUrl) {
  if (!imageUrl) return "";
  try {
    const res = await requestUrl(imageUrl, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 10000 });
    if (res.status < 400 && res.buffer && res.buffer.length > 50) {
      return res.buffer.toString("base64");
    }
  } catch (err) {
    console.warn("[Engine] Thumbnail download skipped:", err.message);
  }
  return "";
}

async function runGeminiVision(pricing, base64Image) {
  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) return {};
  const itemHint = pricing.raw_name && !pricing.raw_name.toLowerCase().includes("raw item") ? pricing.raw_name : "Supplier Product";
  const promptText = `You are an elite E-Commerce Merchandiser and Vision AI specialist. Examine the provided product photo closely:
- SKU: ${pricing.sku}
- Wholesale Cost: $${pricing.wholesale_cost}
- Supplier Hint: ${itemHint}

Visually examine what is shown in the photo (e.g. cricket ball, sports equipment, leather bag, gear, etc.).
Generate a top-tier retail listing matching the visual item.
Return ONLY a valid JSON object (no markdown, no backticks) with these exact keys:
{
  "persuasive_title": "string (brand-voice consumer product title, 4-8 words describing what is visually in the image)",
  "html_description": "HTML string with compelling intro paragraph, <h3>Product Highlights</h3> with exactly 5 <li> benefit bullet points, and a specifications section",
  "category": "string",
  "material": "string",
  "primary_color": "string",
  "seo_meta_title": "string (under 60 chars)",
  "seo_meta_description": "string (under 155 chars)",
  "image_alt_text": "string (WCAG compliant descriptive alt text)",
  "tags": "comma separated tags including category, material, color, AI Enriched"
}`;

  const parts = [{ text: promptText }];
  if (base64Image && base64Image.length > 100) {
    parts.push({ inline_data: { mime_type: "image/jpeg", data: base64Image } });
  }

  try {
    const data = await fetchJson(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts }], generationConfig: { response_mime_type: "application/json" } }),
        timeout: 25000,
      }
    );
    const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    if (rawText) {
      return JSON.parse(rawText.replace(/```json/g, "").replace(/```/g, "").trim());
    }
  } catch (err) {
    console.warn(`[Engine] Gemini fallback for ${pricing.sku}:`, err.message);
  }
  return {};
}

function buildShopifyPayload(pricing, ai) {
  const catalogItem = FALLBACK_CATALOG[pricing.sku] || {
    title: pricing.raw_name && !pricing.raw_name.toLowerCase().includes("supplier item") ? pricing.raw_name : `Elite Heritage Sporting Gear - ${pricing.sku}`,
    category: "Sports & Athletics",
    material: "Premium Grade",
    color: "Standard",
  };

  const productTitle = ai.persuasive_title || catalogItem.title;
  const material = ai.material || catalogItem.material;
  const primaryColor = ai.primary_color || catalogItem.color;
  const category = ai.category || catalogItem.category;
  const defaultDesc = `<p>Experience premium match-grade performance with the <strong>${escapeHtml(productTitle)}</strong>. Built to official competition standards, this equipment combines superior balance, durable craftsmanship, and authentic engineering.</p><h3>Product Highlights</h3><ul><li><strong>Competition Grade:</strong> Manufactured to meet rigorous regulation standards.</li><li><strong>Premium Longevity:</strong> Built from hand-selected ${escapeHtml(material)} for enduring use.</li><li><strong>Optimized Ergonomics:</strong> Balanced weight distribution for effortless control.</li><li><strong>Distinctive Finish:</strong> Elegant ${escapeHtml(primaryColor)} styling with reinforced craftsmanship.</li><li><strong>Quality Certified:</strong> Tested for resilience and retail readiness.</li></ul><h3>Specifications</h3><ul><li><strong>SKU:</strong> ${escapeHtml(pricing.sku)}</li><li><strong>Category:</strong> ${escapeHtml(category)}</li><li><strong>Material:</strong> ${escapeHtml(material)}</li><li><strong>Primary Color:</strong> ${escapeHtml(primaryColor)}</li></ul>`;

  const tagsList = (ai.tags || `${category}, ${material}, ${primaryColor}, AI Enriched`)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  tagsList.push(`Wholesale_$${pricing.wholesale_cost}`, `Margin_${pricing.gross_margin}`, "n8n-automated");
  if (!tagsList.includes(material)) tagsList.push(material);
  if (!tagsList.includes(primaryColor)) tagsList.push(primaryColor);
  if (!tagsList.includes(category)) tagsList.push(category);

  return {
    title: productTitle,
    descriptionHtml: ai.html_description || defaultDesc,
    tags: tagsList,
    price: pricing.retail_price,
    compareAtPrice: pricing.compare_at_price,
    sku: pricing.sku,
    imageUrl: pricing.safe_image_url || pricing.image_url,
    alt_text: ai.image_alt_text || productTitle,
    seo_title: (ai.seo_meta_title || `${productTitle} | SKU ${pricing.sku}`).slice(0, 70),
    seo_description: (ai.seo_meta_description || `Buy ${productTitle}. Premium ${material} product with AI-enriched merchandising.`).slice(0, 160),
    material,
    primaryColor,
    category,
  };
}

async function getShopifyToken() {
  const shop = (process.env.SHOPIFY_SHOP || "all-hydro-test.myshopify.com").trim();
  const clientId = (process.env.SHOPIFY_CLIENT_ID || "").trim();
  const clientSecret = (process.env.SHOPIFY_CLIENT_SECRET || "").trim();
  const tokenRes = await fetchJson(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&grant_type=client_credentials`,
    timeout: 15000,
  });
  if (!tokenRes?.access_token) {
    throw new Error("Failed to obtain Shopify access token");
  }
  return { shop, accessToken: tokenRes.access_token };
}

async function createShopifyDraft(shopCreds, data) {
  const { shop, accessToken } = shopCreds;
  const endpoint = `https://${shop}/admin/api/2024-07/graphql.json`;
  const headers = { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken };

  const createMutation = `
    mutation productCreate($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
      productCreate(product: $product, media: $media) {
        product {
          id
          title
          handle
          status
          variants(first: 1) { edges { node { id } } }
        }
        userErrors { field message }
      }
    }
  `;

  const createVariables = {
    product: {
      title: data.title,
      descriptionHtml: data.descriptionHtml,
      status: "DRAFT",
      tags: data.tags,
      seo: { title: data.seo_title, description: data.seo_description },
    },
    media: data.imageUrl ? [{ originalSource: data.imageUrl, alt: data.alt_text, mediaContentType: "IMAGE" }] : [],
  };

  let createRes = await fetchJson(endpoint, { method: "POST", headers, body: JSON.stringify({ query: createMutation, variables: createVariables }) });
  let productResult = createRes?.data?.productCreate;

  if (productResult?.userErrors?.some((e) => e.field?.includes("handle"))) {
    createVariables.product.handle = `${data.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 45)}-${Date.now()}`;
    createRes = await fetchJson(endpoint, { method: "POST", headers, body: JSON.stringify({ query: createMutation, variables: createVariables }) });
    productResult = createRes?.data?.productCreate;
  }

  if (productResult?.userErrors?.length > 0) {
    throw new Error(`Shopify error for ${data.sku}: ${JSON.stringify(productResult.userErrors)}`);
  }

  const created = productResult?.product;
  const variantId = created?.variants?.edges?.[0]?.node?.id;

  if (variantId && (data.price || data.sku)) {
    const bulkMutation = `
      mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id price compareAtPrice sku }
          userErrors { field message }
        }
      }
    `;
    const bulkVariables = {
      productId: created.id,
      variants: [
        {
          id: variantId,
          price: String(data.price || "28.99"),
          compareAtPrice: data.compareAtPrice ? String(data.compareAtPrice) : undefined,
          ...(data.sku ? { inventoryItem: { sku: data.sku } } : {}),
        },
      ],
    };
    await fetchJson(endpoint, { method: "POST", headers, body: JSON.stringify({ query: bulkMutation, variables: bulkVariables }) });
  }

  const numericId = created.id.split("/").pop();
  const storeSlug = shop.replace(".myshopify.com", "");
  return {
    id: created.id,
    numericId,
    title: created.title,
    status: created.status,
    admin_review_url: `https://admin.shopify.com/store/${storeSlug}/products/${numericId}`,
  };
}

function buildEmailHtmlReport(items, alertStatus) {
  const count = items.length;
  let totalRetail = 0;
  let totalProfit = 0;

  const rowsHtml = items
    .map((item) => {
      const wholesale = parseFloat(String(item.wholesale_cost || "0").replace(/[^0-9.]/g, "")) || 0;
      const retail = parseFloat(String(item.retail_price || "0").replace(/[^0-9.]/g, "")) || 0;
      const profit = parseFloat(String(item.profit_per_unit || "0").replace(/[^0-9.]/g, "")) || 0;
      totalRetail += retail;
      totalProfit += profit;

      return `
      <tr>
        <td style="padding:12px 10px;border-bottom:1px solid #e5e7eb;font-weight:600;color:#111827;">${escapeHtml(item.sku)}</td>
        <td style="padding:12px 10px;border-bottom:1px solid #e5e7eb;color:#1f2937;">
          <div style="font-weight:600;">${escapeHtml(item.product_title)}</div>
          <div style="font-size:12px;color:#6b7280;margin-top:2px;">${escapeHtml(item.category || "Catalog")} • ${escapeHtml(item.material || "Standard")} • ${escapeHtml(item.primary_color || "")}</div>
        </td>
        <td style="padding:12px 10px;border-bottom:1px solid #e5e7eb;color:#4b5563;">$${wholesale.toFixed(2)}</td>
        <td style="padding:12px 10px;border-bottom:1px solid #e5e7eb;font-weight:700;color:#059669;">$${retail.toFixed(2)}</td>
        <td style="padding:12px 10px;border-bottom:1px solid #e5e7eb;color:#047857;">+${escapeHtml(item.gross_margin)} ($${profit.toFixed(2)})</td>
        <td style="padding:12px 10px;border-bottom:1px solid #e5e7eb;"><span style="display:inline-block;padding:3px 8px;border-radius:9999px;background:#d1fae5;color:#065f46;font-size:12px;font-weight:600;">Draft Created</span></td>
        <td style="padding:12px 10px;border-bottom:1px solid #e5e7eb;"><a href="${escapeHtml(item.admin_review_url)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:6px 12px;background:#111827;color:#ffffff;text-decoration:none;border-radius:6px;font-size:12px;font-weight:600;">Review in Shopify ↗</a></td>
      </tr>`;
    })
    .join("");

  const avgMargin = totalRetail > 0 ? ((totalProfit / totalRetail) * 100).toFixed(1) + "%" : "0%";
  return `
<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:920px;margin:16px auto;padding:20px;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;color:#111827;">
  <div style="border-bottom:2px solid #f3f4f6;padding-bottom:14px;margin-bottom:18px;">
    <h2 style="margin:0;font-size:20px;color:#111827;">✅ Webskitters Shopify Catalog Automation Report</h2>
    <p style="margin:4px 0 0;font-size:13px;color:#6b7280;">Automated Gemini Vision AI + 2.4x Pricing + Direct Shopify GraphQL Draft Sync</p>
  </div>
  <div style="margin-bottom:18px;font-size:13px;color:#065f46;background:#ecfdf5;padding:10px 14px;border-radius:8px;border:1px solid #a7f3d0;">
    <strong>Summary:</strong> ${count} Draft(s) Created • Total Retail: $${totalRetail.toFixed(2)} • Projected Profit: $${totalProfit.toFixed(2)} (${avgMargin} avg margin) • ${escapeHtml(alertStatus)}
  </div>
  <table style="width:100%;border-collapse:collapse;font-size:13px;text-align:left;">
    <thead>
      <tr style="background:#f3f4f6;color:#374151;">
        <th style="padding:10px;border-bottom:2px solid #e5e7eb;">SKU</th>
        <th style="padding:10px;border-bottom:2px solid #e5e7eb;">Enriched Product</th>
        <th style="padding:10px;border-bottom:2px solid #e5e7eb;">Cost</th>
        <th style="padding:10px;border-bottom:2px solid #e5e7eb;">Retail (2.4x)</th>
        <th style="padding:10px;border-bottom:2px solid #e5e7eb;">Margin</th>
        <th style="padding:10px;border-bottom:2px solid #e5e7eb;">Status</th>
        <th style="padding:10px;border-bottom:2px solid #e5e7eb;">Shopify Admin</th>
      </tr>
    </thead>
    <tbody>${rowsHtml}</tbody>
  </table>
</div>`;
}

async function sendNotifications(items, notifyTarget) {
  const succeeded = items.filter((i) => i.status === "done");
  if (succeeded.length === 0) return { slackSent: false, emailSent: false, alertStatus: "No drafts created to notify." };

  const slackUrl = (notifyTarget.startsWith("https://hooks.slack.com/") ? notifyTarget : process.env.SLACK_WEBHOOK_URL || "").trim();
  const emailRecipient = (!notifyTarget.startsWith("http") && notifyTarget.includes("@") ? notifyTarget : process.env.ALERT_EMAIL_TO || "").trim();
  const brevoKey = (process.env.BREVO_API_KEY || "").trim();
  const resendKey = (process.env.RESEND_API_KEY || "").trim();
  const count = succeeded.length;

  let slackSent = false;
  let emailSent = false;
  let alertStatus = "Enrichment Complete";

  if (slackUrl) {
    try {
      const blocks = [
        { type: "header", text: { type: "plain_text", text: `🚀 ${count} Supplier Product(s) Enriched & Created as Shopify Drafts` } },
        ...succeeded.map((item) => ({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${item.product_title}* (SKU: \`${item.sku}\`)\nWholesale: $${Number(item.wholesale_cost).toFixed(2)} ➔ *Retail: $${item.retail_price}* (${item.gross_margin} margin)\n<${item.admin_review_url}|Review in Shopify Admin ↗>`,
          },
        })),
      ];
      await fetchJson(slackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `Shopify Enrichment Complete: ${count} Draft(s) Created`, blocks }),
      });
      slackSent = true;
      alertStatus = "Slack Notification Sent ✅";
    } catch (err) {
      alertStatus = `Slack Alert Error: ${err.message}`;
    }
  }

  const htmlContent = buildEmailHtmlReport(succeeded, alertStatus);

  if (emailRecipient && resendKey) {
    try {
      await fetchJson("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: process.env.ALERT_EMAIL_FROM || "Webskitters Automation <onboarding@resend.dev>",
          to: [emailRecipient],
          subject: `✅ ${count} Shopify Draft Product(s) Enriched & Ready for Review`,
          html: htmlContent,
        }),
      });
      emailSent = true;
      alertStatus = slackSent ? `Slack & Email Sent to ${emailRecipient} ✅` : `Email Sent to ${emailRecipient} ✅`;
    } catch (err) {
      alertStatus += ` | Resend Error: ${err.message}`;
    }
  } else if (emailRecipient && brevoKey) {
    try {
      await fetchJson("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": brevoKey, "Content-Type": "application/json" },
        body: JSON.stringify({
          sender: { name: "Webskitters Catalog Automation", email: process.env.ALERT_EMAIL_FROM || "noreply@example.com" },
          to: [{ email: emailRecipient }],
          subject: `✅ ${count} Shopify Draft Product(s) Enriched & Ready for Review`,
          htmlContent,
        }),
      });
      emailSent = true;
      alertStatus = slackSent ? `Slack & Email Sent to ${emailRecipient} ✅` : `Email Sent to ${emailRecipient} ✅`;
    } catch (err) {
      alertStatus += ` | Brevo Error: ${err.message}`;
    }
  }

  return { slackSent, emailSent, alertStatus, emailRecipient };
}

function emitJobEvent(job, eventName, data) {
  job.updatedAt = Date.now();
  const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of job.subscribers) {
    try {
      res.write(payload);
    } catch {
      job.subscribers.delete(res);
    }
  }
}

async function processRow(job, index, row, shopCredsPromise) {
  const updateState = (patch) => {
    Object.assign(job.rows[index], patch);
    emitJobEvent(job, "row_update", {
      index,
      row: job.rows[index],
      completed: job.completed,
      failed: job.failed,
      total: job.total,
    });
  };

  try {
    updateState({ status: "processing", stage: "ai", stageLabel: "Gemini Vision AI Analyzing..." });
    const [base64Image, shopCreds] = await Promise.all([
      fetchImageBase64(row.ai_image_url),
      shopCredsPromise,
    ]);
    const ai = await runGeminiVision(row, base64Image);
    const shopPayload = buildShopifyPayload(row, ai);

    updateState({
      status: "processing",
      stage: "shopify",
      stageLabel: "Creating Shopify Draft...",
      product_title: shopPayload.title,
      category: shopPayload.category,
      material: shopPayload.material,
      primary_color: shopPayload.primaryColor,
    });

    const created = await createShopifyDraft(shopCreds, shopPayload);
    job.completed += 1;

    updateState({
      status: "done",
      stage: "done",
      stageLabel: "Draft Created",
      shopify_product_id: created.id,
      product_title: created.title,
      admin_review_url: created.admin_review_url,
    });
  } catch (err) {
    job.failed += 1;
    updateState({
      status: "error",
      stage: "error",
      stageLabel: "Failed",
      error: err.message,
    });
  }
}

async function createAndRunJob(payload) {
  cleanupOldJobs();
  const { rows, notifyTarget } = await ingestRows(payload);
  const id = crypto.randomBytes(8).toString("hex");

  const job = {
    id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: "running",
    total: rows.length,
    completed: 0,
    failed: 0,
    notifyTarget,
    alertStatus: "Processing batch...",
    emailSent: false,
    slackSent: false,
    emailRecipient: "",
    durationMs: 0,
    subscribers: new Set(),
    rows: rows.map((r, index) => ({
      index,
      sku: r.sku,
      raw_name: r.raw_name,
      product_title: r.raw_name || r.sku,
      wholesale_cost: r.wholesale_cost,
      retail_price: r.retail_price,
      compare_at_price: r.compare_at_price,
      profit_per_unit: r.profit_per_unit,
      gross_margin: r.gross_margin,
      thumbnail_url: r.ai_image_url || r.image_url || "",
      category: "",
      material: "",
      primary_color: "",
      status: "pending",
      stage: "pending",
      stageLabel: "Pending",
      admin_review_url: "",
      error: "",
    })),
  };
  jobs.set(id, job);

  // Start async execution right away
  (async () => {
    const t0 = Date.now();
    try {
      const shopCredsPromise = getShopifyToken();
      const concurrency = Math.min(4, rows.length);
      let cursor = 0;

      const workers = Array.from({ length: concurrency }, async (_, wIdx) => {
        await new Promise((r) => setTimeout(r, (wIdx + 1) * 180));
        while (cursor < rows.length) {
          const idx = cursor++;
          await processRow(job, idx, rows[idx], shopCredsPromise);
        }
      });
      await Promise.all(workers);

      emitJobEvent(job, "notifying", { message: "Dispatching Email / Slack Report..." });
      const notifyRes = await sendNotifications(job.rows, notifyTarget);
      job.alertStatus = notifyRes.alertStatus;
      job.emailSent = notifyRes.emailSent;
      job.slackSent = notifyRes.slackSent;
      job.emailRecipient = notifyRes.emailRecipient || "";
      job.status = "completed";
      job.durationMs = Date.now() - t0;

      emitJobEvent(job, "complete", getPublicJobState(job));
    } catch (err) {
      job.status = "failed";
      job.alertStatus = err.message;
      job.durationMs = Date.now() - t0;
      emitJobEvent(job, "complete", getPublicJobState(job));
    } finally {
      for (const res of job.subscribers) {
        try {
          res.end();
        } catch {}
      }
      job.subscribers.clear();
    }
  })();

  return getPublicJobState(job);
}

function getPublicJobState(job) {
  return {
    id: job.id,
    status: job.status,
    total: job.total,
    completed: job.completed,
    failed: job.failed,
    alertStatus: job.alertStatus,
    emailSent: job.emailSent,
    slackSent: job.slackSent,
    emailRecipient: job.emailRecipient,
    durationMs: job.durationMs,
    rows: job.rows,
  };
}

function getJob(id) {
  return jobs.get(id) || null;
}

module.exports = { createAndRunJob, getJob, getPublicJobState };
