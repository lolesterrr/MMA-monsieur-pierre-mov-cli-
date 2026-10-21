// Where MMA's Cloudflare worker lives. After deploying the worker (see the README),
// put its address here. A worker named "mma" on Kajja's account lives at the address below.
window.MMA_CONFIG = {
  api: "https://mma.kajjabwangulester.workers.dev",
  // where complaints go when the worker can't file them itself
  repo: "lolesterrr/MMA-monsieur-pierre-mov-cli-",
  // the lookup helper on Deno Deploy (deno/main.js), for sources that refuse Cloudflare.
  // Leave it empty if you don't run one.
  lookup: "",
  // the public movie and series catalog (search, posters, episode lists)
  catalog: "https://v3-cinemeta.strem.io",
};
