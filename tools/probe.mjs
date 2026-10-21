// Walks lobster's path through flixhq and saves every raw response to probe-out/.
//   node tools/probe.mjs "query"
// Used from the Probe workflow, because sites like flixhq are only reachable from CI.
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.BASE || "https://flixhq.to";
const DEC = (process.env.DEC || "https://dec.eatmynerds.live,https://decrypt.broggl.farm").split(",");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const q = process.argv[2] || "the dark knight";
const tvq = process.argv[3] || "breaking bad";
mkdirSync("probe-out", { recursive: true });
let n = 0;

async function get(name, url, init = {}) {
  const t = Date.now();
  try {
    const r = await fetch(url, { ...init, headers: { "User-Agent": UA, ...(init.headers || {}) }, redirect: "follow" });
    const body = Buffer.from(await r.arrayBuffer());
    const file = `probe-out/${String(++n).padStart(2, "0")}-${name}`;
    writeFileSync(file, body);
    writeFileSync(file + ".headers", `${r.status} ${r.url}\n` + [...r.headers].map(([k, v]) => `${k}: ${v}`).join("\n"));
    console.log(`${name}: HTTP ${r.status}, ${body.length} bytes, ${Date.now() - t}ms, ${r.headers.get("content-type")} <- ${url}`);
    return { status: r.status, text: body.toString("utf8"), body, url: r.url };
  } catch (e) {
    console.log(`${name}: FAILED ${e.message} <- ${url}`);
    return { status: 0, text: "", body: Buffer.alloc(0) };
  }
}

const flat = (s) => s.replace(/\n/g, "");

async function stream(kind, mediaId, episodeId, apiMediaId) {
  const src = await get(`${kind}-sources.json`, `${BASE}/ajax/episode/sources/${episodeId}`, { headers: { "X-Requested-With": "XMLHttpRequest" } });
  const link = (src.text.match(/"link":"([^"]*)"/) || [])[1]?.replace(/\\\//g, "/");
  console.log(`  embed link: ${link}`);
  if (!link) return;
  await get(`${kind}-embed.html`, link, { headers: { Referer: BASE + "/" } });
  for (const dec of DEC) {
    const d = await get(`${kind}-decrypt-${new URL(dec).hostname}.json`, dec, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: link, mediaId: apiMediaId }),
    });
    const m3u8 = (d.text.match(/"file":"([^"]*\.m3u8[^"]*)"/) || [])[1];
    console.log(`  m3u8: ${m3u8}`);
    if (!m3u8) continue;
    const embedOrigin = new URL(link).origin;
    const master = await get(`${kind}-master.m3u8`, m3u8, { headers: { Referer: embedOrigin + "/", Origin: embedOrigin } });
    await get(`${kind}-master-noref.m3u8`, m3u8);
    const lines = master.text.split("\n").filter((l) => l && !l.startsWith("#"));
    if (!lines.length) return;
    const variant = new URL(lines[lines.length - 1], master.url || m3u8).href;
    const media = await get(`${kind}-media.m3u8`, variant, { headers: { Referer: embedOrigin + "/", Origin: embedOrigin } });
    const seg = media.text.split("\n").find((l) => l && !l.startsWith("#"));
    if (seg) {
      const segUrl = new URL(seg, media.url || variant).href;
      await get(`${kind}-seg-ref.bin`, segUrl, { headers: { Referer: embedOrigin + "/", Origin: embedOrigin } });
      await get(`${kind}-seg-noref.bin`, segUrl);
      await get(`${kind}-seg-other.bin`, segUrl, { headers: { Referer: "https://lolesterrr.github.io/", Origin: "https://lolesterrr.github.io" } });
    }
    const key = media.text.match(/#EXT-X-KEY:[^\n]*/);
    console.log(`  key line: ${key ? key[0] : "none"}`);
    return;
  }
}

const home = await get("home.html", BASE + "/home");
console.log(`  cloudflare challenge? ${/cf-chl|Just a moment/i.test(home.text)}`);

for (const [kind, query] of [["movie", q], ["tv", tvq]]) {
  const s = await get(`${kind}-search.html`, `${BASE}/search/${query.trim().replace(/\s+/g, "-")}`);
  const items = flat(s.text).split('class="flw-item"').slice(1);
  const rows = items.map((it) => {
    const m = it.match(/img data-src="([^"]*)".*?<a href="\/((tv|movie)\/watch-[^"]*-([0-9]*))".*?title="([^"]*)".*?class="fdi-item">([^<]*)<\/span>/);
    return m && { img: m[1], path: m[2], type: m[3], id: m[4], title: m[5], extra: m[6] };
  }).filter(Boolean);
  console.log(`  ${rows.length} results:`, rows.slice(0, 4).map((r) => `${r.type} ${r.id} ${r.title} [${r.extra}]`).join(" | "));
  const hit = rows.find((r) => r.type === kind);
  if (!hit) continue;
  await get(`${kind}-page.html`, `${BASE}/${hit.path}`);
  if (kind === "movie") {
    const eps = await get("movie-episodes.html", `${BASE}/ajax/movie/episodes/${hit.id}`);
    const servers = [...flat(eps.text).matchAll(/href="([^"]*)"\s*title="([^"]*)"/g)].map((m) => [m[2], m[1]]);
    console.log("  servers:", servers.map((s) => s.join(" ")).join(" | "));
    const vc = servers.find(([t]) => /vidcloud/i.test(t)) || servers[0];
    if (vc) await stream("movie", hit.id, vc[1].match(/\.([0-9]+)$/)?.[1], hit.path);
  } else {
    const seasons = await get("tv-seasons.html", `${BASE}/ajax/v2/tv/seasons/${hit.id}`);
    const ss = [...seasons.text.matchAll(/href=".*-([0-9]*)">(.*)<\/a>/g)].map((m) => [m[2], m[1]]);
    console.log("  seasons:", ss.map((s) => s.join(" ")).join(" | "));
    if (!ss[0]) continue;
    const eps = await get("tv-episodes.html", `${BASE}/ajax/v2/season/episodes/${ss[0][1]}`);
    const ep = [...flat(eps.text).split('class="nav-item"').slice(1)].map((x) => x.match(/data-id="([0-9]*)".*title="([^"]*)">/)).filter(Boolean);
    console.log(`  ${ep.length} episodes, first: ${ep[0]?.[2]} (${ep[0]?.[1]})`);
    if (!ep[0]) continue;
    const sv = await get("tv-servers.html", `${BASE}/ajax/v2/episode/servers/${ep[0][1]}`);
    const servers = [...flat(sv.text).split('class="nav-item"').slice(1)].map((x) => x.match(/data-id="([0-9]*)".*title="([^"]*)"/)).filter(Boolean);
    console.log("  servers:", servers.map((s) => `${s[2]} ${s[1]}`).join(" | "));
    const vc = servers.find((s) => /vidcloud/i.test(s[2])) || servers[0];
    if (vc) await stream("tv", hit.id, vc[1], hit.path);
  }
}
