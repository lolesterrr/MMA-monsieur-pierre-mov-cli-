import { writeFileSync } from "node:fs";
const DENO = "https://mma-monsieur-pierre-mov-cli.lolesterrr.deno.net";
const WORKER = "https://mma.kajjabwangulester.workers.dev";
const H = { Origin: "https://lolesterrr.github.io" };
const out = {};
const yc = "type=movie&imdb=tt45368240&tmdb=1765072&title=You%20Can%20See%20Everything&year=2026";
for (const [name, base] of [["deno", DENO], ["worker", WORKER]]) {
  const h = await (await fetch(`${base}/api/health?deep=1`, { headers: H })).json().catch((e) => ({ e: e.message }));
  out[name] = { version: h.version, servers: h.servers, deep: h.sources, runs: {} };
  for (const server of ["auto", "videasy", "vidlink", "hexa"]) {
    const t = Date.now();
    const r = await fetch(`${base}/api/sources?${yc}&server=${server}&fresh=1`, { headers: H, signal: AbortSignal.timeout(60000) }).catch((e) => null);
    const j = r ? await r.json().catch(() => ({})) : {};
    out[name].runs[server] = { status: r && r.status, s: (Date.now() - t) / 1000, got: j.server, kind: j.kind, message: j.message && j.message.slice(0, 300) };
    if (j.files && j.files[0]) {
      const f = await fetch(j.files[0].url, { headers: { Range: "bytes=0-65535" } }).catch(() => null);
      out[name].runs[server].fileThroughRelay = f ? `${f.status} ${f.headers.get("content-type")} ${(await f.arrayBuffer()).byteLength}b` : "fail";
    }
  }
}
// Hexa TV 403: header variants from GitHub
const hexa = async (path, { ua, referer, base = "https://theemoviedb.hexa.su", fp = "e9136c41504646444" }) => {
  const tj = await (await fetch("https://enc-dec.app/api/enc-hexa")).json().catch(() => ({}));
  const token = tj.result && tj.result.token;
  if (!token) return `no token (${tj.error})`;
  const key = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const r = await fetch(`${base}/api/tmdb/${path}/images`, { headers: { "User-Agent": ua, Referer: referer, Accept: "text/plain", "X-Fingerprint-Lite": fp, "X-Api-Key": key, "X-Cap-Token": token } });
  const text = await r.text();
  let dec = "";
  if (r.ok) {
    const dj = await (await fetch("https://enc-dec.app/api/dec-hexa", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, key }) })).json().catch(() => ({}));
    dec = ` dec=${dj.status} n=${dj.result && (dj.result.sources || []).length}`;
  }
  return `${r.status} ${text.slice(0, 80).replace(/\s+/g, " ")}${dec}`;
};
const UA137 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36";
const UA141 = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
out.hexaTv = {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const [label, path, opts] of [
  ["cyberpunk sample exact", "tv/105248/season/1/episode/1", { ua: UA137, referer: "https://hexa.su/" }],
  ["bb ua141", "tv/1396/season/1/episode/1", { ua: UA141, referer: "https://hexa.su/" }],
  ["bb ua137", "tv/1396/season/1/episode/1", { ua: UA137, referer: "https://hexa.su/" }],
  ["bb flixer referer", "tv/1396/season/1/episode/1", { ua: UA137, referer: "https://flixer.su/" }],
  ["bb flixer host", "tv/1396/season/1/episode/1", { ua: UA137, referer: "https://flixer.su/", base: "https://theemoviedb.flixer.su" }],
  ["movie inception ua137", "movie/27205", { ua: UA137, referer: "https://hexa.su/" }],
  ["movie you-can-see ua137", "movie/1765072", { ua: UA137, referer: "https://hexa.su/" }],
]) {
  out.hexaTv[label] = await hexa(path, opts).catch((e) => `ERR ${e.message}`);
  await sleep(800);
}
writeFileSync("diag-out.json", JSON.stringify(out, null, 1));
