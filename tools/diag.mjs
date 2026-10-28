// VidLink MP4s: which headers each copy needs, and can the deployed worker's /api/reach fetch them
import { writeFileSync } from "node:fs";
const APP = "com.community.oneroom/50020115 (Linux; U; Android 15; en_US; OPPO CPH2579; Build/AP3A.240905.015.A2; Cronet/140.0.7339.51)";
const BUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const VL = { Origin: "https://vidlink.pro", Referer: "https://vidlink.pro/" };
const out = {};
const st = async (url, headers) => { try { const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) }); const b = await r.arrayBuffer(); return `${r.status} ${r.headers.get("content-type")} ${b.byteLength}b ${r.headers.get("content-range") || ""}`; } catch (e) { return `ERR ${e.message}`; } };
for (const [name, type, tmdb, s, e] of [["Rehearsal S1E1", "tv", "204284", 1, 1], ["Inception", "movie", "27205"], ["Prestige", "movie", "1124"], ["Breaking Bad S1E1", "tv", "1396", 1, 1], ["Rehearsal S2E3", "tv", "204284", 2, 3]]) {
  const ej = await (await fetch(`https://enc-dec.app/api/enc-vidlink?text=${tmdb}`)).json().catch(() => ({}));
  if (!ej.result) { out[name] = { enc: ej }; continue; }
  const r = await fetch(`https://vidlink.pro/api/b/${type}/${encodeURIComponent(ej.result)}${type === "tv" ? `/${s}/${e}` : ""}`, { headers: { "User-Agent": BUA, ...VL } });
  const text = await r.text();
  let d = null; try { d = JSON.parse(text); } catch {}
  const res = { api: r.status, sourceId: d && d.sourceId, streamType: d && d.stream && d.stream.type, keys: d && d.stream && Object.keys(d.stream), captions: d && d.stream && (d.stream.captions || []).slice(0, 3).map((c) => ({ lang: c.language || c.lang, url: (c.url || "").slice(0, 60), type: c.type })), files: {} };
  if (!d) res.head = text.slice(0, 300);
  for (const [q, v] of Object.entries((d && d.stream && d.stream.qualities) || {})) {
    const R = { Range: "bytes=0-65535" };
    res.files[q] = {
      codec: v.codecName, headers: v.headers,
      appUA: await st(v.url, { ...R, "User-Agent": APP, Accept: "*/*" }),
      appUAvlRef: await st(v.url, { ...R, "User-Agent": APP, ...VL }),
      browserUA: await st(v.url, { ...R, "User-Agent": BUA }),
      reachFromCloudflare: await fetch(`https://mma.kajjabwangulester.workers.dev/api/reach?u=${encodeURIComponent(v.url)}&ref=`).then((x) => x.text()).catch((e) => e.message),
    };
  }
  if (d && d.stream && d.stream.playlist) res.playlist = { url: d.stream.playlist.slice(0, 100), headers: d.stream.headers, vl: await st(d.stream.playlist, { "User-Agent": BUA, ...VL }) };
  out[name] = res;
}
writeFileSync("diag-out.json", JSON.stringify(out, null, 1));
