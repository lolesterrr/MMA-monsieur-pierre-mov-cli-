const qs = ["spawn", "game of thrones", "game of", "spawn: the animated", "breaking bad", "the office"];
for (const q of qs) for (const type of ["movie", "series"]) for (let i = 0; i < 2; i++) {
  const u = `https://v3-cinemeta.strem.io/catalog/${type}/top/search=${encodeURIComponent(q)}.json`;
  const t = Date.now();
  try {
    const r = await fetch(u, { headers: { Origin: "https://lolesterrr.github.io" } });
    const txt = await r.text();
    let n = "?", first = "";
    try { const d = JSON.parse(txt); n = (d.metas || []).length; first = (d.metas || []).slice(0, 3).map((m) => m.name).join(" | "); } catch { first = txt.slice(0, 80); }
    console.log(`::notice title=${type} "${q}" #${i}::HTTP ${r.status} ${Date.now() - t}ms acao=${r.headers.get("access-control-allow-origin")} cache=${r.headers.get("cf-cache-status")} n=${n}: ${first}`);
  } catch (e) { console.log(`::notice title=${type} "${q}" #${i}::FAILED ${Date.now() - t}ms ${e.message}`); }
}
