const fs = require("fs");
const path = require("path");
const http = require("http");
const net = require("net");
const { createAndRunJob, getJob, getPublicJobState } = require("./engine");

const LISTEN_PORT = parseInt(process.env.PORT || "10000", 10);
const N8N_PORT = parseInt(process.env.N8N_PORT || "5678", 10);
const STARTED_AT = Date.now();

const UI_HTML = fs.readFileSync(path.join(__dirname, "ui.html"), "utf8");

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 1024 * 1024) {
        req.destroy();
        return reject(new Error("Payload too large"));
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow",
  });
  res.end(JSON.stringify(data));
}

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
    res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Upstream n8n warming up, please refresh in a moment.");
  });
  req.pipe(upstream);
}

const server = http.createServer(async (req, res) => {
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
        res.end('{"status":"ok"}');
      } else {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end('{"status":"error"}');
      }
    });
    return;
  }

  // Real-time Streaming Automation API endpoints
  if (urlPath === "/api/jobs" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const jobState = await createAndRunJob(body);
      return sendJson(res, 201, jobState);
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  const streamMatch = urlPath.match(/^\/api\/jobs\/([a-f0-9]+)\/stream$/);
  if (streamMatch && req.method === "GET") {
    const job = getJob(streamMatch[1]);
    if (!job) return sendJson(res, 404, { error: "Job not found" });

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write(`: ${" ".repeat(2048)}\n\n`);
    res.write(`event: snapshot\ndata: ${JSON.stringify(getPublicJobState(job))}\n\n`);

    if (job.status === "completed" || job.status === "failed") {
      res.write(`event: complete\ndata: ${JSON.stringify(getPublicJobState(job))}\n\n`);
      return res.end();
    }

    job.subscribers.add(res);
    const keepalive = setInterval(() => {
      try { res.write(": ping\n\n"); } catch { clearInterval(keepalive); }
    }, 5000);

    req.on("close", () => {
      clearInterval(keepalive);
      job.subscribers.delete(res);
    });
    return;
  }

  const pollMatch = urlPath.match(/^\/api\/jobs\/([a-f0-9]+)$/);
  if (pollMatch && req.method === "GET") {
    const job = getJob(pollMatch[1]);
    if (!job) return sendJson(res, 404, { error: "Job not found" });
    return sendJson(res, 200, getPublicJobState(job));
  }

  // Serve full-page Webskitters App UI on "/", "/form/supplier-demo-form", and n8n Editor's "/form-test/*"
  const cookie = req.headers.cookie || "";
  if (
    req.method === "GET" &&
    (urlPath === "/form/supplier-demo-form" ||
      urlPath.startsWith("/form-test/") ||
      (urlPath === "/" && !cookie.includes("n8n-auth=")))
  ) {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "X-Robots-Tag": "noindex, nofollow",
      "Cache-Control": "no-store",
    });
    return res.end(UI_HTML);
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
  console.log(`[Proxy] Webskitters Automation UI + n8n Proxy listening on 0.0.0.0:${LISTEN_PORT}`);
});
