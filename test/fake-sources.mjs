// Fake movie sources for tests and offline demos.
//
// Serves the same shapes the worker and the app talk to: Cinemeta (search, meta, popular),
// videasy (seed + encrypted sources), enc-dec.app (decrypt), hexa, lookmovie, autoembed, OpenSubtitles,
// two stream hosts (one that insists on videasy's Referer, one that's open with CORS), and a
// mock GitHub issues API. The catalog is made up.
//
//   node test/fake-sources.mjs     # prints the URLs
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureMedia } from "./media.mjs";

const VIDEASY_REFERER = "https://vidy.st/";

// where each title can be found: v = videasy, h = hexa, l = lookmovie, a = autoembed
export const MOVIES = [
  { id: "tt0000101", tmdb: "9101", title: "The Grand Budapest Nap", year: "2014", on: "vhla", hue: 12, genre: ["Comedy"], runtime: "100 min" },
  { id: "tt0000102", tmdb: "9102", title: "Napocalypse Now", year: "1979", on: "l", hue: 40, genre: ["War", "Drama"], runtime: "147 min" },
  { id: "tt0000103", tmdb: "9103", title: "Pierre Fiction", year: "1994", on: "ha", hue: 200, genre: ["Crime"], runtime: "154 min" },
  { id: "tt0000104", tmdb: "9104", title: "The Nap Knight", year: "2008", on: "", hue: 280, genre: ["Action"], runtime: "152 min" },
  { id: "tt0000105", tmdb: "", title: "No Ids Here", year: "2001", on: "vhl", hue: 150, genre: ["Mystery"], runtime: "90 min" },
];
export const SERIES = [
  { id: "tt0000201", tmdb: "9201", title: "Breaking Nap", years: "2008–2013", on: "vha", hue: 100, genre: ["Drama"], seasons: [3, 2], specials: 1, upcoming: true },
  { id: "tt0000202", tmdb: "9202", title: "Stranger Naps", years: "2016–", on: "v", hue: 330, genre: ["Sci-Fi"], seasons: [4], specials: 0 },
];

const all = () => [...MOVIES.map((m) => ({ ...m, type: "movie" })), ...SERIES.map((s) => ({ ...s, type: "series" }))];
const find = (id) => all().find((x) => x.id === id);
const byTmdb = (tmdb) => all().find((x) => x.tmdb && x.tmdb === String(tmdb));
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = (s) => JSON.parse(Buffer.from(String(s), "base64").toString("utf8"));

function svg(title, sub, hue, w = 300, h = 450) {
  const t = esc(title);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},70%,62%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},65%,30%)"/></linearGradient></defs>
