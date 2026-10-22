import { esc, minutesLeft } from "../util.js";
import { history, progress, recent, settings, epKey } from "../store.js";
import { isConfigured, catalog, catalogBase, seen, internetDown } from "../api.js";
import { hydrate } from "../pierre.js";
import { poster, fixPosters, epCode, typeLabel } from "./common.js";

export const title = "MMA";

export function render(main, params, ctx) {
  if (!isConfigured()) return renderSetup(main, ctx);
  const items = history.all().slice(0, 12);
  const searches = recent.all();
  main.innerHTML = `
  <section class="hero" aria-labelledby="hero-title">
    <div class="hero-pierre">
      <span data-pierre="bonjour" data-scale="6" data-joke></span>
      <p class="bubble bubble-left">Bonjour.\nWhat are we watching tonight?</p>
    </div>
    <div class="hero-main">
      <h1 id="hero-title" class="sr">Search movies and series</h1>
      <form class="hero-search" role="search" data-search>
        <label class="sr" for="hero-q">Search movies and series</label>
        <input id="hero-q" type="search" name="q" placeholder="Search movies and series" autocomplete="off" enterkeyhint="search" required>
        <button class="btn primary" type="submit">Search</button>
      </form>
      ${
        searches.length
          ? `<div class="recent"><span class="recent-label">Recent searches</span>
             ${searches.map((q) => `<a class="chip" href="#/search?q=${encodeURIComponent(q)}">${esc(q)}</a>`).join("")}</div>`
          : ""
      }
    </div>
  </section>

  <section class="continue" aria-labelledby="cw-title">
    <h2 id="cw-title">Continue watching</h2>
    ${
      items.length
        ? `<ul class="cw-list">${items.map(card).join("")}</ul>`
        : `<div class="empty">
             <span data-pierre="sleep" data-scale="4"></span>
             <p>Movies and series you start show up here, so you can pick up where you left off. They're saved in this browser only.</p>
           </div>`
    }
  </section>

  <section class="popular" aria-labelledby="pop-title">
    <div class="popular-head">
      <h2 id="pop-title">Popular right now</h2>
      <div class="seg" role="radiogroup" aria-label="Show popular">
        <button type="button" role="radio" aria-checked="true" data-pop="movie">Movies</button>
        <button type="button" role="radio" aria-checked="false" data-pop="series">Series</button>
      </div>
    </div>
    <ul class="grid" data-popular aria-busy="true"></ul>
  </section>`;
  hydrate(main);
  fixPosters(main, hydrate);
  main.addEventListener(
    "click",
    (e) => {
      const btn = e.target.closest("[data-forget]");
      if (btn) {
        e.preventDefault();
        history.forget(btn.dataset.forget);
        const li = btn.closest("li");
        if (li) li.remove();
        if (!main.querySelector(".cw-list li")) {
          const empty = main.querySelector(".cw-list");
          empty.outerHTML = `<div class="empty"><span data-pierre="sleep" data-scale="4"></span><p>Nothing to continue. Pierre approves of this level of rest.</p></div>`;
          hydrate(main);
        }
        return;
      }
      const pop = e.target.closest("[data-pop]");
      if (pop) {
        for (const b of main.querySelectorAll("[data-pop]")) b.setAttribute("aria-checked", String(b === pop));
        loadPopular(main, pop.dataset.pop, ctx);
      }
    },
    { signal: ctx.signal },
  );
  loadPopular(main, "movie", ctx);
}

async function loadPopular(main, type, ctx) {
  const list = main.querySelector("[data-popular]");
  list.setAttribute("aria-busy", "true");
  let metas = [];
  try {
    const res = await fetch(`${catalogBase()}/catalog/${type}/top.json`, { signal: ctx.signal });
    metas = ((await res.json()).metas || []).filter((m) => /^tt\d+$/.test(m.imdb_id || m.id || "")).slice(0, 18);
  } catch {
    if (ctx.signal.aborted) return;
    list.innerHTML = (await internetDown()) ? `<li class="fine">Bro, your internet might be shit. Popular stuff shows up when it's back.</li>` : `<li class="fine">The catalog didn't answer. Search still works most of the time.</li>`;
    list.setAttribute("aria-busy", "false");
    return;
  }
  if (ctx.signal.aborted) return;
  const cards = metas.map((m) => ({ id: m.imdb_id || m.id, type, title: m.name, poster: m.poster, year: (String(m.releaseInfo || "").match(/\d{4}/) || [""])[0], years: m.releaseInfo || "" }));
  seen.remember(cards);
  list.innerHTML = cards.map(showCard).join("");
  list.setAttribute("aria-busy", "false");
  hydrate(list);
  fixPosters(list, hydrate);
}

export function showCard(s) {
  const tags = [typeLabel(s.type)];
  if (s.years || s.year) tags.push(esc(s.years || s.year));
  return `
  <li>
    <a class="show" href="#/title/${s.type}/${s.id}">
      ${poster(s.poster, s.title)}
      <span class="show-title">${esc(s.title)}</span>
      <span class="tags">${tags.map((t) => `<span class="tag">${t}</span>`).join("")}</span>
    </a>
  </li>`;
}

export function watchHref(h) {
  const base = h.type === "series" ? `#/watch/series/${h.id}/${h.s}/${h.e}` : `#/watch/movie/${h.id}`;
  return h.server ? `${base}?server=${h.server}` : base;
}

function card(h) {
  const p = progress.get(h.id, epKey(h.s, h.e));
  const pct = p && p.d ? Math.min(100, Math.round((p.t / p.d) * 100)) : 0;
  const sub = h.type === "series" ? `${epCode(h.s, h.e)}${h.epTitle ? `: ${h.epTitle}` : ""}` : `Movie${h.year ? `, ${h.year}` : ""}`;
  return `
  <li class="cw">
    <a class="cw-link" href="${watchHref(h)}">
      ${poster(h.poster, h.title, "cw-poster")}
      <span class="cw-text">
        <span class="cw-title">${esc(h.title)}</span>
        <span class="cw-ep">${esc(sub)}</span>
        <span class="bar" aria-hidden="true"><span style="width:${pct}%"></span></span>
        <span class="cw-left">${p ? esc(minutesLeft(p.t, p.d)) : "not started"}</span>
      </span>
    </a>
    <button class="cw-forget" type="button" data-forget="${esc(h.id)}" aria-label="Remove ${esc(h.title)} from Continue watching" title="Remove">×</button>
  </li>`;
}

function renderSetup(main, ctx) {
  main.innerHTML = `
  <section class="setup panel" aria-labelledby="setup-title">
    <span data-pierre="shrug" data-scale="5"></span>
    <div>
      <h1 id="setup-title">MMA needs its worker</h1>
      <p>The site is up, but it doesn't know where its Cloudflare worker lives yet. Deploy the worker (the README walks through it in about five minutes), then paste its address here or into <code>web/config.js</code>.</p>
      <form class="setup-form" data-setup>
        <label class="field"><span>Worker address</span>
          <input type="url" name="api" required placeholder="https://mma.your-name.workers.dev" autocomplete="off"></label>
        <button class="btn primary" type="submit">Connect</button>
      </form>
      <p class="fine">Running the local helper instead? Open <code>http://localhost:8787</code> and it connects by itself.</p>
    </div>
  </section>`;
  hydrate(main);
  main.querySelector("[data-setup]").addEventListener(
    "submit",
    (e) => {
      e.preventDefault();
      const url = new FormData(e.target).get("api").trim().replace(/\/+$/, "");
      settings.setApiOverride(url);
      location.reload();
    },
    { signal: ctx.signal },
  );
}
