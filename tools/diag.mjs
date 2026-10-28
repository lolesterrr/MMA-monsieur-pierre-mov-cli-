// What does the relay make of the playlists hls.js can't parse? Runs the worker code here.
import { writeFileSync } from "node:fs";
import { createHandler } from "../worker/core.js";
const raw = [];
const handle = createHandler({
  upstream: async (url, init, kind) => {
    const res = await fetch(url, init);
    if (kind === "media") {
      const copy = res.clone();
      const type = res.headers.get("content-type") || "";
      const buf = new Uint8Array(await copy.arrayBuffer());
      const head = new TextDecoder().decode(buf.slice(0, 4000));
      raw.push({ url, status: res.status, type, bytes: buf.length, head: /EXTM3U/.test(head) ? head : head.slice(0, 120) });
    }
    return res;
  },
});
const env = { SIGNING_KEY: "diag-key" };
const O = "https://w.test";
const call = async (path) => {
  const r = await handle(new Request(path.startsWith("http") ? path : O + path, { headers: { Origin: "https://lolesterrr.github.io" } }), env);
  return { status: r.status, type: r.headers.get("content-type"), text: await r.text() };
};
const lines = (t) => t.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
const out = {};
for (const [name, q] of [
  ["rehearsal-s1e1-videasy", "type=series&imdb=tt10802170&tmdb=204284&title=The%20Rehearsal&year=2022&s=1&e=1&server=videasy"],
  ["prestige-hexa", "type=movie&imdb=tt0482571&tmdb=1124&title=The%20Prestige&year=2006&server=hexa"],
  ["prestige-videasy", "type=movie&imdb=tt0482571&tmdb=1124&title=The%20Prestige&year=2006&server=videasy"],
]) {
  raw.length = 0;
  const s = await call(`/api/sources?${q}`);
  const r = { sources: s.status, body: s.text.slice(0, 400) };
  let j = null;
  try { j = JSON.parse(s.text); } catch {}
  if (j && j.master) {
    const m = await call(j.master.replace(/^https?:\/\/[^/]+/, O));
    r.master = { status: m.status, type: m.type, text: m.text.slice(0, 3000) };
    const level = lines(m.text).at(-1);
    if (level) {
      const l = await call(level);
      r.level = { status: l.status, type: l.type, text: l.text.slice(0, 4000) };
    }
  }
  r.upstream = raw.slice(0, 6).map((x) => ({ ...x, head: x.head.slice(0, 3500) }));
  out[name] = r;
}
writeFileSync("diag-out.json", JSON.stringify(out, null, 1));