<rect width="${w}" height="${h}" fill="url(#g)"/>
<circle cx="${w * 0.75}" cy="${h * 0.2}" r="${w * 0.15}" fill="rgba(255,255,255,.18)"/><circle cx="${w * 0.2}" cy="${h * 0.78}" r="${w * 0.27}" fill="rgba(0,0,0,.12)"/>
<text x="20" y="${h - 56}" font-family="Helvetica,Arial,sans-serif" font-size="${w > 400 ? 34 : 26}" font-weight="700" fill="#fff">${t.length > 20 ? t.slice(0, 19) + "…" : t}</text>
<text x="20" y="${h - 26}" font-family="Helvetica,Arial,sans-serif" font-size="16" fill="rgba(255,255,255,.85)">${esc(sub)}</text></svg>`;
}

function episodes(s, host) {
  const out = [];
  s.seasons.forEach((count, i) => {
    for (let e = 1; e <= count; e++) {
      const aired = new Date(Date.UTC(2008 + i, 0, 20 + e * 7)).toISOString();
      out.push({ id: `${s.id}:${i + 1}:${e}`, season: i + 1, episode: e, number: e, name: e === 1 ? "Pilot Nap" : `The Nap, Part ${e}`, overview: `Pierre naps through season ${i + 1}, episode ${e}. Nobody is surprised.`, released: aired, thumbnail: `${host.catalog}/thumbs/${s.id}/${i + 1}/${e}.svg` });
    }
  });
  for (let e = 1; e <= s.specials; e++) out.push({ id: `${s.id}:0:${e}`, season: 0, episode: e, number: e, name: "Behind the Naps", overview: "A special about the making of the naps.", released: "2010-05-01T00:00:00.000Z", thumbnail: null });
  if (s.upcoming) {
    const last = s.seasons.length;
    out.push({ id: `${s.id}:${last}:${s.seasons[last - 1] + 1}`, season: last, episode: s.seasons[last - 1] + 1, number: s.seasons[last - 1] + 1, name: "The Big Nap", overview: "Coming soon.", released: new Date(Date.now() + 30 * 86400e3).toISOString() });
  }
  return out;
}

function meta(x, host) {
  const base = {
    id: x.id,
    imdb_id: x.id,
    type: x.type,
    name: x.title,
    poster: `${host.catalog}/posters/${x.id}.svg`,
    background: `${host.catalog}/posters/${x.id}.svg`,
    releaseInfo: x.type === "movie" ? x.year : x.years,
    year: x.type === "movie" ? x.year : x.years,
    description: `${x.title} is a made-up ${x.type === "movie" ? "movie" : "series"} about a cat who naps. It's in MMA's offline demo.`,
    genres: x.genre,
    runtime: x.runtime || "45 min",
    imdbRating: "8.4",
    cast: ["Monsieur Pierre", "A Sofa", "Popcorn"],
    director: x.type === "movie" ? ["P. Napman"] : undefined,
  };
  if (x.tmdb) base.moviedb_id = Number(x.tmdb);
  if (x.type === "series") base.videos = episodes(x, host);
  return base;
}

const VTT = (lang) =>
  lang === "fr"
    ? "WEBVTT\n\n00:00:00.500 --> 00:00:04.000\nBonjour. Je suis Monsieur Pierre.\n\n00:00:04.500 --> 00:00:09.000\nC'est un film de test.\n"
    : "WEBVTT\n\n00:00:00.500 --> 00:00:04.000\nBonjour. I'm Monsieur Pierre.\n\n00:00:04.500 --> 00:00:09.000\nThis is a test movie. Nobody is napping. Yet.\n";
const SRT = "1\n00:00:00,500 --> 00:00:04,000\nHallo. Ich bin Monsieur Pierre.\n\n2\n00:00:04,500 --> 00:00:09,000\nDas ist ein Testfilm.\n";

function send(res, status, body, type = "application/json", extra = {}) {
  res.writeHead(status, { "Content-Type": type, ...extra });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => resolve(body));
  });
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });
}

function streamFile(req, res, mediaDir, file, cors) {
  const path = join(mediaDir, file);
  if (!/^(720|360)\/(index\.m3u8|seg\d{3}\.(ts|m4s)|init\.mp4|key\.bin)$/.test(file) || !existsSync(path)) return send(res, 404, "", "text/plain", cors);
  const type = file.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : file.endsWith(".ts") ? "video/mp2t" : /\.(m4s|mp4)$/.test(file) ? "video/mp4" : "application/octet-stream";
  const data = readFileSync(path);
  const range = req.headers.range && req.headers.range.match(/bytes=(\d+)-(\d*)/);
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Number(range[2]) : data.length - 1;
    return send(res, 206, data.subarray(start, end + 1), type, { "Content-Range": `bytes ${start}-${end}/${data.length}`, "Accept-Ranges": "bytes", ...cors });
  }
  return send(res, 200, data, type, { "Accept-Ranges": "bytes", ...cors });
}

function master(codec, prefix = "") {
  const codecs = codec === "vp9" ? ["vp09.00.31.08,opus", "vp09.00.30.08,opus"] : ["avc1.640020,mp4a.40.2", "avc1.64001e,mp4a.40.2"];
  return `#EXTM3U\n#EXT-X-VERSION:${codec === "vp9" ? 7 : 3}\n#EXT-X-STREAM-INF:BANDWIDTH=1400000,RESOLUTION=1280x720,CODECS="${codecs[0]}"\n${prefix}720/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=500000,RESOLUTION=640x360,CODECS="${codecs[1]}"\n${prefix}360/index.m3u8\n`;
}

/**
 * startFake({ ports, media, codec }) -> { host, stop, issues, requests, set }
 * Ports: catalog, sources (videasy/hexa/lookmovie/enc-dec/subs/github), guarded cdn, open cdn.
 * set({ blocked: true }) makes every source answer with Cloudflare's bot check.
 */
