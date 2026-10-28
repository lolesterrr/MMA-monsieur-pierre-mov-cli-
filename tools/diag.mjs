import { writeFileSync } from "node:fs";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const out = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, { headers = {}, method = "GET", body, ms = 20000 } = {}) {
  const t = Date.now();
  try {
    const r = await fetch(url, { method, body, headers: { "User-Agent": UA, Accept: "*/*", ...headers }, signal: AbortSignal.timeout(ms) });
    const text = await r.text();
    return { status: r.status, ms: Date.now() - t, text, cors: r.headers.get("access-control-allow-origin"), server: r.headers.get("server") };
  } catch (e) {
    return { status: 0, ms: Date.now() - t, text: "", error: e.message };
  }
}
const j = (r) => { try { return JSON.parse(r.text); } catch { return null; } };
const brief = (r) => ({ status: r.status, ms: r.ms, error: r.error, head: r.text.slice(0, 200) });
const lines = (t) => t.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
async function walk(url, headers) {
  const a = await get(url, { headers });
  if (a.status >= 300 || !a.text.trimStart().startsWith("#EXTM3U")) return { ok: false, playlist: brief(a) };
  let text = a.text, base = url;
  if (/#EXT-X-STREAM-INF/.test(text)) { base = new URL(lines(text).at(-1), base).href; text = (await get(base, { headers })).text; }
  const seg = new URL(lines(text)[0], base).href;
  const s = await fetch(seg, { headers: { "User-Agent": UA, Range: "bytes=0-65535", ...headers } }).then(async (r) => ({ status: r.status, bytes: (await r.arrayBuffer()).byteLength, cors: r.headers.get("access-control-allow-origin") })).catch((e) => ({ status: 0, error: e.message }));
  return { ok: s.status < 300 && s.bytes > 1000, playlistCors: a.cors, seg: s, segHost: new URL(seg).host };
}

// 1. Videasy: old vs new referer
out.videasy = {};
for (const ref of ["https://player.videasy.to/", "https://vidy.st/"]) {
  const H = { Origin: ref.slice(0, -1), Referer: ref };
  const seed = await get("https://api.wecollege.net/seed?mediaId=27205", { headers: H });
  const res = { seed: brief(seed) };
  const sd = j(seed);
  if (sd && sd.seed) {
    res.servers = {};
    for (const server of ["miami", "boise", "vegas", "reno", "oakland"]) {
      const q = `title=${encodeURIComponent(encodeURIComponent("Inception"))}&mediaType=movie&year=2010&tmdbId=27205&imdbId=tt1375666&enc=2&seed=${encodeURIComponent(sd.seed)}`;
      const enc = await get(`https://api.wecollege.net/${server}/sources?${q}`, { headers: H });
      const r = { enc: { status: enc.status, len: enc.text.length, head: enc.text.slice(0, 80) } };
      if (enc.status === 200 && enc.text.length > 20) {
        const dec = await get("https://enc-dec.app/api/dec-videasy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: enc.text, id: "27205", seed: sd.seed }) });
        const dj = j(dec);
        r.dec = { status: dec.status, apiStatus: dj && dj.status, sources: dj && dj.result && (dj.result.sources || []).length };
        const first = dj && dj.result && ((dj.result.sources || [])[0] || {}).url;
        if (first) r.play = await walk(first, H);
      }
      res.servers[server] = r;
    }
  }
  out.videasy[ref] = res;
}

// 2. Hexa: 15 runs, which step fails
out.hexa = [];
for (let i = 0; i < 15; i++) {
  const run = {};
  const tok = await get("https://enc-dec.app/api/enc-hexa");
  const tj = j(tok);
  run.encHexa = { status: tok.status, api: tj && tj.status, ms: tok.ms, err: tj && tj.error, head: tj ? undefined : tok.text.slice(0, 80) };
  const token = tj && tj.result && tj.result.token;
  if (token) {
    const key = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const enc = await get("https://theemoviedb.hexa.su/api/tmdb/movie/27205/images", { headers: { Referer: "https://hexa.su/", Accept: "text/plain", "X-Fingerprint-Lite": "e9136c41504646444", "X-Api-Key": key, "X-Cap-Token": token } });
    run.images = { status: enc.status, len: enc.text.length, ms: enc.ms };
    const dec = await get("https://enc-dec.app/api/dec-hexa", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: enc.text, key }) });
    const dj = j(dec);
    run.decHexa = { status: dec.status, api: dj && dj.status, err: dj && dj.error, n: dj && dj.result && (dj.result.sources || []).length };
  }
  out.hexa.push(run);
  await sleep(500);
}

// 3. VidLink: Inception, Rehearsal S1E1, Breaking Bad S1E1
out.vidlink = {};
const VL = { Origin: "https://vidlink.pro", Referer: "https://vidlink.pro/" };
for (const [name, type, tmdb, s, e] of [["Inception", "movie", "27205"], ["Rehearsal S1E1", "tv", "204284", 1, 1], ["Rehearsal S2E1", "tv", "204284", 2, 1], ["Breaking Bad S1E1", "tv", "1396", 1, 1]]) {
  const enc = await get(`https://enc-dec.app/api/enc-vidlink?text=${tmdb}`);
  const ej = j(enc);
  const r = { enc: { status: enc.status, api: ej && ej.status, err: ej && ej.error } };
  const id = ej && ej.result;
  if (id) {
    const url = `https://vidlink.pro/api/b/${type}/${encodeURIComponent(id)}${type === "tv" ? `/${s}/${e}` : ""}`;
    const d = await get(url, { headers: VL });
    r.api = { status: d.status, ms: d.ms, head: d.text.slice(0, 1500) };
    const dj = j(d);
    const pl = dj && dj.stream && (dj.stream.playlist || (dj.stream.qualities && Object.values(dj.stream.qualities)[0]?.url));
    if (pl) {
      r.withReferer = await walk(pl, VL);
      r.noReferer = await walk(pl, {});
      r.fromSite = await walk(pl, { Origin: "https://lolesterrr.github.io", Referer: "https://lolesterrr.github.io/" });
    }
  }
  out.vidlink[name] = r;
}
writeFileSync("diag-out.json", JSON.stringify(out, null, 1));
console.log(JSON.stringify(out).slice(0, 3000));
