const https = require("https");
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const FALLBACK_CATALOG = {
  BAG001: { title: "Village Cricket Co Professional Grade English Willow Bat", category: "Cricket Equipment", material: "English Willow", color: "Natural Wood / Green", estWholesale: 12 },
  BAG002: { title: "Match-Regulation Four-Piece Red Leather Cricket Ball", category: "Cricket Balls", material: "Alum-Tanned Leather", color: "Classic Red", estWholesale: 14 },
  BAG003: { title: "Tournament Standard Heavy Wooden Cricket Stumps & Wickets Set", category: "Cricket Accessories", material: "Hardwood", color: "Natural Timber", estWholesale: 17 },
  BAT001: { title: "Village Cricket Co Professional Grade English Willow Bat", category: "Cricket Equipment", material: "English Willow", color: "Natural Wood / Green", estWholesale: 12 },
  BAT002: { title: "Match-Regulation Four-Piece Red Leather Cricket Ball", category: "Cricket Balls", material: "Alum-Tanned Leather", color: "Classic Red", estWholesale: 14 },
  BAT003: { title: "Tournament Standard Heavy Wooden Cricket Stumps & Wickets Set", category: "Cricket Accessories", material: "Hardwood", color: "Natural Timber", estWholesale: 17 },
};

const CURRENCY_SYMBOLS = {
  USD: "$",
  INR: "₹",
  EUR: "€",
  GBP: "£",
  CAD: "CA$",
  AUD: "A$",
};

const FALLBACK_FX = { USD: 1, INR: 92.5, EUR: 0.92, GBP: 0.79, CAD: 1.38, AUD: 1.53 };
const fxCache = { rates: null, fetchedAt: 0 };

const jobs = new Map();
const modelCooldownUntil = new Map();
const JOB_TTL_MS = 30 * 60 * 1000;
const SHOPIFY_MAX_MP = 19.5;

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

function formatMoney(amount, currencyCode) {
  const sym = CURRENCY_SYMBOLS[currencyCode] || `${currencyCode} `;
  const n = Number(amount) || 0;
  if (currencyCode === "INR") {
    return `${sym}${Math.round(n).toLocaleString("en-IN")}`;
  }
  return `${sym}${n.toFixed(2)}`;
}

function parseWholesaleCost(rawVal) {
  const cleaned = String(rawVal ?? "").replace(/[^0-9.-]/g, "").trim();
  if (!cleaned) return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) && n > 0 ? Number(n.toFixed(2)) : null;
}

function computePricing(wholesaleUsd, storeCurrency = "USD", fxRate = 1) {
  const wholesale = Number(wholesaleUsd) || 25.0;
  const retailUsd = Number((Math.floor(wholesale * 2.4) + 0.99).toFixed(2));
  const compareAtUsd = Number((Math.floor(wholesale * 3.5) + 0.99).toFixed(2));
  const profitUsd = Number((retailUsd - wholesale).toFixed(2));
  const margin = retailUsd > 0 ? `${(((retailUsd - wholesale) / retailUsd) * 100).toFixed(1)}%` : "0%";

  const rate = Number(fxRate) > 0 ? Number(fxRate) : 1;
  const isInr = storeCurrency === "INR";
  const roundStore = (v) => (isInr ? Math.round(v * rate).toFixed(2) : (v * rate).toFixed(2));

  return {
    wholesale_cost: wholesale.toFixed(2),
    retail_price: retailUsd.toFixed(2),
    compare_at_price: compareAtUsd.toFixed(2),
    profit_per_unit: profitUsd.toFixed(2),
    gross_margin: margin,
    store_currency: storeCurrency,
    fx_rate: rate,
    store_wholesale_price: roundStore(wholesale),
    store_retail_price: roundStore(retailUsd),
    store_compare_at_price: roundStore(compareAtUsd),
    store_profit_per_unit: roundStore(profitUsd),
  };
}

function getImageUrls(rawUrl) {
  const url = String(rawUrl || "").trim();
  if (!url) return { sourceUrl: "", thumbUrl: "", forceFullInspection: false };

  // If query explicitly asks for ultra-high-res width (e.g. ?w=5000+) keep it for real optimization testing
  const wMatch = url.match(/[?&]w=(\d+)/);
  const explicitLargeW = wMatch && parseInt(wMatch[1], 10) >= 4500;

  if (url.includes("unsplash.com") && !explicitLargeW) {
    const clean = url.split("?")[0];
    return {
      sourceUrl: `${clean}?w=2048&fit=max&q=85&auto=format`,
      thumbUrl: `${clean}?w=400&fit=max&q=70&auto=format`,
      forceFullInspection: false,
    };
  }
  if (url.includes("cloudinary.com") && url.includes("/upload/") && !explicitLargeW) {
    return {
      sourceUrl: url.replace("/upload/", "/upload/c_limit,w_2048,h_2048,q_auto/"),
      thumbUrl: url.replace("/upload/", "/upload/c_limit,w_400,h_400,q_auto/"),
      forceFullInspection: false,
    };
  }
  if (url.includes("imgix.net") && !explicitLargeW) {
    const sep = url.includes("?") ? "&" : "?";
    return {
      sourceUrl: `${url}${sep}w=2048&fit=max&q=85`,
      thumbUrl: `${url}${sep}w=400&fit=max&q=70`,
      forceFullInspection: false,
    };
  }
  return { sourceUrl: url, thumbUrl: url, forceFullInspection: true };
}