export async function startFake({ ports = [0, 0, 0, 0], media = true, codec = process.env.FAKE_CODEC || "h264" } = {}) {
  const state = { blocked: false, issues: [], requests: [], down: new Set(), busy: 0 };
  const mediaDir = media ? ensureMedia(codec) : null;
  const host = {};
  const challenge = (res) =>
    send(res, 503, "<!DOCTYPE html><html><head><title>Just a moment...</title></head><body><div id=\"cf-chl\">Checking your browser</div><script src=\"/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1\"></script></body></html>", "text/html");

  // Cinemeta, which the browser calls directly (so it sends CORS headers)
  const catalog = createServer((req, res) => {
    const url = new URL(req.url, host.catalog);
    const cors = { "Access-Control-Allow-Origin": "*" };
    state.requests.push({ server: "catalog", path: url.pathname });
    let m = url.pathname.match(/^\/catalog\/(movie|series)\/top\/search=([^/]*)\.json$/);
    if (m) {
      const q = decodeURIComponent(m[2]).toLowerCase();
      // like the real Cinemeta now and then: one half of a search times out at the gateway
      if (q === "pierre" && m[1] === "series") return send(res, 504, "<!DOCTYPE html><title>504 Gateway Time-out</title>", "text/html");
      const metas = all().filter((x) => x.type === m[1] && x.title.toLowerCase().includes(q)).map((x) => meta(x, host));
      return send(res, 200, { metas }, "application/json", cors);
    }
    m = url.pathname.match(/^\/catalog\/(movie|series)\/top\.json$/);
    if (m) return send(res, 200, { metas: all().filter((x) => x.type === m[1]).map((x) => meta(x, host)) }, "application/json", cors);
    m = url.pathname.match(/^\/meta\/(movie|series)\/(tt\d+)\.json$/);
    if (m) {
      const x = find(m[2]);
      return x && x.type === m[1] ? send(res, 200, { meta: meta(x, host) }, "application/json", cors) : send(res, 200, { meta: null }, "application/json", cors);
    }
    m = url.pathname.match(/^\/posters\/(tt\d+)\.svg$/);
    if (m) {
      const x = find(m[1]);
      return x ? send(res, 200, svg(x.title, `${x.type === "movie" ? "Movie" : "Series"} · ${x.year || x.years}`, x.hue), "image/svg+xml", cors) : send(res, 404, "");
    }
    m = url.pathname.match(/^\/thumbs\/(tt\d+)\/(\d+)\/(\d+)\.svg$/);
    if (m) {
      const x = find(m[1]);
      return send(res, 200, svg(`S${m[2]} E${m[3]}`, x ? x.title : "", ((x && x.hue) || 0) + Number(m[3]) * 25, 480, 270), "image/svg+xml", cors);
    }
    return send(res, 404, { error: "nope" }, "application/json", cors);
  });

  // everything the worker asks: videasy, enc-dec, hexa, lookmovie, opensubtitles, github
  const sources = createServer(async (req, res) => {
    const url = new URL(req.url, host.sources);
    const p = url.pathname;
    state.requests.push({ server: "sources", path: p + url.search, headers: req.headers, method: req.method });
    const has = (x, letter) => x && x.on.includes(letter) && !state.down.has(letter);

    if (p.startsWith("/github/")) {
      if (req.method === "POST" && /^\/github\/repos\/[^/]+\/[^/]+\/issues$/.test(p)) {
        const body = await readBody(req);
        if (req.headers.authorization !== "Bearer test-github-token") return send(res, 401, { message: "Bad credentials" });
        const issue = JSON.parse(body);
        const number = state.issues.length + 1;
        state.issues.push({ ...issue, number, path: p });
        return send(res, 201, { number, html_url: `https://github.com${p.replace("/github/repos", "")}/${number}` });
      }
      return send(res, 404, {});
    }
    if (state.blocked) return challenge(res);

    // ---- videasy
    if (p.startsWith("/videasy/")) {
      if (req.headers.referer !== VIDEASY_REFERER) return send(res, 403, "wrong referer", "text/plain");
      if (p === "/videasy/seed") return send(res, 200, { seed: `seed-${url.searchParams.get("mediaId")}` });
      const m = p.match(/^\/videasy\/(\w+)\/sources$/);
      if (!m) return send(res, 404, "");
      const q = url.searchParams;
      const x = byTmdb(q.get("tmdbId"));
      if (q.get("seed") !== `seed-${q.get("tmdbId")}` || q.get("enc") !== "2") return send(res, 400, "bad seed", "text/plain");
      if (!has(x, "v")) return send(res, 200, "", "text/plain");
      if (m[1] === "miami" && x.id === "tt0000202") return send(res, 200, "", "text/plain"); // only on the second server
      const kind = q.get("mediaType") === "tv" ? `${x.id}/${q.get("seasonId")}/${q.get("episodeId")}` : x.id;
      const base = `${host.guarded}/vd/${kind}`;
      // like Videasy's reno server on The Rehearsal: one "source" that is itself a master playlist
      if (x.id === "tt0000202" && kind.endsWith("/1/4")) return send(res, 200, b64({ sources: [{ quality: "1080p", url: `${base}/master.m3u8` }], subtitles: [] }), "text/plain");
      return send(res, 200, b64({ sources: [{ quality: "720p", url: `${base}/720/index.m3u8` }, { quality: "360p", url: `${base}/360/index.m3u8` }], subtitles: [{ lang: "eng", language: "English", url: `${base}/subs/eng.vtt` }], playlist: `${base}/master.m3u8` }), "text/plain");
    }

    // ---- enc-dec.app
    if (p === "/encdec/api/dec-videasy" && req.method === "POST") {
      const { text, id, seed } = JSON.parse(await readBody(req));
      if (seed !== `seed-${id}`) return send(res, 200, { status: 400, error: "bad seed" });
      try {
        return send(res, 200, { status: 200, result: unb64(text) });
      } catch {
        return send(res, 200, { status: 500, error: "decrypt failed" });
      }
    }
    if (p === "/encdec/api/enc-hexa") {
      // like the real one in a burst: "oop! too many requests", as an HTTP 500
      if (state.busy > 0) {
        state.busy--;
        return send(res, 500, { status: 500, error: "oop! too many requests" });
      }
      return send(res, 200, { status: 200, result: { token: "cap-token" } });
    }
    if (p === "/encdec/api/dec-hexa" && req.method === "POST") {
      const { text, key } = JSON.parse(await readBody(req));
      if (!/^[0-9a-f]{64}$/.test(key)) return send(res, 200, { status: 400, error: "bad key" });
      try {
        return send(res, 200, { status: 200, result: unb64(text) });
      } catch {
        return send(res, 200, { status: 500, error: "decrypt failed" });
      }
    }

    // ---- hexa
    let m = p.match(/^\/hexa\/api\/tmdb\/(movie\/(\d+)|tv\/(\d+)\/season\/(\d+)\/episode\/(\d+))\/images$/);
    if (m) {
      if (req.headers["x-cap-token"] !== "cap-token" || !/^[0-9a-f]{64}$/.test(req.headers["x-api-key"] || "")) return send(res, 403, "", "text/plain");
      const x = byTmdb(m[2] || m[3]);
      if (!has(x, "h")) return send(res, 200, b64({ sources: [] }), "text/plain");
      const kind = m[3] ? `${x.id}/${m[4]}/${m[5]}` : x.id;
      return send(res, 200, b64({ sources: [{ server: "charlie", url: `${host.open}/proxy?data=nope` }, { server: "alpha", url: `${host.open}/hx/${kind}/720/index.m3u8` }] }), "text/plain");
    }

    // ---- lookmovie
    if (p === "/lookmovie/v1/movies") {
      const q = (url.searchParams.get("filters[q]") || "").toLowerCase();
      // ids are fixed per movie, like the real ones, not positions in this search
      const items = MOVIES.map((x, i) => [x, i]).filter(([x]) => has(x, "l") && x.title.toLowerCase().includes(q)).map(([x, i]) => ({ id_movie: String(500 + i), title: x.title, year: x.year, imdb_id: x.id, slug: `${x.id.slice(2)}-${x.title.toLowerCase().replace(/\W+/g, "-")}-${x.year}` }));
      return send(res, 200, { items });
    }
    if (p === "/lookmovie/v1/movies/view") {
      const idx = Number(url.searchParams.get("id")) - 500;
      const x = has(MOVIES[idx], "l") ? MOVIES[idx] : null;
      if (!x) return send(res, 404, { message: "not found" });
      return send(res, 200, {
        id_movie: url.searchParams.get("id"),
        title: x.title,
        streams: { "720p": `${host.open}/lm/${x.id}/720/index.m3u8`, "360p": `${host.open}/lm/${x.id}/360/index.m3u8` },
        subtitles: [
          { language: "English", url: `/storage/${x.id}/en.vtt` },
          { language: "French", url: `/storage/${x.id}/fr.vtt` },
          { language: "English", url: `/storage/${x.id}/en2.vtt` },
        ],
      });
    }
    m = p.match(/^\/lookmovie\/storage\/tt\d+\/(en|fr|en2)\.vtt$/);
    if (m) return send(res, 200, VTT(m[1] === "fr" ? "fr" : "en"), "text/vtt", { "Access-Control-Allow-Origin": "*" });

    // ---- autoembed: plain JSON by IMDb id, wants its own referer
    if (p === "/autoembed/api/getVideoSource") {
      if (req.headers.referer !== `${host.sources}/autoembed/`) return send(res, 403, "wrong referer", "text/plain");
      const [id, se, ep] = String(url.searchParams.get("id") || "").split("/");
      const x = find(id);
      const type = url.searchParams.get("type");
      if (!has(x, "a") || (type === "tv") !== (x.type === "series")) return send(res, 200, { error: "not found" });
      const kind = type === "tv" ? `${x.id}/${se}/${ep}` : x.id;
      return send(res, 200, { videoSource: `${host.open}/ae/${kind}/720/index.m3u8`, subtitles: [{ label: "English", file: `${host.open}/ae/${kind}/subs/en.vtt` }] });
    }

    // ---- opensubtitles (stremio addon)
    m = p.match(/^\/subs\/subtitles\/(movie|series)\/(tt\d+)(?::\d+:\d+)?\.json$/);
    if (m) return send(res, 200, { subtitles: [{ id: "1", lang: "ger", url: `${host.sources}/subs/file/${m[2]}.srt` }, { id: "2", lang: "eng", url: `${host.sources}/subs/file/${m[2]}-en.srt` }] });
    m = p.match(/^\/subs\/file\/(tt\d+)(-en)?\.srt$/);
    if (m) return send(res, 200, SRT, "application/x-subrip");

    return send(res, 404, { error: "nope" });
  });

  // videasy's stream host: wants the referer, and refuses the site's origin
  const guarded = createServer((req, res) => {
    const url = new URL(req.url, host.guarded);
    state.requests.push({ server: "guarded", path: url.pathname, headers: req.headers });
    if (req.headers.referer !== VIDEASY_REFERER) return send(res, 403, "Forbidden: wrong referer", "text/plain");
    const m = url.pathname.match(/^\/vd\/(tt\d+)(?:\/\d+\/\d+)?\/(.+)$/);
    if (!m || !mediaDir) return send(res, 404, "", "text/plain");
    if (m[2] === "master.m3u8") return send(res, 200, master(codec), "application/vnd.apple.mpegurl");
    if (m[2] === "subs/eng.vtt") return send(res, 200, VTT("en"), "text/vtt");
    return streamFile(req, res, mediaDir, m[2], {});
  });

  // hexa's and lookmovie's stream host: open, with CORS, so the browser can play it directly
  const open = createServer((req, res) => {
    const url = new URL(req.url, host.open);
    const cors = { "Access-Control-Allow-Origin": "*" };
    state.requests.push({ server: "open", path: url.pathname, headers: req.headers });
    if (req.method === "OPTIONS") return send(res, 204, "", "text/plain", { ...cors, "Access-Control-Allow-Headers": "*" });
    const m = url.pathname.match(/^\/(hx|lm|ae)\/(tt\d+)(?:\/\d+\/\d+)?\/(.+)$/);
    if (!m || !mediaDir) return send(res, 404, "", "text/plain", cors);
    if (m[3] === "subs/en.vtt") return send(res, 200, VTT("en"), "text/vtt", cors);
    return streamFile(req, res, mediaDir, m[3], cors);
  });

  const servers = [catalog, sources, guarded, open];
  const bound = [];
  for (let i = 0; i < servers.length; i++) bound.push(await listen(servers[i], ports[i]));
  host.catalog = `http://127.0.0.1:${bound[0]}`;
  host.sources = `http://127.0.0.1:${bound[1]}`;
  host.guarded = `http://127.0.0.1:${bound[2]}`;
  host.open = `http://127.0.0.1:${bound[3]}`;

  return {
    host,
    /** the worker's env for these fakes */
    env: {
      ENCDEC_URL: `${host.sources}/encdec`,
      VIDEASY_URL: `${host.sources}/videasy`,
      LOOKMOVIE_URL: `${host.sources}/lookmovie`,
      HEXA_URL: `${host.sources}/hexa`,
      AUTOEMBED_URL: `${host.sources}/autoembed`,
      SUBS_URL: `${host.sources}/subs`,
      GITHUB_API: `${host.sources}/github`,
    },
    issues: state.issues,
    requests: state.requests,
    mediaDir,
    set(opts) {
      if ("blocked" in opts) state.blocked = opts.blocked;
      if ("down" in opts) state.down = new Set(opts.down);
      if ("busy" in opts) state.busy = opts.busy;
    },
    stop: () => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const fake = await startFake();
  console.log(fake.host);
}
