const http = require("http");
const net = require("net");

const LISTEN_PORT = parseInt(process.env.PORT || "10000", 10);
const N8N_PORT = parseInt(process.env.N8N_PORT || "5678", 10);
const STARTED_AT = Date.now();

const LANDING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Catalog Sync Studio</title>
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;color:#0f172a;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px;}
    .card{background:#fff;border:1px solid #e2e8f0;border-radius:16px;padding:36px;max-width:520px;box-shadow:0 10px 25px rgba(15,23,42,.06);text-align:center;}
    h1{margin:0 0 12px;font-size:24px;}
    p{margin:0 0 24px;color:#475569;line-height:1.5;}
    a.btn{display:inline-block;background:#0f172a;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:600;}
    a.btn:hover{background:#1e293b;}
  </style>
</head>
<body>
  <div class="card">
    <h1>Catalog Sync Studio</h1>
    <p>Automated supplier product enrichment and catalog synchronization workspace.</p>
    <a class="btn" href="/form/supplier-demo-form">Open Enrichment Form</a>
  </div>
</body>
</html>`;

const WARMING_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="refresh" content="5" />
  <meta name="robots" content="noindex, nofollow" />
  <title>Catalog Sync Studio — Starting</title>
  <style>
    body{font-family:system-ui,sans-serif;background:#f8fafc;color:#0f172a;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;}
    .box{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:28px 32px;text-align:center;max-width:440px;}
  </style>
</head>
<body>
  <div class="box">
    <h2 style="margin:0 0 8px;">Starting Workspace...</h2>
    <p style="margin:0;color:#475569;">Please wait a moment, this page refreshes automatically every 5 seconds.</p>
  </div>
</body>
</html>`;

function proxyToN8n(req, res) {
  const headers = { ...req.headers };
  headers["x-forwarded-for"] = headers["x-forwarded-for"] || req.socket.remoteAddress || "127.0.0.1";
  headers["x-forwarded-proto"] = headers["x-forwarded-proto"] || "https";
  if (req.headers.host) headers["x-forwarded-host"] = req.headers.host;

  const upstream = http.request(
    { hostname: "127.0.0.1", port: N8N_PORT, path: req.url, method: req.method, headers, timeout: 180000 },
    (upRes) => {
      const outHeaders = { ...upRes.headers, "x-robots-tag": "noindex, nofollow" };
      res.writeHead(upRes.statusCode || 502, outHeaders);
      upRes.pipe(res);
    }
  );
  upstream.on("error", () => {
    if (res.headersSent) return;
    if (req.method === "GET" && Date.now() - STARTED_AT < 180000) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(WARMING_HTML);
    } else {
      res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Service temporarily unavailable");
    }
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  const urlPath = (req.url || "/").split("?")[0];

  if (urlPath === "/robots.txt") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("User-agent: *\nDisallow: /\n");
  }

  if (urlPath === "/healthz") {
    const hReq = http.get(
      { hostname: "127.0.0.1", port: N8N_PORT, path: "/healthz", timeout: 2500 },
      (hRes) => {
        hRes.resume();
        res.writeHead(hRes.statusCode || 200, { "Content-Type": "application/json" });
        res.end('{"status":"ok"}');
      }
    );
    hReq.on("timeout", () => { hReq.destroy(Object.assign(new Error("BUSY"), { code: "ETIMEDOUT" })); });
    hReq.on("error", (err) => {
      if (res.headersSent) return;
      if (Date.now() - STARTED_AT < 180000 || err.code !== "ECONNREFUSED") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end('{"status":"warming"}');
      } else {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end('{"status":"error"}');
      }
    });
    return;
  }

  // Keep "/" as a neutral portal landing page unless user already has an authenticated n8n session
  const cookie = req.headers.cookie || "";
  if (urlPath === "/" && !cookie.includes("n8n-auth=")) {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "X-Robots-Tag": "noindex, nofollow",
      "Cache-Control": "no-store",
    });
    return res.end(LANDING_HTML);
  }

  proxyToN8n(req, res);
});

server.on("upgrade", (req, clientSocket, head) => {
  const target = net.connect(N8N_PORT, "127.0.0.1", () => {
    let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (const [k, v] of Object.entries(req.headers)) raw += `${k}: ${v}\r\n`;
    raw += "\r\n";
    target.write(raw);
    if (head && head.length) target.write(head);
    target.pipe(clientSocket);
    clientSocket.pipe(target);
  });
  target.on("error", () => clientSocket.destroy());
  clientSocket.on("error", () => target.destroy());
});

server.listen(LISTEN_PORT, "0.0.0.0", () => {
  console.log(`[Proxy] Listening on 0.0.0.0:${LISTEN_PORT} -> 127.0.0.1:${N8N_PORT}`);
});
