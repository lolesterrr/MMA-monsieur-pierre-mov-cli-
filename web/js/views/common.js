// Bits several views share: the problem panel, poster images and episode labels.
import { esc } from "../util.js";
import { noteError } from "../state.js";

const COPY = {
  blocked: {
    title: "Cloudflare stopped the worker at the door",
    body: "A stream source has its bot check up and turned the worker away. Try another server, or again in a few minutes. If it keeps happening, run the local helper on your computer (it's in the README).",
  },
  unreachable: {
    title: "Can't reach the worker",
    body: (e) => `${e.message} If it worked earlier today, it has probably used up Cloudflare's free daily limit, which resets at midnight UTC. Otherwise, check the worker address in Backstage, at the bottom of the page.`,
  },
  catalog: { title: "The catalog isn't answering", body: (e) => `${e.message} It's Stremio's public catalog, and it's usually back within minutes.` },
  not_found: { title: "Pierre can't find this one", body: "The catalog doesn't know this title. It may have been merged with another entry. Try searching for it again." },
  timeout: { title: "That's taking too long", body: "The sources might be slow right now. Try again in a moment, or pick another server." },
  setup: { title: "The worker isn't finished setting up", body: (e) => e.message },
  upstream: { title: "A source didn't answer properly", body: (e) => e.message },
  decrypt: { title: "A source changed something", body: (e) => `${e.message} When enc-dec.app ships a fix, MMA picks it up by itself.` },
  slow_down: { title: "Too many requests", body: (e) => e.message },
};

/** Markup for a problem panel. Buttons: [data-retry] and [data-complain]. */
export function problem(err, { title, body, kind = "other", retry = true, anim = "knock", extra = "" } = {}) {
  noteError(err);
  const c = COPY[err && err.code] || {};
  const t = title || c.title || "Something went wrong";
  const b = body || (typeof c.body === "function" ? c.body(err) : c.body) || (err && err.message) || "Try again in a moment.";
  return `
  <div class="problem" role="alert">
    <span data-pierre="${anim}" data-scale="4"></span>
    <div class="problem-text">
      <h2>${esc(t)}</h2>
      <p>${esc(b)}</p>
      ${extra}
      <div class="row">
        ${retry ? '<button class="btn primary" type="button" data-retry>Try again</button>' : ""}
        <button class="btn" type="button" data-complain="${esc(kind)}">Report this</button>
      </div>
      ${err && err.code ? `<p class="fine">Error code: ${esc(err.code)}</p>` : ""}
    </div>
  </div>`;
}

/** Poster image, or Pierre's placeholder when there isn't one or it fails. */
export function poster(src, alt, cls = "poster") {
  if (!src) return `<div class="${cls} poster-none" role="img" aria-label="${esc(alt)}"><span data-pierre="sleep" data-scale="3"></span></div>`;
  return `<img class="${cls}" src="${esc(src)}" alt="${esc(alt)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" data-fallback>`;
}

/** Swap broken posters for the placeholder. Call after rendering. */
export function fixPosters(root, hydrate) {
  for (const img of root.querySelectorAll("img[data-fallback]")) {
    img.addEventListener(
      "error",
      () => {
        const div = document.createElement("div");
        div.className = img.className + " poster-none";
        div.setAttribute("role", "img");
        div.setAttribute("aria-label", img.alt);
        div.innerHTML = '<span data-pierre="sleep" data-scale="3"></span>';
        img.replaceWith(div);
        hydrate(div);
      },
      { once: true },
    );
  }
}

/** "S2 E5" / "Special 3" */
export function epCode(s, e) {
  return Number(s) === 0 ? `Special ${e}` : `S${s} E${e}`;
}

/** "Season 2" / "Specials" */
export function seasonName(s) {
  return Number(s) === 0 ? "Specials" : `Season ${s}`;
}

export const typeLabel = (t) => (t === "series" ? "Series" : "Movie");