function parseImageDimensions(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return { width: 0, height: 0, megapixels: 0, mimeType: "image/jpeg" };

  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    const width = buf.readUInt32BE(16);
    const height = buf.readUInt32BE(20);
    return { width, height, megapixels: Number(((width * height) / 1e6).toFixed(2)), mimeType: "image/png" };
  }

  // GIF
  if (buf.toString("ascii", 0, 3) === "GIF") {
    const width = buf.readUInt16LE(6);
    const height = buf.readUInt16LE(8);
    return { width, height, megapixels: Number(((width * height) / 1e6).toFixed(2)), mimeType: "image/gif" };
  }

  // WEBP
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buf.toString("ascii", 12, 16);
    let width = 0, height = 0;
    if (chunk === "VP8X" && buf.length >= 30) {
      width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    } else if (chunk === "VP8 " && buf.length >= 30) {
      width = buf.readUInt16LE(26) & 0x3fff;
      height = buf.readUInt16LE(28) & 0x3fff;
    } else if (chunk === "VP8L" && buf.length >= 25) {
      const bits = buf.readUInt32LE(21);
      width = (bits & 0x3fff) + 1;
      height = ((bits >> 14) & 0x3fff) + 1;
    }
    return { width, height, megapixels: Number(((width * height) / 1e6).toFixed(2)), mimeType: "image/webp" };
  }

  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      while (i < buf.length && buf[i] === 0xff) i++;
      if (i >= buf.length) break;
      const marker = buf[i];
      i++;
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (i + 2 > buf.length) break;
      const len = buf.readUInt16BE(i);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (i + 7 <= buf.length) {
          const height = buf.readUInt16BE(i + 3);
          const width = buf.readUInt16BE(i + 5);
          return { width, height, megapixels: Number(((width * height) / 1e6).toFixed(2)), mimeType: "image/jpeg" };
        }
      }
      i += len;
    }
    return { width: 0, height: 0, megapixels: 0, mimeType: "image/jpeg" };
  }

  return { width: 0, height: 0, megapixels: 0, mimeType: "image/jpeg" };
}

function execFileAsync(cmd, args, timeout = 30000) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve({ stdout, stderr });
    });
  });
}

let resizeMutex = Promise.resolve();
function withResizeLock(fn) {
  const next = resizeMutex.then(fn, fn);
  resizeMutex = next.catch(() => {});
  return next;
}

async function resizeBufferWithVips(buf, maxDim, quality = 85) {
  return withResizeLock(async () => {
    const tmpId = crypto.randomBytes(6).toString("hex");
    const inPath = path.join(os.tmpdir(), `img-in-${tmpId}`);
    const outPath = path.join(os.tmpdir(), `img-out-${tmpId}.jpg`);
    const qv = quality >= 82 ? "3" : "6";
    try {
      fs.writeFileSync(inPath, buf);
      try {
        await execFileAsync("ffmpeg", [
          "-y", "-v", "error", "-threads", "1", "-filter_threads", "1",
          "-i", inPath, "-frames:v", "1",
          "-vf", `scale='min(${maxDim},iw)':'min(${maxDim},ih)':force_original_aspect_ratio=decrease`,
          "-q:v", qv, outPath,
        ]);
      } catch {
        await execFileAsync("vipsthumbnail", [inPath, "--size", `${maxDim}x${maxDim}>`, "-o", `${outPath}[Q=${quality}]`]);
      }
      return fs.readFileSync(outPath);
    } finally {
      try { fs.unlinkSync(inPath); } catch {}
      try { fs.unlinkSync(outPath); } catch {}
    }
  });
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
        let totalBytes = 0;
        const maxBytes = opts.maxBytes || 45 * 1024 * 1024;
        res.on("data", (c) => {
          totalBytes += c.length;
          if (totalBytes > maxBytes) {
            req.destroy(new Error("Image file exceeds 45MB safety limit"));
            return;
          }
          chunks.push(c);
        });
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

async function getUsdFxRate(targetCurrency) {
  const code = String(targetCurrency || "USD").toUpperCase();
  if (code === "USD") return 1;
  const now = Date.now();
  if (fxCache.rates && now - fxCache.fetchedAt < 6 * 3600 * 1000 && fxCache.rates[code]) {
    return fxCache.rates[code];
  }
  try {
    const res = await fetchJson("https://open.er-api.com/v6/latest/USD", { timeout: 7000 });
    if (res?.rates && res.rates[code]) {
      fxCache.rates = res.rates;
      fxCache.fetchedAt = now;
      return res.rates[code];
    }
  } catch (err) {
    console.warn("[Engine] FX API fallback:", err.message);
  }
  return FALLBACK_FX[code] || 1;
}

async function getShopifyContext() {
  const shop = (process.env.SHOPIFY_SHOP || "all-hydro-test.myshopify.com").trim();
  const clientId = (process.env.SHOPIFY_CLIENT_ID || "").trim();
  const clientSecret = (process.env.SHOPIFY_CLIENT_SECRET || "").trim();
  const tokenRes = await fetchJson(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&grant_type=client_credentials`,
    timeout: 15000,
  });
  if (!tokenRes?.access_token) throw new Error("Failed to obtain Shopify access token");

  const accessToken = tokenRes.access_token;
  let currencyCode = "USD";
  let shopName = shop;
  try {
    const shopRes = await fetchJson(`https://${shop}/admin/api/2024-07/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken },
      body: JSON.stringify({ query: "{ shop { name currencyCode } }" }),
      timeout: 10000,
    });
    currencyCode = shopRes?.data?.shop?.currencyCode || "USD";
    shopName = shopRes?.data?.shop?.name || shop;
  } catch (err) {
    console.warn("[Engine] Shop currency query fallback:", err.message);
  }

  const fxRate = await getUsdFxRate(currencyCode);
  return {
    shop,
    shopName,
    accessToken,
    currencyCode,
    currencySymbol: CURRENCY_SYMBOLS[currencyCode] || `${currencyCode} `,
    fxRate,
  };
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
          if (cols.some((c) => c.length > 0)) {
            const explicitCost = parseWholesaleCost(cols[2]);
            const imageUrl = (cols[3] || "").trim();
            const urls = getImageUrls(imageUrl);
            rows.push({
              sku: cols[0] || `SKU-ROW-${i}`,
              raw_name: (cols[1] || "").trim(),
              wholesale_cost: explicitCost,
              has_explicit_cost: explicitCost !== null,
              image_url: imageUrl,
              safe_image_url: urls.sourceUrl,
              ai_image_url: urls.thumbUrl,
              source: "google_sheet",
              sheet_url: sheetUrl,
              sheet_row_index: i + 1,
              notify_target: notifyTarget,
            });
          }
        }
        if (rows.length > 0) return { rows, notifyTarget };
      }
    }
    throw new Error("Google Sheet appears empty or invalid. Expected columns: SKU, Name, Cost, Image URL.");
  }

  const manualImageUrl = String(payload.imageUrl || payload["Raw Product Image URL"] || "").trim() || "https://images.unsplash.com/photo-1553062407-98eeb64c6a62";
  const explicitCost = parseWholesaleCost(payload.wholesaleCost ?? payload["Wholesale Cost ($)"]);
  const urls = getImageUrls(manualImageUrl);

  return {
    notifyTarget,
    rows: [
      {
        sku: String(payload.sku || payload["Supplier SKU"] || "").trim() || `SKU-${Date.now().toString().slice(-5)}`,
        raw_name: String(payload.rawName || payload["Raw Item Name"] || "").trim(),
        wholesale_cost: explicitCost,
        has_explicit_cost: explicitCost !== null,
        image_url: manualImageUrl,
        safe_image_url: urls.sourceUrl,
        ai_image_url: urls.thumbUrl,
        source: "manual_demo",
        notify_target: notifyTarget,
      },
    ],
  };
}

