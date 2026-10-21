// Probe 3: walk each candidate source end to end and check whether the stream loads,
// with the referer the source wants, with none, and from the GitHub Pages origin.
import { mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

mkdirSync("probe-out", { recursive: true });
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const ED = "https://enc-dec.app/api";
const lines = [];
const log = (...a) => { const s = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "); console.log(s); lines.push(s); };
let n = 0;
const save = (name, text) => writeFileSync(`probe-out/${String(++n).padStart(2, "0")}-${name}`, typeof text === "string" ? text : JSON.stringify(text, null, 2));

async function req(url, { headers = {}, method = "GET", body, json } = {}) {
  const t = Date.now();
  try {
    const r = await fetch(url, {
      method,
      headers: { "User-Agent": UA, ...(json ? { "Content-Type": "application/json" } : {}), ...headers },
      body: json ? JSON.stringify(json) : body,
      signal: AbortSignal.timeout(20000),
    });
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, text: buf.toString("utf8"), len: buf.length, url: r.url, ms: Date.now() - t, acao: r.headers.get("access-control-allow-origin"), ct: r.headers.get("content-type") };
  } catch (e) {
    return { status: 0, text: "", len: 0, err: e.message, ms: Date.now() - t };
  }
}
const J = (r) => { try { return JSON.parse(r.text); } catch { return null; } };

async function checkHls(tag, url, referer) {
  const h = referer ? { Referer: referer, Origin: referer.replace(/\/$/, "") } : {};
  const a = await req(url, { headers: h });
  const b = await req(url);
  const c = await req(url, { headers: { Origin: "https://lolesterrr.github.io", Referer: "https://lolesterrr.github.io/" } });
  let out = `${tag}: playlist ref ${a.status} bare ${b.status} pages ${c.status} acao ${c.acao} ct ${a.ct}`;
  const pl = [a, b, c].find((x) => x.status === 200 && x.text.trimStart().startsWith("#EXTM3U"));
  if (!pl) {
    if (a.status === 200 && /video|octet/.test(a.ct || "")) out += " (looks like a file)";
    return log(out, "| head:", (a.text || "").slice(0, 120).replace(/\s+/g, " "));
  }
  let media = pl, base = pl.url || url;
  const variants = pl.text.split("\n").filter((l) => l && !l.startsWith("#"));
  if (/#EXT-X-STREAM-INF/.test(pl.text) && variants[0]) {
    out += ` | ${variants.length} variants (${(pl.text.match(/RESOLUTION=\d+x\d+/g) || []).join(" ")})`;
    const vu = new URL(variants[0], base).href;
    media = await req(vu, { headers: pl === a ? h : {} });
    base = media.url || vu;
  }
  const segs = media.text.split("\n").filter((l) => l && !l.startsWith("#"));
  const dur = (media.text.match(/#EXTINF:([0-9.]+)/g) || []).map((x) => Number(x.slice(8)));
  out += ` | ${segs.length} segments avg ${(dur.reduce((s, x) => s + x, 0) / (dur.length || 1)).toFixed(1)}s, key ${/#EXT-X-KEY/.test(media.text)}`;
  if (segs[0]) {
    const su = new URL(segs[0], base).href;
    const sa = await req(su, { headers: h });
    const sb = await req(su);
    const sc = await req(su, { headers: { Origin: "https://lolesterrr.github.io", Referer: "https://lolesterrr.github.io/" } });
    out += ` | seg ${new URL(su).host} ref ${sa.status}/${sa.len}b bare ${sb.status} pages ${sc.status} acao ${sc.acao} ct ${sa.ct}`;
  }
  log(out);
}

const MOVIE = { title: "Inception", year: "2010", tmdb: "27205", imdb: "tt1375666" };
const SHOW = { title: "Breaking Bad", year: "2008", tmdb: "1396", imdb: "tt0903747", s: 1, e: 1 };

async function step(name, fn) {
  log(`\n=== ${name}`);
  try { await fn(); } catch (e) { log(`  crashed: ${e.message}`); }
}

// lookmovie, through lmscript.xyz
await step("lookmovie", async () => {
  const LM = "https://lmscript.xyz";
  for (const [kind, m] of [["movies", MOVIE], ["shows", SHOW]]) {
    const s = await req(`${LM}/v1/${kind}?filters[q]=${encodeURIComponent(m.title)}`, { headers: { Origin: "https://lolesterrr.github.io" } });
    save(`lm-${kind}-search.json`, s.text);
    const items = (J(s) || {}).items || [];
    log(`  ${kind} search ${s.status} ${s.ms}ms acao ${s.acao}: ${items.slice(0, 3).map((i) => `${i.title} ${i.year} ${i.id_movie || i.id_show} ${i.slug}`).join(" | ")}`);
    log(`  first item keys: ${Object.keys(items[0] || {}).join(",")}`);
    const it = items.find((i) => String(i.year) === m.year) || items[0];
    if (!it) continue;
    let id = it.id_movie;
    let path = "/v1/movies/view";
    if (kind === "shows") {
      const d = await req(`${LM}/v1/shows?expand=episodes&id=${it.id_show}`);
      save("lm-show-episodes.json", d.text);
      const eps = (J(d) || {}).episodes || [];
      log(`  episodes ${d.status}: ${eps.length}, sample ${JSON.stringify(eps[0])}`);
      id = (eps.find((x) => Number(x.season) === 1 && Number(x.episode) === 1) || {}).id;
      path = "/v1/episodes/view";
    }
    const v = await req(`${LM}${path}?expand=streams,subtitles&id=${id}`, { headers: { Origin: "https://lolesterrr.github.io" } });
    save(`lm-${kind}-view.json`, v.text);
    const vd = J(v) || {};
    log(`  view ${v.status} acao ${v.acao} keys ${Object.keys(vd).join(",")} streams ${JSON.stringify(vd.streams)?.slice(0, 300)} subs ${(vd.subtitles || []).length}`);
    const st = vd.streams || {};
    const url = st.auto || st["1080p"] || st["720p"] || st["720"] || Object.values(st)[0];
    if (url) await checkHls(`  ${kind} stream`, url);
    if (vd.subtitles && vd.subtitles[0]) {
      const sub = await req(LM + vd.subtitles[0].url, { headers: { Origin: "https://lolesterrr.github.io" } });
      log(`  subtitle ${sub.status} acao ${sub.acao} ${sub.text.slice(0, 40).replace(/\s+/g, " ")}`);
    }
  }
});

// vidlink
await step("vidlink", async () => {
  for (const [kind, m] of [["movie", MOVIE], ["tv", SHOW]]) {
    const e = await req(`${ED}/enc-vidlink?text=${m.tmdb}`);
    const enc = (J(e) || {}).result;
    log(`  enc ${e.status} ${String(enc).slice(0, 30)}`);
    const url = kind === "movie" ? `https://vidlink.pro/api/b/movie/${enc}` : `https://vidlink.pro/api/b/tv/${enc}/${m.s}/${m.e}`;
    const r = await req(url, { headers: { Origin: "https://vidlink.pro", Referer: "https://vidlink.pro/" } });
    save(`vidlink-${kind}.json`, r.text);
    const d = J(r) || {};
    log(`  ${kind} api ${r.status} ${r.ms}ms: ${r.text.slice(0, 300)}`);
    const pl = d.stream && (d.stream.playlist || Object.values(d.stream.qualities || {})[0]?.url);
    if (pl) await checkHls(`  ${kind} stream`, pl, "https://vidlink.pro/");
  }
});

// videasy
await step("videasy", async () => {
  const H = { Accept: "*/*", Origin: "https://player.videasy.to", Referer: "https://player.videasy.to/" };
  for (const [kind, m] of [["movie", MOVIE], ["tv", SHOW]]) {
    const seedR = await req(`https://api.wecollege.net/seed?mediaId=${m.tmdb}`, { headers: H });
    const seed = (J(seedR) || {}).seed;
    log(`  seed ${seedR.status} ${seed}`);
    const t = encodeURIComponent(encodeURIComponent(m.title));
    for (const server of ["miami", "vegas"]) {
      const url = `https://api.wecollege.net/${server}/sources?title=${t}&mediaType=${kind}&year=${m.year}${kind === "tv" ? `&episodeId=${m.e}&seasonId=${m.s}` : ""}&tmdbId=${m.tmdb}&imdbId=${m.imdb}&enc=2&seed=${seed}`;
      const r = await req(url, { headers: H });
      const d = await req(`${ED}/dec-videasy`, { method: "POST", json: { text: r.text, id: m.tmdb, seed } });
      save(`videasy-${kind}-${server}.json`, d.text);
      const res = (J(d) || {}).result;
      log(`  ${kind} ${server}: src ${r.status} ${r.ms}ms ${r.len}b, dec ${d.status}: ${JSON.stringify(res)?.slice(0, 300)}`);
      const s = res && res.sources && res.sources[0];
      if (s) { await checkHls(`  ${kind} ${server} stream`, s.url, "https://player.videasy.to/"); break; }
    }
  }
});

// hexa / flixer
await step("hexa", async () => {
  for (const [kind, m] of [["movie", MOVIE], ["tv", SHOW]]) {
    const key = randomBytes(32).toString("hex");
    const tk = await req(`${ED}/enc-hexa`);
    const token = ((J(tk) || {}).result || {}).token;
    log(`  token ${tk.status} ${String(token).slice(0, 20)}`);
    const H = { Referer: "https://hexa.su/", Accept: "text/plain", "X-Fingerprint-Lite": "e9136c41504646444", "X-Api-Key": key, "X-Cap-Token": token };
    const url = kind === "movie" ? `https://theemoviedb.hexa.su/api/tmdb/movie/${m.tmdb}/images` : `https://theemoviedb.hexa.su/api/tmdb/tv/${m.tmdb}/season/${m.s}/episode/${m.e}/images`;
    const r = await req(url, { headers: H });
    const d = await req(`${ED}/dec-hexa`, { method: "POST", json: { text: r.text, key } });
    save(`hexa-${kind}.json`, d.text);
    const res = (J(d) || {}).result;
    log(`  ${kind}: src ${r.status} ${r.ms}ms ${r.len}b, dec ${d.status}: ${JSON.stringify(res)?.slice(0, 400)}`);
    const s = res && res.sources && res.sources[0];
    if (s) await checkHls(`  ${kind} stream`, s.url, "https://hexa.su/");
  }
});

// yflix / 1movies, using enc-dec's database to map tmdb ids
await step("yflix", async () => {
  for (const [kind, m] of [["movie", MOVIE], ["tv", SHOW]]) {
    const f = await req(`https://enc-dec.app/db/flix/find?tmdb_id=${m.tmdb}&type=${kind}`);
    save(`flixdb-${kind}.json`, f.text);
    log(`  db ${f.status}: ${f.text.slice(0, 400)}`);
  }
});

writeFileSync("probe-out/summary.txt", lines.join("\n"));
