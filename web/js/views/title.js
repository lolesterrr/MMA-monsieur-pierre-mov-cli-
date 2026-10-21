// A movie or a series: poster, the blurb, and for series the seasons and episodes.
import { esc } from "../util.js";
import { catalog, seen, aired } from "../api.js";
import { history, progress, epKey } from "../store.js";
import { state } from "../state.js";
import { hydrate } from "../pierre.js";
import { problem, poster, fixPosters, epCode, seasonName, typeLabel } from "./common.js";

export const title = (params, route) => `${(seen.get(route.id) || {}).title || typeLabel(route.type)} | MMA`;

export async function render(main, params, ctx, route) {
  const { type, id } = route;
  const known = seen.get(id) || { id, type, title: "" };
  state.current = { id, type, title: known.title };

  main.innerHTML = `
  <article class="anime" aria-labelledby="anime-title">
    <header class="anime-head">
      <div class="anime-poster">${poster(known.poster, known.title || "Poster")}<span class="perch" data-pierre="ticket" data-scale="2" data-joke></span></div>
      <div class="anime-info">
        <h1 id="anime-title">${esc(known.title || "…")}</h1>
        <p class="jname" data-facts>${esc([typeLabel(type), known.years || known.year].filter(Boolean).join(" · "))}</p>
        <p class="about" hidden></p>
        <p class="credits fine" hidden></p>
        <div class="anime-actions"><a class="btn primary play" href="#" hidden></a></div>
      </div>
    </header>
    <section class="episodes" aria-labelledby="eps-title" ${type === "movie" ? "hidden" : ""} aria-busy="true">
      <h2 id="eps-title">Episodes</h2>
      <div class="loading"><span data-pierre="think" data-scale="4"></span><p class="bubble bubble-left">Counting episodes…</p></div>
    </section>
  </article>`;
  hydrate(main);
  fixPosters(main, hydrate);

  const head = main.querySelector(".anime-head");
  let meta;
  const load = async () => {
    try {
      meta = await catalog.meta(type, id, { signal: ctx.signal });
    } catch (err) {
      if (err.code === "aborted") return;
      main.querySelector(".episodes").hidden = true;
      head.outerHTML = `<header class="anime-head anime-head-problem">${problem(err, { kind: "wrong", anim: err.code === "not_found" ? "shrug" : "knock" })}</header>`;
      hydrate(main);
      const retry = main.querySelector("[data-retry]");
      if (retry) retry.addEventListener("click", () => render(main, params, ctx, route));
      return;
    }
  };
  await load();
  if (!meta || ctx.signal.aborted) return;
  seen.remember([meta]);
  state.current = { id, type, title: meta.title };
  document.title = `${meta.title} | MMA`;

  main.querySelector("#anime-title").textContent = meta.title;
  const facts = [typeLabel(type), meta.years || meta.year, meta.runtime, (meta.genres || []).slice(0, 3).join(", "), meta.rating ? `IMDb ${meta.rating}` : ""].filter(Boolean);
  main.querySelector("[data-facts]").textContent = facts.join(" · ");
  if (meta.description) {
    const about = main.querySelector(".about");
    about.textContent = meta.description;
    about.hidden = false;
  }
  const credits = [meta.director.length ? `Directed by ${meta.director.join(", ")}` : "", meta.cast.length ? `With ${meta.cast.join(", ")}` : ""].filter(Boolean);
  if (credits.length) {
    const c = main.querySelector(".credits");
    c.textContent = credits.join(". ") + ".";
    c.hidden = false;
  }
  if (meta.poster && meta.poster !== known.poster) {
    const box = main.querySelector(".anime-poster");
    box.querySelector(".poster, .poster-none").outerHTML = poster(meta.poster, meta.title);
    fixPosters(box, hydrate);
    hydrate(box);
  }

  const play = main.querySelector(".play");
  const h = history.get(id);
  if (type === "movie") {
    const started = progress.started(id) && !progress.watched(id);
    play.hidden = false;
    play.href = `#/watch/movie/${id}`;
    play.textContent = started ? "Continue watching" : progress.watched(id) ? "Watch again" : "Watch";
    return;
  }

  // ---- series
  const section = main.querySelector(".episodes");
  section.setAttribute("aria-busy", "false");
  const eps = meta.episodes;
  if (!eps.length) {
    section.innerHTML = `<h2 id="eps-title">Episodes</h2>
      <div class="empty"><span data-pierre="shrug" data-scale="4"></span><p>No episodes are listed for this one yet.</p></div>`;
    hydrate(section);
    return;
  }
  const seasons = [...new Set(eps.map((e) => e.s))];
  const firstAired = eps.find((e) => e.s > 0 && aired(e)) || eps[0];
  const resume = h && eps.find((e) => e.s === Number(h.s) && e.e === Number(h.e));
  const start = resume || firstAired;
  play.hidden = false;
  play.href = `#/watch/series/${id}/${start.s}/${start.e}`;
  play.textContent = resume ? `Continue ${epCode(start.s, start.e)}` : `Start ${epCode(start.s, start.e)}`;

  const wanted = params.has("season") ? Number(params.get("season")) : NaN;
  let current = seasons.includes(wanted) ? wanted : start.s;

  const draw = () => {
    const list = eps.filter((e) => e.s === current);
    section.innerHTML = `
      <h2 id="eps-title">Episodes <span class="count">${eps.filter((e) => e.s > 0).length}</span></h2>
      ${
        seasons.length > 1
          ? `<div class="ranges" role="tablist" aria-label="Seasons">${seasons
              .map((s) => `<button type="button" role="tab" aria-selected="${s === current}" data-season="${s}">${esc(seasonName(s))}</button>`)
              .join("")}</div>`
          : ""
      }
      <ol class="ep-list">${list
        .map((e) => {
          const k = epKey(e.s, e.e);
          const watched = progress.watched(id, k);
          const isLast = h && Number(h.s) === e.s && Number(h.e) === e.e;
          const out = aired(e);
          const name = e.title && !/^episode \d+$/i.test(e.title) ? e.title : "";
          const label = `${epCode(e.s, e.e)}${name ? `: ${name}` : ""}${watched ? ", watched" : ""}${out ? "" : ", not out yet"}`;
          const date = e.aired ? new Date(e.aired).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : "";
          const inner = `
            <span class="ep-thumb">${e.thumb ? `<img src="${esc(e.thumb)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}<span class="ep-num">${e.e}</span></span>
            <span class="ep-text">
              <span class="ep-title">${esc(name || `Episode ${e.e}`)}</span>
              <span class="ep-meta">${esc(epCode(e.s, e.e))}${date ? ` · ${esc(out ? date : `out ${date}`)}` : ""}${watched ? " · watched" : isLast ? " · you were here" : ""}</span>
              ${e.overview ? `<span class="ep-over">${esc(e.overview)}</span>` : ""}
            </span>`;
          return `<li>${
            out
              ? `<a class="ep-row${watched ? " watched" : ""}${isLast ? " last" : ""}" href="#/watch/series/${id}/${e.s}/${e.e}" aria-label="${esc(label)}">${inner}</a>`
              : `<div class="ep-row upcoming" aria-label="${esc(label)}">${inner}</div>`
          }</li>`;
        })
        .join("")}</ol>`;
    for (const btn of section.querySelectorAll("[data-season]")) {
      btn.addEventListener("click", () => {
        current = Number(btn.dataset.season);
        window.history.replaceState(null, "", `#/title/series/${id}?season=${current}`);
        draw();
        section.querySelector(`[data-season="${current}"]`).focus();
      });
    }
  };
  draw();
}
