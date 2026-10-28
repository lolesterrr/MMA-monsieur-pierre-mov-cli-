import { writeFileSync } from "node:fs";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const out = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, { headers = {}, method = "GET", body, ms = 20000, ua = UA } = {}) {
  const t = Date.now();
  try {
    const r = await fetch(url, { method, body, headers: { "User-Agent": ua, Accept: "*/*", ...headers }, signal: AbortSignal.timeout(ms) });
    const buf = new Uint8Array(await r.arrayBuffer());
    return { status: r.status, ms: Date.now() - t, bytes: buf.length, text: new TextDecoder().decode(buf.slice(0, 200000)), cors: r.headers.get("access-control-allow-origin"), type: r.headers.get("content-type"), range: r.headers.get("content-range") };
  } catch (e) {
    return { status: 0, ms: Date.now() - t, text: "", error: e.message };
  }
}
const j = (r) => { try { return JSON.parse(r.text); } catch { return null; } };
const lines = (t) => t.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
async function walk(url, headers) {
  const a = await get(url, { headers });
  if (a.status >= 300 || !a.text.trimStart().startsWith("#EXTM3U")) return { ok: false, playlist: a.status, head: a.text.slice(0, 80) };
  let text = a.text, base = url;
  if (/#EXT-X-STREAM-INF/.test(text)) { base = new URL(lines(text).at(-1), base).href; const v = await get(base, { headers }); text = v.text; if (v.status >= 300) return { ok: false, variant: v.status }; }
  const seg = new URL(lines(text)[0], base).href;
  const s = await get(seg, { headers: { Range: "bytes=0-65535", ...headers } });
  return { ok: s.status < 300 && s.bytes > 1000, playlistCors: a.cors, seg: s.status, bytes: s.bytes, segCors: s.cors, host: new URL(seg).host };
}
const SITE = { Origin: "https://lolesterrr.github.io", Referer: "https://lolesterrr.github.io/" };

// 1. hexa token reuse: one token, 4 requests (two titles)
{
  const tj = j(await get("https://enc-dec.app/api/enc-hexa"));
  const token = tj && tj.result && tj.result.token;
  out.hexaReuse = { gotToken: Boolean(token), err: tj && tj.error };
  if (token) {
    out.hexaReuse.uses = [];
    for (const path of ["movie/27205", "movie/27205", "tv/1396/season/1/episode/1", "tv/204284/season/1/episode/1"]) {
      const key = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
      const enc = await get(`https://theemoviedb.hexa.su/api/tmdb/${path}/images`, { headers: { Referer: "https://hexa.su/", Accept: "text/plain", "X-Fingerprint-Lite": "e9136c41504646444", "X-Api-Key": key, "X-Cap-Token": token } });
      const dj = j(await get("https://enc-dec.app/api/dec-hexa", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: enc.text, key }) }));
      out.hexaReuse.uses.push({ path, images: enc.status, len: enc.bytes, dec: dj && dj.status, err: dj && dj.error, n: dj && dj.result && (dj.result.sources || []).length });
      await sleep(300);
    }
  }
}
// 2. enc-hexa rate limit shape: 20 calls 250ms apart, then wait and probe recovery
out.rate = [];
for (let i = 0; i < 20; i++) { const r = await get("https://enc-dec.app/api/enc-hexa"); out.rate.push(`${Date.now() % 100000}:${r.status}`); await sleep(250); }
for (const wait of [1000, 2000, 4000]) { await sleep(wait); const r = await get("https://enc-dec.app/api/enc-hexa"); out.rate.push(`after ${wait}: ${r.status}`); }

// 3. videasy direct from the site
{
  const H = { Origin: "https://vidy.st", Referer: "https://vidy.st/" };
  const sd = j(await get("https://api.wecollege.net/seed?mediaId=1396", { headers: H }));
  out.videasyDirect = {};
  for (const server of ["miami", "vegas", "reno"]) {
    const q = `title=${encodeURIComponent(encodeURIComponent("Breaking Bad"))}&mediaType=tv&year=2008&episodeId=1&seasonId=1&tmdbId=1396&imdbId=tt0903747&enc=2&seed=${encodeURIComponent(sd.seed)}`;
    const enc = await get(`https://api.wecollege.net/${server}/sources?${q}`, { headers: H });
    const dj = j(await get("https://enc-dec.app/api/dec-videasy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: enc.text, id: "1396", seed: sd.seed }) }));
    const first = dj && dj.result && ((dj.result.sources || [])[0] || {}).url;
    out.videasyDirect[server] = first ? { withReferer: await walk(first, H), fromSite: await walk(first, SITE), noHeaders: await walk(first, {}) } : { none: enc.status, dec: dj && (dj.error || dj.status) };
  }
}
// 4. vidlink mp4 with the headers it names
{
  const VL = { Origin: "https://vidlink.pro", Referer: "https://vidlink.pro/" };
  out.vidlinkMp4 = {};
  for (const [name, type, tmdb, s, e] of [["Rehearsal S1E1", "tv", "204284", 1, 1], ["Inception", "movie", "27205"]]) {
    const id = (j(await get(`https://enc-dec.app/api/enc-vidlink?text=${tmdb}`)) || {}).result;
    const d = j(await get(`https://vidlink.pro/api/b/${type}/${encodeURIComponent(id)}${type === "tv" ? `/${s}/${e}` : ""}`, { headers: VL }));
    const qs = (d && d.stream && d.stream.qualities) || {};
    const res = {};
    for (const [q, v] of Object.entries(qs)) {
      const hdr = v.headers || {};
      const appUa = hdr["User-Agent"];
      res[q] = {
        codec: v.codecName,
        appHeaders: (await get(v.url, { headers: { Range: "bytes=0-65535", ...(hdr.Accept ? { Accept: hdr.Accept } : {}) }, ua: appUa || UA })).status,
        appHeadersNoRef: undefined,
        browserUa: (await get(v.url, { headers: { Range: "bytes=0-65535" } })).status,
        fromSite: await get(v.url, { headers: { Range: "bytes=0-65535", ...SITE } }).then((r) => `${r.status} cors=${r.cors} ${r.type} ${r.range}`),
        vidlinkRef: (await get(v.url, { headers: { Range: "bytes=0-65535", ...VL } })).status,
      };
    }
    out.vidlinkMp4[name] = { sourceId: d && d.sourceId, res };
  }
}
writeFileSync("diag-out.json", JSON.stringify(out, null, 1));