async function optimizeOversizedBuffer(targetUrl, srcBuf, info) {
  // 1. Primary: Cloud libvips optimizer via wsrv.nl (uses 0MB container RAM, handles 20MP-100MP safely)
  try {
    const optUrl = `https://wsrv.nl/?url=${encodeURIComponent(targetUrl)}&w=2048&h=2048&fit=inside&output=jpg&q=85`;
    const optRes = await requestUrl(optUrl, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 20000 });
    if (optRes.status < 400 && optRes.buffer && optRes.buffer.length > 500) {
      const dim = parseImageDimensions(optRes.buffer);
      if (dim.width > 0 && dim.megapixels <= SHOPIFY_MAX_MP) {
        return optRes.buffer;
      }
    }
  } catch (err) {
    console.warn("[Engine] Cloud optimizer fallback:", err.message);
  }

  // 2. Local fallback: ffmpeg with lowres JPEG DCT downscale to stay safely inside 512MB RAM
  const tmpId = crypto.randomBytes(6).toString("hex");
  const inPath = path.join(os.tmpdir(), `img-in-${tmpId}`);
  const outPath = path.join(os.tmpdir(), `img-out-${tmpId}.jpg`);
  return withResizeLock(async () => {
    try {
      fs.writeFileSync(inPath, srcBuf);
      const isJpeg = info?.mimeType === "image/jpeg";
      const lowresArgs = isJpeg && (info.width > 3600 || info.height > 3600) ? ["-lowres", "2"] : [];
      await execFileAsync("ffmpeg", [
        "-y", "-v", "error", "-threads", "1", "-filter_threads", "1",
        ...lowresArgs, "-i", inPath, "-frames:v", "1",
        "-vf", "scale='min(2048,iw)':'min(2048,ih)':force_original_aspect_ratio=decrease",
        "-q:v", "3", outPath,
      ]);
      return fs.readFileSync(outPath);
    } finally {
      try { fs.unlinkSync(inPath); } catch {}
      try { fs.unlinkSync(outPath); } catch {}
    }
  });
}

async function prepareAndOptimizeImage(row, onStageNotice) {
  const targetUrl = row.safe_image_url || row.image_url;
  if (!targetUrl) return { aiBase64: "", aiMime: "image/jpeg", uploadBuffer: null, uploadMime: "image/jpeg", needsStagedUpload: false, imageUrl: "" };

  onStageNotice({ stage: "downloading", stageLabel: "Fetching Image", notice: "Downloading & inspecting image resolution..." });

  let srcBuf = null;
  let info = { width: 0, height: 0, megapixels: 0, mimeType: "image/jpeg" };
  try {
    const res = await requestUrl(targetUrl, { headers: { "User-Agent": "Mozilla/5.0 (compatible; WebskittersCatalogBot/1.0)" }, timeout: 22000 });
    if (res.status < 400 && res.buffer && res.buffer.length > 100) {
      srcBuf = res.buffer;
      info = parseImageDimensions(srcBuf);
    }
  } catch (err) {
    console.warn(`[Engine] Source image download fallback for ${row.sku}:`, err.message);
  }

  let uploadBuffer = srcBuf;
  let uploadMime = info.mimeType || "image/jpeg";
  let needsStagedUpload = false;
  let optimizedFromMp = 0;

  if (srcBuf) {
    const isOversizedMp = info.megapixels > SHOPIFY_MAX_MP || info.width > 4096 || info.height > 4096;
    const isHugeBytes = srcBuf.length > 14 * 1024 * 1024;
    if (isOversizedMp || isHugeBytes) {
      optimizedFromMp = info.megapixels;
      const mpText = info.megapixels > 0 ? `${info.megapixels.toFixed(1)} MP (${info.width}×${info.height})` : `${(srcBuf.length / (1024 * 1024)).toFixed(1)} MB`;
      onStageNotice({
        stage: "optimizing",
        stageLabel: "Optimizing Image",
        notice: `High-resolution ${mpText} image detected — optimizing down to ≤20MP before AI analysis & Shopify upload...`,
      });
      try {
        uploadBuffer = await optimizeOversizedBuffer(targetUrl, srcBuf, info);
        srcBuf = null;
        uploadMime = "image/jpeg";
        needsStagedUpload = true;
        info = parseImageDimensions(uploadBuffer);
      } catch (optErr) {
        console.warn(`[Engine] Image resize skipped (${row.sku}):`, optErr.message);
      }
    }
  }

  // Create fast <=512px buffer for Vision AI
  let aiBase64 = "";
  let aiMime = "image/jpeg";
  if (uploadBuffer) {
    if (uploadBuffer.length > 750 * 1024) {
      try {
        const aiBuf = await resizeBufferWithVips(uploadBuffer, 512, 75);
        aiBase64 = aiBuf.toString("base64");
        aiMime = "image/jpeg";
      } catch {
        aiBase64 = uploadBuffer.toString("base64");
        aiMime = uploadMime;
      }
    } else {
      aiBase64 = uploadBuffer.toString("base64");
      aiMime = uploadMime;
    }
  } else if (row.ai_image_url && row.ai_image_url !== targetUrl) {
    try {
      const thumbRes = await requestUrl(row.ai_image_url, { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 10000 });
      if (thumbRes.status < 400 && thumbRes.buffer?.length > 100) {
        aiBase64 = thumbRes.buffer.toString("base64");
        aiMime = parseImageDimensions(thumbRes.buffer).mimeType || "image/jpeg";
      }
    } catch {}
  }

  return {
    aiBase64,
    aiMime,
    uploadBuffer,
    uploadMime,
    needsStagedUpload,
    optimizedFromMp,
    imageUrl: targetUrl,
  };
}

