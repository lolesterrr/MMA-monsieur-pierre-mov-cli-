// Can the deployed worker carry the video, even though the sources refuse its lookups?
// Finds fresh stream links from here (GitHub's servers, which the sources accept), then asks
// the worker's /api/reach whether it can fetch the playlist and a segment.
//   node tools/reach-check.mjs https://mma.example.workers.dev
import { createHandler } from "../worker/core.js";

const api = process.argv[2];
const found = [];
const handle = createHandler({
  upstream: (url, init, kind) => {
    if (kind === "media") found.push({ url, referer: (init.headers && init.headers.Referer) || "" });
    return fetch(url, init);
  },
});
const lines = [];
const cases = [
  ["movie", "videasy", "type=movie&imdb=tt1375666&tmdb=27205&title=Inception&year=2010"],
  ["movie", "lookmovie", "type=movie&imdb=tt1375666&tmdb=27205&title=Inception&year=2010"],
  ["movie", "hexa", "type=movie&imdb=tt1375666&tmdb=27205&title=Inception&year=2010"],
  ["movie", "autoembed", "type=movie&imdb=tt1375666&tmdb=27205&title=Inception&year=2010"],
  ["series", "autoembed", "type=series&imdb=tt0903747&tmdb=1396&title=Breaking%20Bad&year=2008&s=1&e=1"],
  ["series", "videasy", "type=series&imdb=tt0903747&tmdb=1396&title=Breaking%20Bad&year=2008&s=1&e=1"],
];
for (const [kind, server, q] of cases) {
  found.length = 0;
  const res = await handle(new Request(`https://local.test/api/sources?${q}&server=${server}`), { SIGNING_KEY: "x" });
  if (res.status !== 200) {
    lines.push(`${kind} on ${server}: no link even from GitHub (${(await res.json()).message})`);
    continue;
  }
  const first = found[0];
  // a segment: walk the playlist ourselves with the right referer
  const h = first.referer ? { Referer: first.referer, Origin: first.referer.replace(/\/$/, "") } : {};
  let text = await (await fetch(first.url, { headers: h })).text();
  let base = first.url;
  const pick = (t) => t.split("\n").filter((l) => l && !l.startsWith("#"));
  if (/#EXT-X-STREAM-INF/.test(text)) {
    base = new URL(pick(text).at(-1), base).href;
    text = await (await fetch(base, { headers: h })).text();
  }
  const seg = new URL(pick(text)[0], base).href;
  const ask = async (u) => (await fetch(`${api}/api/reach?u=${encodeURIComponent(u)}&ref=${encodeURIComponent(first.referer)}`)).json();
  const a = await ask(first.url);
  const b = await ask(seg);
  const ok = a.status === 200 && a.playlist && (b.status === 200 || b.status === 206) && b.bytes > 1000;
  lines.push(`${kind} on ${server}: worker gets the playlist HTTP ${a.status}${a.error ? ` (${a.error})` : ""}, a segment HTTP ${b.status} ${b.bytes || 0} bytes from ${new URL(seg).host} => ${ok ? "CLOUDFLARE CAN RELAY THIS" : "blocked"}`);
  // Could a browser on the MMA site play it straight from the host, skipping Cloudflare? That
  // takes CORS on the playlist and the segments, and no Referer the page can't send.
  const site = { Origin: "https://lolesterrr.github.io", Referer: "https://lolesterrr.github.io/" };
  const probe = async (u) => {
    try {
      const r = await fetch(u, { headers: { ...site, Range: "bytes=0-2047" } });
      const body = new Uint8Array(await r.arrayBuffer());
      return { status: r.status, bytes: body.length, cors: r.headers.get("access-control-allow-origin") || "none" };
    } catch (e) {
      return { status: 0, bytes: 0, cors: "none", error: e.message };
    }
  };
  const [pa, pb] = [await probe(first.url), await probe(seg)];
  const corsOk = (c) => c === "*" || c === site.Origin;
  const direct = pa.status < 300 && pb.status < 300 && pb.bytes > 1000 && corsOk(pa.cors) && corsOk(pb.cors);
  lines.push(`${kind} on ${server}, from a browser on the site: playlist HTTP ${pa.status} CORS ${pa.cors}, segment HTTP ${pb.status} ${pb.bytes} bytes CORS ${pb.cors} => ${direct ? "CAN PLAY DIRECT" : "no direct play"}`);
}
for (const l of lines) console.log(`::notice title=reach::${l}`);
