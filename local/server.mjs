#!/usr/bin/env node
// MMA local helper: the same worker code, running on your own computer, plus the web app.
//
// Use it when a source won't talk to Cloudflare's servers, when the worker is out of free
// requests for the day, or to work on MMA offline. Video goes through your own connection,
// so none of it counts against Cloudflare's limits.
//
//   node local/server.mjs                # then open http://localhost:8787
//   HOST=0.0.0.0 node local/server.mjs   # also reachable from your phone on the same Wi-Fi
//
// Environment: PORT (8787), HOST (127.0.0.1), GITHUB_TOKEN, GITHUB_REPO, SERVERS, CATALOG_URL,
// and the source overrides from worker/core.js (ENCDEC_URL, VIDEASY_URL, ...).

import http from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createHandler } from "../worker/core.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const WEB = resolve(here, "..", "web");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

function toRequest(req, origin) {
  const url = new URL(req.url, origin);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || k.startsWith(":")) continue;
    headers.set(k, Array.isArray(v) ? v.join(", ") : v);
  }
  if (!headers.has("cf-connecting-ip")) headers.set("CF-Connecting-IP", req.socket.remoteAddress || "local");
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, { method: req.method, headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: hasBody ? "half" : undefined });
}

async function sendResponse(res, response) {
  const headers = {};
  response.headers.forEach((v, k) => (headers[k] = v));
  res.writeHead(response.status, headers);
  if (!response.body) return res.end();
  const stream = Readable.fromWeb(response.body);
  res.on("close", () => stream.destroy());
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

async function serveStatic(req, res, local) {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/config.js") {
    // point the app at this helper instead of the worker in web/config.js
    res.writeHead(200, { "Content-Type": TYPES[".js"], "Cache-Control": "no-store" });
    return res.end(`window.MMA_CONFIG = Object.assign({}, window.MMA_CONFIG, ${JSON.stringify(local)}, { api: location.origin });\n`);
  }
  let path = decodeURIComponent(url.pathname);
  if (path.endsWith("/")) path += "index.html";
  const file = normalize(join(WEB, path));
  if (!file.startsWith(WEB + sep) && file !== WEB) {
    res.writeHead(403);
    return res.end();
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Cache-Control": "no-cache" });
    return res.end(req.method === "HEAD" ? undefined : body);
  } catch {
    res.writeHead(404, { "Content-Type": TYPES[".txt"] });
    return res.end("Not found");
  }
}

/**
 * startLocal({ port, host, env, catalog }) -> { url, server, close }
 * env is the worker's env (SIGNING_KEY, GITHUB_TOKEN, source overrides, ...).
 * catalog swaps the Cinemeta address the app uses (the offline demo points it at a fake).
 */
export async function startLocal({ port = 8787, host = "127.0.0.1", env = {}, catalog = "" } = {}) {
  const workerEnv = { SIGNING_KEY: randomBytes(24).toString("hex"), ALLOWED_ORIGINS: "*", ...env };
  const handle = createHandler();
  const server = http.createServer(async (req, res) => {
    try {
      const path = req.url.split("?")[0];
      if (path === "/p" || path === "/m" || path.startsWith("/api/") || path === "/api") {
        const origin = `http://${req.headers.host || `${host}:${port}`}`;
        return await sendResponse(res, await handle(toRequest(req, origin), workerEnv));
      }
      return await serveStatic(req, res, catalog ? { local: true, catalog } : { local: true });
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": TYPES[".txt"] });
      res.end("Local helper error");
    }
  });
  await new Promise((done, fail) => {
    server.once("error", fail);
    server.listen(port, host, done);
  });
  const actual = server.address().port;
  const shown = host === "0.0.0.0" ? "localhost" : host;
  return { url: `http://${shown}:${actual}`, server, close: () => new Promise((r) => server.close(r)) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const env = {};
  for (const k of ["GITHUB_TOKEN", "GITHUB_REPO", "GITHUB_API", "SERVERS", "TOKEN_TTL", "COMPLAINTS_PER_10_MIN", "HEALTH_TITLE", "ENCDEC_URL", "VIDEASY_URL", "LOOKMOVIE_URL", "HEXA_URL", "AUTOEMBED_URL", "VIDLINK_URL", "SUBS_URL"]) {
    if (process.env[k]) env[k] = process.env[k];
  }
  const app = await startLocal({ port: Number(process.env.PORT) || 8787, host: process.env.HOST || "127.0.0.1", env, catalog: process.env.CATALOG_URL || "" });
  console.log(`\n  Monsieur Pierre is up: ${app.url}\n`);
  console.log("  Checking the sources (takes a few seconds)…");
  try {
    const res = await fetch(`${app.url}/api/health?deep=1`);
    const h = await res.json();
    for (const [k, v] of Object.entries(h.sources || {})) console.log(`  ${k.padEnd(10)} ${v.ok ? "plays" : `no: ${v.message}`}`);
    console.log(`  complaints ${h.complaints ? "filed as GitHub issues" : "open a prefilled GitHub issue (set GITHUB_TOKEN to file them directly)"}\n`);
  } catch (e) {
    console.log(`  couldn't run the self-check: ${e.message}\n`);
  }
}