async function runGeminiVision(row, aiBase64, aiMime = "image/jpeg") {
  const apiKey = (process.env.GEMINI_API_KEY || "").trim();
  if (!apiKey) return {};

  const costLine = row.has_explicit_cost ? `$${row.wholesale_cost} USD (explicit)` : "NOT PROVIDED — you MUST estimate realistic USD wholesale cost from the visual item";
  const hintLine = row.raw_name ? row.raw_name : "(None — identify purely from photo)";

  const promptText = `You are an elite E-Commerce Merchandiser and Vision AI specialist.
CRITICAL RULES:
1. VISUALLY EXAMINE the attached product photograph FIRST. Identify the EXACT product shown (e.g., DSLR camera, luxury perfume bottle, cricket bat, wristwatch, footwear, electronics, etc.).
2. NEVER trust or copy "Supplier Reference Text" if it is blank, generic, or contradicts what is visible in the photo. Always title & classify based on what is VISUALLY in the image.
3. Estimate a realistic wholesale unit cost in USD ("estimated_wholesale_usd") matching the true real-world category & quality of the photographed product (e.g. designer perfume ~$28-$60, DSLR camera kit ~$280-$550, willow cricket bat ~$12-$45, leather backpack ~$30-$65). Two completely different categories like a perfume vs a DSLR camera must NEVER get the same generic price!

Context:
- SKU: ${row.sku}
- Supplier Reference Text (may be blank or inaccurate): ${hintLine}
- Wholesale Cost Status: ${costLine}

Return ONE single valid JSON object (NOT an array, no markdown, no backticks) with these exact keys:
{
  "persuasive_title": "string (accurate brand-voice retail title, 4-9 words describing what is VISUALLY in the image)",
  "estimated_wholesale_usd": number,
  "price_rationale": "short 1-line explanation of visual product & price tier",
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
  if (aiBase64 && aiBase64.length > 100) {
    parts.push({ inline_data: { mime_type: aiMime || "image/jpeg", data: aiBase64 } });
  }

  const reqBody = JSON.stringify({
    contents: [{ parts }],
    generationConfig: { response_mime_type: "application/json" },
  });

  const allModels = [
    "gemini-3-flash-preview",
    "gemini-3.5-flash-lite",
    "gemini-flash-lite-latest",
    "gemini-3.7-flash",
    "gemini-flash-latest",
    "gemini-3.5-flash",
    "gemini-3.6-flash",
  ];

  const extractJson = (rawText) => {
    const cleaned = String(rawText || "").replace(/```json/gi, "").replace(/```/g, "").trim();
    const match = cleaned.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : cleaned);
    return (Array.isArray(parsed) ? parsed[0] : parsed) || {};
  };

  let lastErr = "";
  for (let pass = 1; pass <= 2; pass++) {
    const now = Date.now();
    const candidates = allModels.filter((m) => (modelCooldownUntil.get(m) || 0) <= now);
    const tryList = candidates.length > 0 ? candidates : allModels.slice(0, 3);
    for (const model of tryList) {
      try {
        const data = await fetchJson(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
          { method: "POST", headers: { "Content-Type": "application/json" }, body: reqBody, timeout: 14000 }
        );
        const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
        if (rawText) {
          const obj = extractJson(rawText);
          if (obj && obj.persuasive_title) return obj;
        }
      } catch (err) {
        lastErr = err.message;
        if (lastErr.includes("HTTP 429")) {
          modelCooldownUntil.set(model, Date.now() + 10 * 60 * 1000);
        }
        console.warn(`[Engine] Gemini (${model}) failed for ${row.sku}:`, lastErr);
      }
    }
    if (pass === 1) await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Gemini Vision AI unavailable across models (${lastErr.slice(0, 120) || "timeout"})`);
}

