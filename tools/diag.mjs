// Probe the deployed worker and Deno helper the way the site does, several times per server,
// down to a video segment. Writes diag-out.json.
import { writeFileSync } from "node:fs";
const WORKER = "https://mma.kajjabwangulester.workers.dev";
const DENO = "https://mma-monsieur-pierre-mov-cli.lolesterrr.deno.net";
const SITE = "https://lolesterrr.github.io";
const H = { Origin: SITE, Referer: SITE + "/" };
const out = { at: new Date().toISOString(), health: {}, runs: [] };

async function timed(url, opts = {}, ms = 50000) {
  const t = Date.now();
  try {
    const r = await fetch(url, { ...opts, headers: { ...H, ...(opts.headers || {}) }, signal: AbortSignal.timeout(ms) });
    const buf = new Uint8Array(await r.arrayBuffer());
    return { status: r.status, ms: Date.now() - t, bytes: buf.length, text: () => new TextDecoder().decode(buf), cors: r.headers.get("access-control-allow-origin") };
  } catch (e) {
    return { status: 0, ms: Date.now() - t, error: e.name === "TimeoutError" ? "timeout" : e.message, bytes: 0, text: () => "" };
  }
}
const lines = (t) => t.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

async function walk(url) {
  // master -> last variant -> first segment
  const a = await timed(url, {}, 20000);
  const res = { playlist: a.status, playlistMs: a.ms, cors: a.cors };
  if (a.status >= 300 || !a.text().startsWith("#EXTM3U")) return { ...res, ok: false, why: `playlist ${a.status} ${a.error || a.text().slice(0, 60)}` };
  let text = a.text(), base = url;
  if (/#EXT-X-STREAM-INF/.test(text)) {
    base = new URL(lines(text).at(-1), base).href;
    const v = await timed(base, {}, 20000);
    if (v.status >= 300) return { ...res, ok: false, why: `variant ${v.status}` };
    text = v.text();
  }
  const seg = new URL(lines(text)[0], base).href;
  const s = await timed(seg, { headers: { Range: "bytes=0-65535" } }, 20000);
  return { ...res, segment: s.status, segBytes: s.bytes, segMs: s.ms, segCors: s.cors, segHost: new URL(seg).host, ok: s.status < 300 && s.bytes > 1000 };
}

async function cine(type, q) {
  const r = await fetch(`https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(q)}.json`);
  const m = ((await r.json()).metas || [])[0];
  const d = await (await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${m.imdb_id || m.id}.json`)).json();
  return d.meta;
}
const inception = await cine("movie", "Inception");
const rehearsal = await cine("series", "The Rehearsal");
const bb = await cine("series", "Breaking Bad");
out.titles = [inception, rehearsal, bb].map((m) => `${m.name} ${m.imdb_id} tmdb ${m.moviedb_id}`);
const q = (m, type, s, e) => `type=${type}&imdb=${m.imdb_id}&tmdb=${m.moviedb_id || ""}&title=${encodeURIComponent(m.name)}&year=${(String(m.releaseInfo || m.year).match(/\d{4}/) || [""])[0]}${s ? `&s=${s}&e=${e}` : ""}`;
const cases = [
  ["Inception", q(inception, "movie")],
  ["Rehearsal S1E1", q(rehearsal, "series", 1, 1)],
  ["Rehearsal S2E1", q(rehearsal, "series", 2, 1)],
  ["Breaking Bad S1E1", q(bb, "series", 1, 1)],
];

for (const [name, base] of [["worker", WORKER], ["deno", DENO]]) {
  const h = await timed(`${base}/api/health`, {}, 15000);
  const d = await timed(`${base}/api/health?deep=1`, {}, 60000);
  let hj = null, dj = null;
  try { hj = JSON.parse(h.text()); } catch {}
  try { dj = JSON.parse(d.text()); } catch {}
  out.health[name] = { status: h.status, version: hj && hj.version, servers: hj && hj.servers, deep: dj && dj.sources, deepStatus: d.status, deepMs: d.ms };
}

for (const [label, query] of cases) {
  const servers = label === "Inception" ? ["auto", "videasy", "lookmovie", "hexa", "autoembed"] : ["auto", "videasy", "hexa", "autoembed"];
  for (const server of servers) {
    for (const [name, base] of [["worker", WORKER], ["deno", DENO]]) {
      for (let i = 0; i < 3; i++) {
        const r = await timed(`${base}/api/sources?${query}&server=${server}${i ? "&fresh=1" : ""}`, {}, 50000);
        let j = {};
        try { j = JSON.parse(r.text()); } catch {}
        const run = { title: label, server, via: name, try: i + 1, status: r.status, ms: r.ms, got: j.server || null, error: j.error || r.error || null, message: j.message ? j.message.slice(0, 300) : null, tried: (j.tried || []).map((t) => `${t.server}:${t.error}:${(t.message || "").slice(0, 120)}`) };
        if (j.master) run.relay = await walk(j.master);
        if (j.direct) run.direct = await walk(j.direct);
        out.runs.push(run);
        console.log(JSON.stringify(run));
      }
    }
  }
}
writeFileSync("diag-out.json", JSON.stringify(out, null, 1));
