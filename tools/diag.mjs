import { writeFileSync } from "node:fs";
import { createHandler } from "../worker/core.js";
const WORKER = "https://mma.kajjabwangulester.workers.dev";
const DENO = "https://mma-monsieur-pierre-mov-cli.lolesterrr.deno.net";
const H = { Origin: "https://lolesterrr.github.io" };
const out = {};
const cine = async (type, q) => {
  const r = await (await fetch(`https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(q)}.json`)).json();
  return (r.metas || []).slice(0, 4).map((m) => ({ id: m.imdb_id || m.id, name: m.name, year: m.releaseInfo, type }));
};
out.search = [...(await cine("movie", "You Can See Everything")), ...(await cine("series", "You Can See Everything"))];
const pick = out.search[0];
const meta = pick ? (await (await fetch(`https://v3-cinemeta.strem.io/meta/${pick.type}/${pick.id}.json`)).json()).meta : null;
out.meta = meta && { id: meta.imdb_id, name: meta.name, tmdb: meta.moviedb_id, year: meta.releaseInfo, released: meta.released, eps: (meta.videos || []).length, type: pick.type };
const q = (m, type, extra = "") => `type=${type}&imdb=${m.imdb_id}&tmdb=${m.moviedb_id || ""}&title=${encodeURIComponent(m.name)}&year=${(String(m.releaseInfo || "").match(/\d{4}/) || [""])[0]}${extra}`;
const ep = meta && pick.type === "series" ? (() => { const v = (meta.videos || []).find((x) => x.season === 1 && x.episode === 1); return v ? "&s=1&e=1" : ""; })() : "";
// raw hexa from here: what exactly says 403
const raw = [];
const handle = createHandler({ upstream: async (url, init, kind) => { const r = await fetch(url, init); raw.push(`${kind} ${r.status} ${url.slice(0, 110)}`); return r; } });
out.local = {};
for (const server of ["hexa", "videasy", "vidlink", "lookmovie"]) {
  if (!meta) break;
  raw.length = 0;
  const r = await handle(new Request(`https://l.test/api/sources?${q(meta, pick.type, ep)}&server=${server}&fresh=1`), { SIGNING_KEY: "x" });
  const j = await r.json();
  out.local[server] = { status: r.status, server: j.server, kind: j.kind, files: j.files && j.files.map((f) => f.codec + f.h), message: j.message, calls: [...raw] };
}
// hexa on a few known titles from here
out.hexaKnown = {};
for (const [n, path] of [["Inception", "type=movie&imdb=tt1375666&tmdb=27205&title=Inception&year=2010"], ["Breaking Bad 1x1", "type=series&imdb=tt0903747&tmdb=1396&title=Breaking%20Bad&year=2008&s=1&e=1"], ["Rehearsal 2x1", "type=series&imdb=tt10802170&tmdb=204284&title=The%20Rehearsal&year=2022&s=2&e=1"]]) {
  raw.length = 0;
  const r = await handle(new Request(`https://l.test/api/sources?${path}&server=hexa&fresh=1`), { SIGNING_KEY: "x" });
  const j = await r.json();
  out.hexaKnown[n] = { status: r.status, message: j.message, calls: [...raw] };
}
// the deployed worker and helper
for (const [name, base] of [["worker", WORKER], ["deno", DENO]]) {
  const h = await (await fetch(`${base}/api/health`, { headers: H })).json().catch((e) => ({ e: e.message }));
  out[name] = { version: h.version, servers: h.servers, runs: {} };
  if (!meta) continue;
  for (const server of ["auto", "hexa", "videasy", "vidlink"]) {
    const t = Date.now();
    const r = await fetch(`${base}/api/sources?${q(meta, pick.type, ep)}&server=${server}`, { headers: H, signal: AbortSignal.timeout(60000) }).catch((e) => ({ status: 0, json: async () => ({ message: e.message }) }));
    const j = await r.json().catch(() => ({}));
    out[name].runs[server] = { status: r.status, s: (Date.now() - t) / 1000, got: j.server, kind: j.kind, message: j.message && j.message.slice(0, 300) };
  }
}
writeFileSync("diag-out.json", JSON.stringify(out, null, 1));