function buildShopifyPayload(row, ai, storeCurrency, fxRate) {
  const demoFallback = FALLBACK_CATALOG[row.sku];
  const fallbackTitle = demoFallback?.title || row.raw_name || `Catalog Product ${row.sku}`;
  const productTitle = String(ai.persuasive_title || "").trim() || fallbackTitle;
  const material = ai.material || demoFallback?.material || "Premium Grade";
  const primaryColor = ai.primary_color || demoFallback?.color || "Standard";
  const category = ai.category || demoFallback?.category || "General Merchandise";

  let wholesaleUsd = row.wholesale_cost;
  if (!row.has_explicit_cost) {
    const aiCost = parseFloat(ai.estimated_wholesale_usd);
    wholesaleUsd = Number.isFinite(aiCost) && aiCost >= 3 ? Number(aiCost.toFixed(2)) : (demoFallback?.estWholesale || 25.0);
  }
  const pricing = computePricing(wholesaleUsd, storeCurrency, fxRate);

  const defaultDesc = `<p>Experience exceptional quality with the <strong>${escapeHtml(productTitle)}</strong>. Carefully curated and AI-enriched for retail readiness, combining authentic craftsmanship with dependable performance.</p><h3>Product Highlights</h3><ul><li><strong>Premium Craftsmanship:</strong> Constructed with ${escapeHtml(material)} for lasting reliability.</li><li><strong>Signature Finish:</strong> Refined ${escapeHtml(primaryColor)} styling suited for everyday and specialist use.</li><li><strong>Merchandise Ready:</strong> Verified specifications and optimized storefront copy.</li><li><strong>Category Tuned:</strong> Tailored for ${escapeHtml(category)} shoppers.</li><li><strong>Quality Inspected:</strong> Ready for direct customer fulfillment.</li></ul><h3>Specifications</h3><ul><li><strong>SKU:</strong> ${escapeHtml(row.sku)}</li><li><strong>Category:</strong> ${escapeHtml(category)}</li><li><strong>Material:</strong> ${escapeHtml(material)}</li><li><strong>Primary Color:</strong> ${escapeHtml(primaryColor)}</li></ul>`;

  const tagsList = (ai.tags || `${category}, ${material}, ${primaryColor}, AI Enriched`)
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  tagsList.push(`Wholesale_$${pricing.wholesale_cost}`, `Margin_${pricing.gross_margin}`, `Currency_${storeCurrency}`, "webskitters-automated");
  if (!tagsList.includes(material)) tagsList.push(material);
  if (!tagsList.includes(primaryColor)) tagsList.push(primaryColor);
  if (!tagsList.includes(category)) tagsList.push(category);

  return {
    pricing,
    title: productTitle,
    descriptionHtml: ai.html_description || defaultDesc,
    tags: tagsList,
    sku: row.sku,
    alt_text: ai.image_alt_text || productTitle,
    seo_title: (ai.seo_meta_title || `${productTitle} | SKU ${row.sku}`).slice(0, 70),
    seo_description: (ai.seo_meta_description || `Shop ${productTitle}. Premium ${material} in ${category}.`).slice(0, 160),
    material,
    primaryColor,
    category,
    priceRationale: ai.price_rationale || (row.has_explicit_cost ? "Supplier cost provided" : "AI visual valuation"),
  };
}

function buildMultipartFormData(fields, fileField) {
  const boundary = `----WebskittersStaged${crypto.randomBytes(8).toString("hex")}`;
  const chunks = [];
  for (const { name, value } of fields) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, "utf8"));
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${fileField.name}"; filename="${fileField.filename}"\r\nContent-Type: ${fileField.contentType}\r\n\r\n`,
      "utf8"
    )
  );
  chunks.push(fileField.buffer);
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`, "utf8"));
  return { boundary, body: Buffer.concat(chunks) };
}

async function uploadStagedImage(shopCreds, buffer, mimeType, sku) {
  const { shop, accessToken } = shopCreds;
  const endpoint = `https://${shop}/admin/api/2024-07/graphql.json`;
  const headers = { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken };
  const ext = mimeType.includes("png") ? "png" : mimeType.includes("webp") ? "webp" : "jpg";
  const filename = `${String(sku || "product").replace(/[^a-zA-Z0-9_-]/g, "")}-${Date.now()}.${ext}`;

  const stagedMutation = `
    mutation stagedUploadsCreate($input: [StagedUploadInput!]!) {
      stagedUploadsCreate(input: $input) {
        stagedTargets {
          url
          resourceUrl
          parameters { name value }
        }
        userErrors { field message }
      }
    }
  `;
  const stagedRes = await fetchJson(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: stagedMutation,
      variables: {
        input: [{ filename, mimeType, resource: "IMAGE", httpMethod: "POST", fileSize: String(buffer.length) }],
      },
    }),
  });
  const target = stagedRes?.data?.stagedUploadsCreate?.stagedTargets?.[0];
  if (!target?.url || !target?.resourceUrl) {
    throw new Error(`Shopify stagedUploadsCreate failed: ${JSON.stringify(stagedRes?.data?.stagedUploadsCreate?.userErrors || stagedRes)}`);
  }

  const { boundary, body } = buildMultipartFormData(target.parameters || [], {
    name: "file",
    filename,
    contentType: mimeType,
    buffer,
  });
  const uploadRes = await requestUrl(target.url, {
    method: "POST",
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": String(body.length) },
    body,
    timeout: 30000,
  });
  if (uploadRes.status >= 400) {
    throw new Error(`Shopify staged file upload failed (HTTP ${uploadRes.status})`);
  }
  return target.resourceUrl;
}

