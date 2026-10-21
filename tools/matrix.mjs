// Runs every StreamViva source against a movie and a show, follows embeds, and checks
// whether the stream it returns actually loads (playlist and first segment), with and
// without the headers the source asks for. Also checks Cinemeta for search and episodes.
//   node tools/matrix.mjs /path/to/streamviva-providers
import { mkdirSync, writeFileSync } from "node:fs";

const lib = process.argv[2] || "./svp";
const { makeProviders, makeStandardFetcher, targets } = await import(`${lib}/lib/index.js`);
mkdirSync("probe-out", { recursive: true });
const out = [];
const log = (...a) => { const s = a.join(" "); console.log(s); out.push(s); };

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms))]);
const fetcher = makeStandardFetcher(fetch);
const stack = makeProviders({ fetcher, proxiedFetcher: fetcher, target: targets.ANY, consistentIpForRequests: true });

const media = [
  { label: "Inception", media: { type: "movie", title: "Inception", releaseYear: 2010, tmdbId: "27205", imdbId: "tt1375666" } },
  { label: "BreakingBad", media: { type: "show", title: "Breaking Bad", releaseYear: 2008, tmdbId: "1396", imdbId: "tt0903747", season: { number: 1, tmdbId: "3572", title: "Season 1" }, episode: { number: 1, tmdbId: "62085" } } },
];

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
async function check(url, headers = {}) {
  try {
    const r = await withTimeout(fetch(url, { headers: { "User-Agent": UA, ...headers } }), 15000);
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, len: buf.length, text: buf.subarray(0, 200000).toString("utf8"), url: r.url, ct: r.headers.get("content-type"), acao: r.headers.get("access-control-allow-origin") };
  } catch (e) {
    return { status: 0, len: 0, text: "", err: e.message };
  }
}

async function testStream(tag, s) {
  if (s.type === "iframe") return log(`    ${tag} iframe ${s.url}`);
  if (s.type === "file") {
    const q = Object.entries(s.qualities || {})[0];
    if (!q) return log(`    ${tag} file, no qualities`);
    const u = q[1].url;
    const a = await check(u, { ...(s.headers || {}), Range: "bytes=0-1023" });
    const b = await check(u, { Range: "bytes=0-1023" });
    return log(`    ${tag} file ${q[0]} ${u.slice(0, 120)} | with headers ${a.status} ${a.ct} | bare ${b.status} | acao ${b.acao} | headers ${JSON.stringify(s.headers || {})}`);
  }
  const pl = s.playlist;
  const a = await check(pl, s.headers || {});
  const b = await check(pl);
  let seg = "";
  if (a.status === 200 && a.text.startsWith("#EXTM3U")) {
    let media = a, base = a.url || pl;
    const variant = a.text.split("\n").find((l) => l && !l.startsWith("#"));
    if (/#EXT-X-STREAM-INF/.test(a.text) && variant) {
      const vu = new URL(variant, base).href;
      media = await check(vu, s.headers || {});
      base = media.url || vu;
    }
    const segLine = media.text.split("\n").find((l) => l && !l.startsWith("#"));
    if (segLine) {
      const su = new URL(segLine, base).href;
      const sa = await check(su, s.headers || {});
      const sb = await check(su);
      const sc = await check(su, { Referer: "https://lolesterrr.github.io/", Origin: "https://lolesterrr.github.io" });
      seg = ` | segment ${new URL(su).host}: headers ${sa.status}/${sa.len}b, bare ${sb.status}, github-origin ${sc.status}, acao ${sb.acao}, key ${/#EXT-X-KEY/.test(media.text)}`;
    }
  }
  log(`    ${tag} hls ${pl.slice(0, 140)} | playlist with headers ${a.status}, bare ${b.status}, acao ${b.acao}${seg} | headers ${JSON.stringify(s.headers || {})} | captions ${(s.captions || []).length}`);
}

for (const t of media) {
  log(`\n=== ${t.label}`);
  for (const src of stack.listSources()) {
    if (src.mediaTypes && !src.mediaTypes.includes(t.media.type)) continue;
    const t0 = Date.now();
    try {
      const res = await withTimeout(stack.runSourceScraper({ id: src.id, media: t.media }), 30000);
      const ms = Date.now() - t0;
      log(`  ${src.id} (rank ${src.rank}) OK ${ms}ms: ${res.stream?.length || 0} streams, ${res.embeds?.length || 0} embeds`);
      for (const s of res.stream || []) await testStream(src.id, s);
      for (const e of (res.embeds || []).slice(0, 3)) {
        try {
          const er = await withTimeout(stack.runEmbedScraper({ id: e.embedId, url: e.url }), 30000);
          for (const s of er.stream || []) await testStream(`${src.id}>${e.embedId}`, s);
        } catch (err) {
          log(`    ${src.id}>${e.embedId} embed failed: ${String(err.message).slice(0, 100)}`);
        }
      }
    } catch (e) {
      log(`  ${src.id} (rank ${src.rank}) FAIL ${Date.now() - t0}ms: ${String(e.message).slice(0, 100)}`);
    }
  }
}

log("\n=== Cinemeta");
for (const u of [
  "https://v3-cinemeta.strem.io/catalog/movie/top/search=inception.json",
  "https://v3-cinemeta.strem.io/catalog/series/top/search=breaking%20bad.json",
  "https://v3-cinemeta.strem.io/meta/series/tt0903747.json",
  "https://v3-cinemeta.strem.io/meta/movie/tt1375666.json",
]) {
  const r = await check(u);
  log(`  ${r.status} ${r.len}b acao ${r.acao} <- ${u}`);
  writeFileSync(`probe-out/cinemeta-${u.split("/").slice(-2).join("-").replace(/[^a-z0-9.-]/gi, "_")}`, r.text);
}
writeFileSync("probe-out/matrix.txt", out.join("\n"));
