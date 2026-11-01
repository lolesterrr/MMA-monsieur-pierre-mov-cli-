// MMA: boot and routing. Hash routes so GitHub Pages never needs server rewrites.
//   #/                                home
//   #/search?q=...                    results
//   #/title/movie/<imdb>              a movie
//   #/title/series/<imdb>?season=2    a series and its episodes
//   #/watch/movie/<imdb>              player
//   #/watch/series/<imdb>/<s>/<e>     player
import { loadPierre, hydrate } from "./pierre.js";
import { wireComplaints } from "./complaint.js";
import { openBackstage } from "./backstage.js";
import { state } from "./state.js";
import * as home from "./views/home.js";
import * as search from "./views/search.js";
import * as titleView from "./views/title.js";
import * as watch from "./views/watch.js";

const ROUTES = [
  { re: /^\/?$/, view: home, name: "home" },
  { re: /^\/search$/, view: search, name: "search" },
  { re: /^\/title\/(movie|series)\/(tt\d+)$/, view: titleView, name: "title", keys: ["type", "id"] },
  { re: /^\/watch\/(movie)\/(tt\d+)$/, view: watch, name: "watch", keys: ["type", "id"] },
  { re: /^\/watch\/(series)\/(tt\d+)\/(\d+)\/(\d+)$/, view: watch, name: "watch", keys: ["type", "id", "s", "e"] },
];

const main = document.getElementById("view");
let current = { controller: null, cleanup: null };
let firstLoad = true;

function parse() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const [path, query = ""] = hash.split("?");
  for (const r of ROUTES) {
    const m = path.match(r.re);
    if (m) {
      const route = {};
      (r.keys || []).forEach((k, i) => (route[k] = decodeURIComponent(m[i + 1])));
      return { r, route, params: new URLSearchParams(query) };
    }
  }
  return { r: ROUTES[0], route: {}, params: new URLSearchParams() };
}

async function navigate() {
  if (current.controller) current.controller.abort();
  if (typeof current.cleanup === "function") {
    try {
      current.cleanup();
    } catch (e) {
      console.error(e);
    }
  }
  const controller = new AbortController();
  current = { controller, cleanup: null };
  const { r, route, params } = parse();
  state.route = location.hash || "#/";
  if (r.name !== "watch" && r.name !== "title") state.current = null;
  document.body.dataset.view = r.name;
  const q = document.querySelector('.top [name="q"]');
  if (q && r.name === "search") q.value = params.get("q") || "";
  else if (q && r.name === "home") q.value = "";
  document.title = typeof r.view.title === "function" ? r.view.title(params, route) : r.view.title || "MMA";
  if (!firstLoad) window.scrollTo({ top: 0 });
  main.setAttribute("aria-busy", "true");
  let cleanup = null;
  try {
    cleanup = await r.view.render(main, params, { signal: controller.signal }, route);
  } catch (e) {
    console.error(e);
  }
  main.removeAttribute("aria-busy");
  if (controller.signal.aborted) {
    if (typeof cleanup === "function") cleanup();
    return;
  }
  current.cleanup = cleanup;
  if (!firstLoad) {
    const h1 = main.querySelector("h1");
    if (h1) {
      h1.tabIndex = -1;
      h1.focus({ preventScroll: true });
    }
  }
  firstLoad = false;
}

function wireSearch() {
  document.addEventListener("submit", (e) => {
    const form = e.target.closest("[data-search]");
    if (!form) return;
    e.preventDefault();
    const q = String(new FormData(form).get("q") || "").trim();
    if (!q) return form.querySelector('[name="q"]').focus();
    const target = `#/search?q=${encodeURIComponent(q)}`;
    if (location.hash === target) navigate();
    else location.hash = target;
    const input = form.querySelector('[name="q"]');
    if (window.matchMedia("(max-width: 640px)").matches) input.blur();
  });
}

// ---- maintenance: config.maintenance shows everyone Pierre's notice; the owner's browser,
// unlocked once with ?pierre=<passphrase>, gets the real site (and a small reminder)
const PASS_KEY = "mma:pierre-pass";
const storeGet = () => {
  try {
    return localStorage.getItem(PASS_KEY) || "";
  } catch {
    return "";
  }
};
const storeSet = (v) => {
  try {
    if (v) localStorage.setItem(PASS_KEY, v);
    else localStorage.removeItem(PASS_KEY);
  } catch {
    /* private window: the passphrase works for this visit only */
  }
};

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** true when this visitor should see the maintenance page */
async function underMaintenance() {
  const cfg = window.MMA_CONFIG || {};
  const url = new URL(location.href);
  const given = url.searchParams.get("pierre");
  let pass = storeGet();
  if (given !== null) {
    url.searchParams.delete("pierre");
    history.replaceState(null, "", url.pathname + url.search + url.hash);
    if (given === "off") {
      storeSet("");
      pass = "";
    } else {
      pass = await sha256(given).catch(() => "");
      storeSet(pass);
    }
  }
  if (!cfg.maintenance) return false;
  return !(cfg.maintenanceKey && pass === cfg.maintenanceKey);
}

function showMaintenance() {
  document.body.dataset.view = "maintenance";
  document.title = "MMA (under maintenance)";
  for (const el of document.querySelectorAll(".top-search, .top .complain, .foot-links")) el.hidden = true;
  main.innerHTML = `
  <section class="maintenance" aria-labelledby="maint-title">
    <span data-pierre="read" data-scale="6"></span>
    <div>
      <h1 id="maint-title">MMA is under maintenance.</h1>
      <p class="bubble bubble-left">making it better..so yeah wait. Try reading a book or something .</p>
    </div>
  </section>`;
  hydrate(main);
}

async function boot() {
  await loadPierre();
  hydrate(document.querySelector(".top"));
  hydrate(document.querySelector(".foot"));
  if (await underMaintenance()) return showMaintenance();
  if ((window.MMA_CONFIG || {}).maintenance) {
    // the owner's view while everyone else sees the notice
    const tag = document.createElement("p");
    tag.className = "maint-tag";
    tag.setAttribute("role", "status");
    tag.innerHTML = 'Maintenance is on: only you see the site. <a href="?pierre=off">See what others see</a>';
    document.body.prepend(tag);
  }
  wireComplaints();
  wireSearch();
  document.querySelector("[data-backstage]").addEventListener("click", openBackstage);
  window.addEventListener("hashchange", navigate);
  // back online: press "Try again" on any "your internet" problem for you
  window.addEventListener("online", () => {
    for (const btn of document.querySelectorAll('.problem[data-code="offline"] [data-retry]')) btn.click();
  });
  await navigate();
}

boot();