async function verifyOrRepairProductMedia(shopCreds, productId, imageInfo, payload, onStageNotice) {
  const { shop, accessToken } = shopCreds;
  const endpoint = `https://${shop}/admin/api/2024-07/graphql.json`;
  const headers = { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken };

  const query = `query($id: ID!) { node(id: $id) { ... on Product { media(first: 2) { edges { node { id status mediaErrors { message } ... on MediaImage { image { url } } } } } } } }`;
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 900));
    const qRes = await fetchJson(endpoint, { method: "POST", headers, body: JSON.stringify({ query, variables: { id: productId } }) });
    const edge = qRes?.data?.node?.media?.edges?.[0]?.node;
    if (edge?.status === "READY") return edge.image?.url || "";
    if (edge?.status === "FAILED") {
      // External host blocked Shopify or failed >20MP check -> upload verified local buffer via stagedUploadsCreate!
      if (imageInfo.uploadBuffer) {
        onStageNotice({ stage: "shopify", stageLabel: "Uploading Media", notice: "Uploading verified image directly via Shopify CDN..." });
        const stagedUrl = await uploadStagedImage(shopCreds, imageInfo.uploadBuffer, imageInfo.uploadMime || "image/jpeg", payload.sku);
        const addMediaMut = `mutation($productId: ID!, $media: [CreateMediaInput!]!) { productCreateMedia(productId: $productId, media: $media) { media { id status } mediaUserErrors { message } } }`;
        await fetchJson(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({
            query: addMediaMut,
            variables: { productId, media: [{ originalSource: stagedUrl, alt: payload.alt_text, mediaContentType: "IMAGE" }] },
          }),
        });
        return "";
      }
      break;
    }
  }
  return "";
}

async function createShopifyDraft(shopCreds, data, imageInfo, onStageNotice) {
  const { shop, accessToken } = shopCreds;
  const endpoint = `https://${shop}/admin/api/2024-07/graphql.json`;
  const headers = { "Content-Type": "application/json", "X-Shopify-Access-Token": accessToken };

  let mediaSourceUrl = imageInfo.imageUrl;
  if (imageInfo.needsStagedUpload && imageInfo.uploadBuffer) {
    onStageNotice({
      stage: "shopify",
      stageLabel: "Uploading Media",
      notice: `Uploading optimized ${imageInfo.optimizedFromMp ? `(${imageInfo.optimizedFromMp.toFixed(1)} MP → ≤20MP) ` : ""}image directly to Shopify...`,
    });
    mediaSourceUrl = await uploadStagedImage(shopCreds, imageInfo.uploadBuffer, imageInfo.uploadMime || "image/jpeg", data.sku);
  }

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
    media: mediaSourceUrl ? [{ originalSource: mediaSourceUrl, alt: data.alt_text, mediaContentType: "IMAGE" }] : [],
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

  if (variantId) {
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
          price: String(data.pricing.store_retail_price),
          compareAtPrice: data.pricing.store_compare_at_price ? String(data.pricing.store_compare_at_price) : undefined,
          ...(data.sku ? { inventoryItem: { sku: data.sku } } : {}),
        },
      ],
    };
    await fetchJson(endpoint, { method: "POST", headers, body: JSON.stringify({ query: bulkMutation, variables: bulkVariables }) });
  }

  if (imageInfo.uploadBuffer) {
    await verifyOrRepairProductMedia(shopCreds, created.id, imageInfo, data, onStageNotice);
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
  let totalRetailUsd = 0;
  let totalProfitUsd = 0;

  const rowsHtml = items
    .map((item) => {
      const wholesaleUsd = parseFloat(String(item.wholesale_cost || "0").replace(/[^0-9.]/g, "")) || 0;
      const retailUsd = parseFloat(String(item.retail_price || "0").replace(/[^0-9.]/g, "")) || 0;
      const compareUsd = parseFloat(String(item.compare_at_price || "0").replace(/[^0-9.]/g, "")) || 0;
      const profitUsd = parseFloat(String(item.profit_per_unit || "0").replace(/[^0-9.]/g, "")) || 0;
      totalRetailUsd += retailUsd;
      totalProfitUsd += profitUsd;

      return `
      <tr>
        <td valign="middle" style="padding:14px 12px;border-bottom:1px solid #e2e8f0;font-family:'Courier New',Courier,monospace;font-size:12px;font-weight:700;color:#0f172a;white-space:nowrap;">
          <span style="display:inline-block;background-color:#f1f5f9;border:1px solid #e2e8f0;padding:4px 8px;border-radius:5px;">${escapeHtml(item.sku)}</span>
        </td>
        <td valign="middle" style="padding:14px 12px;border-bottom:1px solid #e2e8f0;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0">
            <tr>
              ${item.thumbnail_url ? `<td width="48" valign="middle" style="padding-right:10px;"><img src="${escapeHtml(item.thumbnail_url)}" width="40" height="40" alt="" style="display:block;width:40px;height:40px;border-radius:6px;border:1px solid #e2e8f0;" /></td>` : ""}
              <td valign="middle">
                <div style="font-size:14px;font-weight:700;color:#0f172a;line-height:1.35;">${escapeHtml(item.product_title)}</div>
                <div style="font-size:12px;color:#64748b;margin-top:3px;">${escapeHtml(item.category || "Catalog")} &bull; ${escapeHtml(item.material || "Standard")} &bull; ${escapeHtml(item.primary_color || "")}</div>
              </td>
            </tr>
          </table>
        </td>
        <td valign="middle" style="padding:14px 10px;border-bottom:1px solid #e2e8f0;font-size:13px;color:#475569;white-space:nowrap;">
          <div>$${wholesaleUsd.toFixed(2)}</div>
          ${item.has_explicit_cost === false ? `<div style="font-size:11px;color:#4f46e5;">AI Est.</div>` : ""}
        </td>
        <td valign="middle" style="padding:14px 10px;border-bottom:1px solid #e2e8f0;white-space:nowrap;">
          <div style="font-size:14px;font-weight:700;color:#059669;">$${retailUsd.toFixed(2)}</div>
          ${compareUsd > 0 ? `<div style="font-size:11px;color:#94a3b8;text-decoration:line-through;">$${compareUsd.toFixed(2)}</div>` : ""}
        </td>
        <td valign="middle" style="padding:14px 10px;border-bottom:1px solid #e2e8f0;font-size:13px;font-weight:600;color:#047857;white-space:nowrap;">+${escapeHtml(item.gross_margin)}<div style="font-size:11px;color:#64748b;font-weight:400;">+$${profitUsd.toFixed(2)} profit</div></td>
        <td valign="middle" style="padding:14px 10px;border-bottom:1px solid #e2e8f0;white-space:nowrap;">
          <span style="display:inline-block;padding:4px 10px;border-radius:999px;background-color:#dcfce7;border:1px solid #bbf7d0;color:#166534;font-size:11px;font-weight:700;letter-spacing:0.02em;">Draft</span>
        </td>
        <td valign="middle" align="right" style="padding:14px 14px 14px 10px;border-bottom:1px solid #e2e8f0;white-space:nowrap;">
          <a href="${escapeHtml(item.admin_review_url)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:8px 13px;background-color:#0f172a;color:#ffffff;text-decoration:none;border-radius:6px;font-size:12px;font-weight:700;">Review in Shopify &rarr;</a>
        </td>
      </tr>`;
    })
    .join("");

  const avgMargin = totalRetailUsd > 0 ? ((totalProfitUsd / totalRetailUsd) * 100).toFixed(1) + "%" : "0%";
  const runDate = new Date().toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });

  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /></head>
