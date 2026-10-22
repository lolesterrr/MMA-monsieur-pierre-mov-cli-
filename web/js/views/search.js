import { esc } from "../util.js";
import { catalog, seen } from "../api.js";
import { recent } from "../store.js";
import { hydrate } from "../pierre.js";
import { problem, fixPosters, judge } from "./common.js";
import { showCard } from "./home.js";
import { openDesk } from "../complaint.js";

export const title = (params) => `${params.get("q") || "Search"} | MMA`;

const FILTERS = [
  ["all", "Everything"],
  ["movie", "Movies"],
  ["series", "Series"],
];

export async function render(main, params, ctx) {
  const q = (params.get("q") || "").trim();
  if (!q) {
    location.replace("#/");
    return;
  }
  recent.add(q);
  const head = `<h1 id="results-title" class="page-title">“${esc(q)}”</h1>`;
  main.innerHTML = `
  <section class="results" aria-labelledby="results-title" aria-busy="true">
    ${head}
    <div class="loading">
      <span data-pierre="search" data-scale="4"></span>
      <p class="bubble bubble-left">Looking…</p>
    </div>
  </section>`;
  hydrate(main);
  const section = main.querySelector(".results");

  const load = async () => {
    let list;
    try {
      list = await catalog.search(q, { signal: ctx.signal });
    } catch (err) {
      if (err.code === "aborted") return;
      section.setAttribute("aria-busy", "false");
      section.innerHTML = `${head}${problem(err, { kind: "search" })}`;
      hydrate(section);
      section.querySelector("[data-retry]").addEventListener("click", () => {
        section.innerHTML = `${head}<div class="loading"><span data-pierre="search" data-scale="4"></span><p class="bubble bubble-left">Looking again…</p></div>`;
        hydrate(section);
        load();
      });
      return;
    }
    if (ctx.signal.aborted) return;
    section.setAttribute("aria-busy", "false");
    seen.remember(list);
    if (!list.length) {
      section.innerHTML = `
        ${head}${judge(q)}
        <div class="empty empty-wide">
          <span data-pierre="sad" data-scale="4"></span>
          <div>
            <p class="empty-lead">Nothing called “${esc(q)}”.</p>
            <p>Check the spelling or try fewer words. The original title works too (La Haine, Parasite, Dark).</p>
            <button class="btn" type="button" data-missing>Tell Pierre what's missing</button>
          </div>
        </div>`;
      hydrate(section);
      section.querySelector("[data-missing]").addEventListener("click", () => openDesk({ kind: "search", message: `I searched for "${q}" and got nothing. I was looking for: ` }));
      return;
    }
    const counts = { all: list.length, movie: list.filter((s) => s.type === "movie").length, series: list.filter((s) => s.type === "series").length };
    let filter = params.get("only") === "movie" || params.get("only") === "series" ? params.get("only") : "all";
    const draw = () => {
      const shown = filter === "all" ? list : list.filter((s) => s.type === filter);
      section.innerHTML = `
        ${head}${judge(q)}
        <div class="results-bar">
          <p class="count">${counts.movie === 1 ? "1 movie" : `${counts.movie} movies`}, ${counts.series === 1 ? "1 series" : `${counts.series} series`}</p>
          <div class="seg" role="radiogroup" aria-label="Show">
            ${FILTERS.filter(([k]) => k === "all" || counts[k])
              .map(([k, label]) => `<button type="button" role="radio" aria-checked="${k === filter}" data-filter="${k}">${label}</button>`)
              .join("")}
          </div>
        </div>
        <ul class="grid">${shown.map(showCard).join("")}</ul>`;
      hydrate(section);
      fixPosters(section, hydrate);
      for (const b of section.querySelectorAll("[data-filter]")) {
        b.addEventListener("click", () => {
          filter = b.dataset.filter;
          history.replaceState(null, "", `#/search?q=${encodeURIComponent(q)}${filter === "all" ? "" : `&only=${filter}`}`);
          draw();
          section.querySelector(`[data-filter="${filter}"]`).focus();
        });
      }
    };
    draw();
  };
  await load();
}
