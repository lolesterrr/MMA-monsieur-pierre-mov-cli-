// Runs the worker code (not a deployed worker) against the real sources and walks each stream
// through the relay down to a video segment. Used by the "Check the sources" workflow.
//   node tools/live-check.mjs [imdb-movie] [imdb-series s e]
import { createHandler } from "../worker/core.js";

const handle = createHandler();
const env = { SIGNING_KEY: "live-check", ALLOWED_ORIGINS: "*" };
const ask = async (path, init) => {
  const res = await handle(new Request(`https://mma.test${path}`, init), env);
  return { status: res.status, headers: res.headers, body: res };
};
const lines = [];
const log = (s) => {
  console.log(s);
  lines.push(s);
};
let failures = 0;

async function meta(type, imdb) {
  const r = await fetch(`https://v3-cinemeta.strem.io/meta/${type}/${imdb}.json`);
  return (await r.json()).meta;
}

async function walk(label, query) {
  const t = Date.now();
  const r = await ask(`/api/sources?${query}`);
  const data = await r.body.json();
  if (r.status !== 200) {
    log(`${label}: HTTP ${r.status} ${data.error}: ${data.message}`);
    return false;
  }
  log(`${label}: ${data.name} in ${Date.now() - t}ms, ${data.subtitles.length} subtitles, direct ${Boolean(data.direct)}, tried before: ${data.tried.map((x) => `${x.name} (${x.message})`).join("; ") || "none"}`);
  const master = await (await ask(data.master.replace("https://mma.test", ""))).body.text();
  if (!master.startsWith("#EXTM3U")) {
    log(`  master is not a playlist: ${master.slice(0, 120)}`);
    return false;
  }
  const res = (master.match(/RESOLUTION=\d+x\d+/g) || []).join(" ");
  let media = master;
  const firstUri = master.split("\n").find((l) => l.startsWith("https://mma.test/"));
  if (/#EXT-X-STREAM-INF/.test(master)) {
    media = await (await ask(firstUri.replace("https://mma.test", ""))).body.text();
  }
  const segs = media.split("\n").filter((l) => l.startsWith("https://mma.test/"));
  const durs = (media.match(/#EXTINF:([0-9.]+)/g) || []).map((x) => Number(x.slice(8)));
  const total = durs.reduce((a, b) => a + b, 0);
  const seg = await ask(segs[0].replace("https://mma.test", ""));
  const buf = new Uint8Array(await seg.body.arrayBuffer());
  log(`  master ${res || "(single)"}; ${segs.length} segments, ${(total / 60).toFixed(0)} min, avg ${(total / (durs.length || 1)).toFixed(1)}s; first segment HTTP ${seg.status}, ${buf.length} bytes, ${seg.headers.get("content-type")}`);
  if (data.direct) {
    const d = await fetch(data.direct, { headers: { Origin: "https://lolesterrr.github.io" } });
    log(`  direct link from the browser's side: HTTP ${d.status}, CORS ${d.headers.get("access-control-allow-origin")}`);
  }
  if (data.subtitles[0]) {
    const s = await (await ask(data.subtitles[0].url.replace("https://mma.test", ""))).body.text();
    log(`  subtitle "${data.subtitles[0].label}": ${s.slice(0, 30).replace(/\s+/g, " ")}`);
  }
  return seg.status === 200 && buf.length > 1000;
}

const movieId = process.argv[2] || "tt1375666";
const [seriesId, s, e] = [process.argv[3] || "tt0903747", process.argv[4] || "1", process.argv[5] || "1"];
const movie = await meta("movie", movieId);
const series = await meta("series", seriesId);
log(`Movie: ${movie.name} (${movie.releaseInfo}), tmdb ${movie.moviedb_id}. Series: ${series.name}, tmdb ${series.moviedb_id}.`);

const h = await (await ask("/api/health?deep=1")).body.json();
log(`Health: ${JSON.stringify(h.sources)}`);

const mq = (server) => `type=movie&imdb=${movieId}&tmdb=${movie.moviedb_id || ""}&title=${encodeURIComponent(movie.name)}&year=${movie.releaseInfo || movie.year}&server=${server}`;
const sq = (server) => `type=series&imdb=${seriesId}&tmdb=${series.moviedb_id || ""}&title=${encodeURIComponent(series.name)}&year=${series.releaseInfo || series.year}&s=${s}&e=${e}&server=${server}`;

for (const server of ["auto", "videasy", "lookmovie", "hexa", "autoembed"]) {
  const ok = await walk(`Movie, ${server}`, mq(server)).catch((err) => (log(`  crashed: ${err.stack}`), false));
  if (server === "auto" && !ok) failures++;
}
for (const server of ["auto", "videasy", "hexa", "autoembed"]) {
  const ok = await walk(`Series, ${server}`, sq(server)).catch((err) => (log(`  crashed: ${err.stack}`), false));
  if (server === "auto" && !ok) failures++;
}
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, "```\n" + lines.join("\n") + "\n```\n");
}
if (process.env.LIVE_OUT) {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(process.env.LIVE_OUT, lines.join("\n") + "\n");
}
process.exit(failures ? 1 : 0);