<body style="margin:0;padding:0;background-color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f1f5f9;padding:28px 14px;">
    <tr>
      <td align="center">
        <table role="presentation" width="760" cellpadding="0" cellspacing="0" border="0" style="max-width:760px;width:100%;background-color:#ffffff;border:1px solid #cbd5e1;border-radius:12px;overflow:hidden;">
          <tr>
            <td style="background-color:#0f172a;padding:24px 28px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td valign="middle">
                    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#93c5fd;margin-bottom:4px;">Webskitters Automation Suite</div>
                    <h1 style="margin:0;font-size:20px;font-weight:700;color:#ffffff;">Shopify Catalog Enrichment Report</h1>
                    <div style="font-size:12.5px;color:#cbd5e1;margin-top:4px;">Gemini Vision AI &bull; 2.4x Margin Pricing &bull; ${escapeHtml(runDate)}</div>
                  </td>
                  <td valign="middle" align="right">
                    <span style="display:inline-block;background-color:#059669;color:#ffffff;font-size:12px;font-weight:700;padding:7px 14px;border-radius:999px;">Ready for Review</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background-color:#ecfdf5;border-bottom:1px solid #a7f3d0;padding:12px 28px;font-size:13px;color:#065f46;font-weight:600;">
              &#9989; ${count} product${count > 1 ? "s" : ""} enriched and saved in Shopify as <strong>Draft</strong> listings &bull; ${escapeHtml(alertStatus)}
            </td>
          </tr>
          <tr>
            <td style="padding:22px 28px 10px 28px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td width="24%" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;">
                    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;">Shopify Status</div>
                    <div style="font-size:20px;font-weight:800;color:#0f172a;margin-top:4px;">${count} Draft${count > 1 ? "s" : ""}</div>
                  </td>
                  <td width="1.3%"></td>
                  <td width="24%" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;">
                    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;">Total Retail Value</div>
                    <div style="font-size:20px;font-weight:800;color:#059669;margin-top:4px;">$${totalRetailUsd.toFixed(2)}</div>
                  </td>
                  <td width="1.3%"></td>
                  <td width="24%" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;">
                    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;">Est. Profit</div>
                    <div style="font-size:20px;font-weight:800;color:#047857;margin-top:4px;">$${totalProfitUsd.toFixed(2)}</div>
                  </td>
                  <td width="1.3%"></td>
                  <td width="24%" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;">
                    <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#64748b;">Avg Margin</div>
                    <div style="font-size:20px;font-weight:800;color:#1d4ed8;margin-top:4px;">${avgMargin}</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td style="padding:14px 28px 24px 28px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid #e2e8f0;border-radius:8px;overflow:hidden;">
                <thead>
                  <tr style="background-color:#f8fafc;">
                    <th align="left" style="padding:11px 12px;border-bottom:2px solid #e2e8f0;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#475569;">SKU</th>
                    <th align="left" style="padding:11px 12px;border-bottom:2px solid #e2e8f0;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#475569;">Product</th>
                    <th align="left" style="padding:11px 10px;border-bottom:2px solid #e2e8f0;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#475569;">Cost</th>
                    <th align="left" style="padding:11px 10px;border-bottom:2px solid #e2e8f0;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#475569;">Retail</th>
                    <th align="left" style="padding:11px 10px;border-bottom:2px solid #e2e8f0;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#475569;">Margin</th>
                    <th align="left" style="padding:11px 10px;border-bottom:2px solid #e2e8f0;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#475569;">Status</th>
                    <th align="right" style="padding:11px 14px;border-bottom:2px solid #e2e8f0;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#475569;">Action</th>
                  </tr>
                </thead>
                <tbody>${rowsHtml}</tbody>
              </table>
            </td>
          </tr>
          <tr>
            <td style="background-color:#f8fafc;border-top:1px solid #e2e8f0;padding:16px 28px;font-size:12px;color:#64748b;text-align:center;">
              Webskitters &bull; Shopify Project Automation Tool &mdash; Listings are saved in <strong>Draft</strong> mode for safe review prior to publishing.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

