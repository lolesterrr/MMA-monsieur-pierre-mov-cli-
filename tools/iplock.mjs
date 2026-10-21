// Is a stream link tied to the machine that asked for it?
//   node tools/iplock.mjs get   -> writes probe-out/links.json (run on machine A)
//   node tools/iplock.mjs try   -> fetches those links (run on machine B)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
mkdirSync("probe-out", { recursive: true });
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const ED = "https://enc-dec.app/api";
const get = async (u, h = {}, extra = {}) => { const r = await fetch(u, { headers: { "User-Agent": UA, ...h }, signal: AbortSignal.timeout(25000), ...extra }); return { status: r.status, text: await r.text(), acao: r.headers.get("access-control-allow-origin") }; };
const firstSeg = (base, text) => { const l = text.split("\n").find((x) => x && !x.startsWith("#")); return l ? new URL(l, base).href : null; };
const ip = (await get("https://api.ipify.org")).text;

if (process.argv[2] === "get") {
  const links = { ip };
  const lm = JSON.parse((await get("https://lmscript.xyz/v1/movies/view?expand=streams,subtitles&id=9517")).text);
  links.lookmovie = { url: lm.streams["1080p"] || Object.values(lm.streams)[0] };
  const key = randomBytes(32).toString("hex");
  const token = JSON.parse((await get(`${ED}/enc-hexa`)).text).result.token;
  const enc = (await get("https://theemoviedb.hexa.su/api/tmdb/movie/27205/images", { Referer: "https://hexa.su/", Accept: "text/plain", "X-Fingerprint-Lite": "e9136c41504646444", "X-Api-Key": key, "X-Cap-Token": token })).text;
  const hx = await fetch(`${ED}/dec-hexa`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: enc, key }) }).then((r) => r.json());
  links.hexa = { url: hx.result.sources[0].url, all: hx.result.sources.map((s) => s.server) };
  const H = { Origin: "https://player.videasy.to", Referer: "https://player.videasy.to/" };
  const seed = JSON.parse((await get("https://api.wecollege.net/seed?mediaId=27205", H)).text).seed;
  const src = (await get(`https://api.wecollege.net/miami/sources?title=Inception&mediaType=movie&year=2010&tmdbId=27205&imdbId=tt1375666&enc=2&seed=${seed}`, H)).text;
  const vd = await fetch(`${ED}/dec-videasy`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: src, id: "27205", seed }) }).then((r) => r.json());
  links.videasy = { url: vd.result.sources[0].url, referer: "https://player.videasy.to/", subs: (vd.result.subtitles || []).length };
  for (const k of ["lookmovie", "hexa", "videasy"]) {
    const h = links[k].referer ? { Referer: links[k].referer, Origin: links[k].referer.slice(0, -1) } : {};
    const p = await get(links[k].url, h);
    links[k].hereStatus = p.status;
    links[k].seg = firstSeg(links[k].url, p.text);
    if (links[k].seg && /#EXT-X-STREAM-INF/.test(p.text)) { const v = await get(links[k].seg, h); links[k].seg = firstSeg(links[k].seg, v.text); }
  }
  writeFileSync("probe-out/links.json", JSON.stringify(links, null, 2));
  console.log(JSON.stringify(links, null, 2));
} else {
  const links = JSON.parse(readFileSync("probe-out/links.json", "utf8"));
  const out = [`A ip ${links.ip}, B ip ${ip}`];
  for (const k of ["lookmovie", "hexa", "videasy"]) {
    const L = links[k];
    const h = L.referer ? { Referer: L.referer, Origin: L.referer.slice(0, -1) } : {};
    const p = await get(L.url, h).catch((e) => ({ status: "ERR " + e.message }));
    const s = L.seg ? await get(L.seg, h).catch((e) => ({ status: "ERR " + e.message })) : { status: "-" };
    const sp = L.seg ? await get(L.seg, { Origin: "https://lolesterrr.github.io" }).catch((e) => ({ status: "ERR" })) : { status: "-" };
    out.push(`${k}: on A ${L.hereStatus}; on B playlist ${p.status}, segment ${s.status}, segment with pages origin ${sp.status} acao ${sp.acao}`);
  }
  console.log(out.join("\n"));
  writeFileSync("probe-out/iplock.txt", out.join("\n"));
}
