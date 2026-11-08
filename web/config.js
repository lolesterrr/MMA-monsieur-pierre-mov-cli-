// Where MMA's Cloudflare worker lives. After deploying the worker (see the README),
// put its address here. A worker named "mma" on Kajja's account lives at the address below.
window.MMA_CONFIG = {
  api: "https://mma.kajjabwangulester.workers.dev",
  // where complaints go when the worker can't file them itself
  repo: "lolesterrr/MMA-monsieur-pierre-mov-cli-",
  // the lookup helper on Deno Deploy (deno/main.js), for sources that refuse Cloudflare.
  // Leave it empty if you don't run one.
  lookup: "https://mma-monsieur-pierre-mov-cli.lolesterrr.deno.net",
  // Maintenance: true shows everyone Pierre's "under maintenance" page instead of the site.
  // The owner still gets the real site: open the site once with ?pierre=<the passphrase>
  // (only its SHA-256 is here) and that browser remembers it. ?pierre=off forgets it again.
  // The local helper (node local/server.mjs) doesn't use this file, so it always works.
  maintenance: true,
  maintenanceKey: "c060381bb81e9503d9037372e5683245e674068dfc0c1af1eb05f01086b90008",
  // the public movie and series catalog (search, posters, episode lists)
  catalog: "https://v3-cinemeta.strem.io",
};