async function sendNotifications(items, notifyTarget, storeMeta = {}) {
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
        { type: "header", text: { type: "plain_text", text: `🚀 ${count} Supplier Product(s) Enriched as Shopify Drafts` } },
        ...succeeded.map((item) => ({
          type: "section",
          text: {
            type: "mrkdwn",
            text: `*${item.product_title}* (SKU: \`${item.sku}\`)\nWholesale: $${item.wholesale_cost} ➔ *Store Retail: ${formatMoney(item.store_retail_price, item.store_currency)}* (${item.gross_margin} margin)\n<${item.admin_review_url}|Review in Shopify Admin ↗>`,
          },
        })),
      ];
      await fetchJson(slackUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `Shopify Enrichment Complete: ${count} Draft(s)`, blocks }),
      });
      slackSent = true;
      alertStatus = "Slack Notification Sent ✅";
    } catch (err) {
      alertStatus = `Slack Alert Error: ${err.message}`;
    }
  }

  const htmlContent = buildEmailHtmlReport(succeeded, alertStatus, storeMeta);

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
    try { res.write(payload); } catch { job.subscribers.delete(res); }
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
    const startedAt = Date.now();
    updateState({ startedAt, status: "processing", stage: "downloading", stageLabel: "Preparing", notice: "Inspecting source image..." });

    const [imageInfo, shopCreds] = await Promise.all([
      prepareAndOptimizeImage(row, updateState),
      shopCredsPromise,
    ]);

    job.storeCurrency = shopCreds.currencyCode;
    job.fxRate = shopCreds.fxRate;

    updateState({
      status: "processing",
      stage: "ai",
      stageLabel: "AI Enriching",
      notice: imageInfo.optimizedFromMp
        ? `Optimized ${imageInfo.optimizedFromMp.toFixed(1)} MP image to ≤20MP. Running Gemini Vision AI analysis...`
        : "Analyzing product photo via Gemini Vision AI...",
    });

    const ai = await runGeminiVision(row, imageInfo.aiBase64, imageInfo.aiMime);
    const shopPayload = buildShopifyPayload(row, ai, shopCreds.currencyCode, shopCreds.fxRate);

    updateState({
      status: "processing",
      stage: "shopify",
      stageLabel: "Creating Draft",
      product_title: shopPayload.title,
      category: shopPayload.category,
      material: shopPayload.material,
      primary_color: shopPayload.primaryColor,
      wholesale_cost: shopPayload.pricing.wholesale_cost,
      retail_price: shopPayload.pricing.retail_price,
      compare_at_price: shopPayload.pricing.compare_at_price,
      profit_per_unit: shopPayload.pricing.profit_per_unit,
      gross_margin: shopPayload.pricing.gross_margin,
      store_currency: shopPayload.pricing.store_currency,
      fx_rate: shopPayload.pricing.fx_rate,
      store_retail_price: shopPayload.pricing.store_retail_price,
      store_compare_at_price: shopPayload.pricing.store_compare_at_price,
      price_rationale: shopPayload.priceRationale,
      notice: `Syncing Draft listing to Shopify store...`,
    });

    const created = await createShopifyDraft(shopCreds, shopPayload, imageInfo, updateState);
    job.completed += 1;

    updateState({
      status: "done",
      stage: "done",
      stageLabel: "Draft",
      notice: "",
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
      notice: err.message,
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
    storeCurrency: "INR",
    fxRate: FALLBACK_FX.INR,
    notifyTarget,
    alertStatus: "Processing batch...",
    emailSent: false,
    slackSent: false,
    emailRecipient: "",
    durationMs: 0,
    subscribers: new Set(),
    rows: rows.map((r, index) => {
      const prelim = r.has_explicit_cost ? computePricing(r.wholesale_cost, "INR", FALLBACK_FX.INR) : null;
      return {
        index,
        sku: r.sku,
        raw_name: r.raw_name,
        has_explicit_cost: r.has_explicit_cost,
        product_title: r.raw_name || "Detecting product from image...",
        wholesale_cost: prelim ? prelim.wholesale_cost : "",
        retail_price: prelim ? prelim.retail_price : "",
        compare_at_price: prelim ? prelim.compare_at_price : "",
        profit_per_unit: prelim ? prelim.profit_per_unit : "",
        gross_margin: prelim ? prelim.gross_margin : "",
        store_currency: "INR",
        fx_rate: FALLBACK_FX.INR,
        store_retail_price: prelim ? prelim.store_retail_price : "",
        store_compare_at_price: prelim ? prelim.store_compare_at_price : "",
        thumbnail_url: r.ai_image_url || r.image_url || "",
        category: "",
        material: "",
        primary_color: "",
        price_rationale: "",
        status: "pending",
        stage: "pending",
        stageLabel: "Pending",
        notice: "",
        startedAt: 0,
        admin_review_url: "",
        error: "",
      };
    }),
  };
  jobs.set(id, job);

  (async () => {
    const t0 = Date.now();
    try {
      const shopCredsPromise = getShopifyContext();
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
      const shopCreds = await shopCredsPromise;
      job.storeCurrency = shopCreds.currencyCode;
      job.fxRate = shopCreds.fxRate;

      emitJobEvent(job, "notifying", { message: "Dispatching Email / Slack Report..." });
      const notifyRes = await sendNotifications(job.rows, notifyTarget, shopCreds);
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
        try { res.end(); } catch {}
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
    storeCurrency: job.storeCurrency,
    fxRate: job.fxRate,
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

module.exports = {
  createAndRunJob,
  getJob,
  getPublicJobState,
  parseImageDimensions,
  parseWholesaleCost,
  computePricing,
  formatMoney,
  getImageUrls,
  runGeminiVision,
  buildShopifyPayload,
  buildEmailHtmlReport,
  ingestRows,
};
