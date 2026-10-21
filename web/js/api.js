// Talking to the MMA worker (or the local helper, which answers the same way),
// and to Cinemeta, the public catalog that has every movie and series with posters and episodes.
import { settings } from "./store.js";

export const APP_VERSION = "1.0.0";
const PLACEHOLDER = /YOUR-SUBDOMAIN/i;
const CATALOG = "https://v3-cinemeta.strem.io";

export function config() {
  return window.MMA_CONFIG || {};
}

export function apiBase() {
  const raw = settings.apiOverride() || config().api || "";
  return String(raw).trim().replace(/\/+$/, "");
}

export function catalogBase() {
  return String(config().catalog || CATALOG).replace(/\/+$/, "");
}

export function isConfigured() {
  const base = apiBase();
  return Boolean(base) && !PLACEHOLDER.test(base) && /^https?:\/\//i.test(base);
}

export class ApiError extends Error {
  constructor(code, message, { status = 0, data = {} } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

const memo = new Map();

async function getJson(url, { method = "GET", body, timeout = 25000, signal, cache = 0, who = "worker" } = {}) {
  if (cache && method === "GET") {
    const hit = memo.get(url);
    if (hit && hit.exp > Date.now()) return hit.data;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new DOMException("timeout", "TimeoutError")), timeout);
  const onAbort = () => ctrl.abort(signal.reason);
  if (signal) {
    if (signal.aborted) ctrl.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  let res;
  try {
    res = await fetch(url, {
      method,
      signal: ctrl.signal,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    if (signal && signal.aborted) throw new ApiError("aborted", "Cancelled.");
    if (ctrl.signal.aborted) throw new ApiError("timeout", `The ${who} took too long to answer (${Math.round(timeout / 1000)}s).`);
    if (who === "catalog") throw new ApiError("catalog", "Can't reach Cinemeta, the catalog MMA searches.");
    throw new ApiError("unreachable", `Can't reach the worker at ${apiBase()}.`);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", onAbort);
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    const d = data || {};
    if (who === "catalog") throw new ApiError(res.status === 404 ? "not_found" : "catalog", res.status === 404 ? "Cinemeta doesn't know this one." : `Cinemeta answered HTTP ${res.status}.`, { status: res.status });
    throw new ApiError(d.error || `http_${res.status}`, d.message || `The worker answered HTTP ${res.status}.`, { status: res.status, data: d });
  }
  if (cache && method === "GET") {
    if (memo.size > 200) memo.delete(memo.keys().next().value);
    memo.set(url, { data, exp: Date.now() + cache });
  }
  return data;
}

const query = (params) => (params ? "?" + new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== "")) : "");

function request(path, { params, ...opts } = {}) {
  if (!isConfigured()) return Promise.reject(new ApiError("not_connected", "MMA isn't connected to its worker yet."));
  return getJson(apiBase() + path + query(params), opts);
}

/** The lookup helper on Deno (deno/main.js), for sources that refuse Cloudflare. "" when there isn't one. */
export function lookupBase() {
  return String(config().lookup || "").trim().replace(/\/+$/, "");
}

/**
 * Ask the worker and the lookup helper at the same time and take whichever finds a stream
 * first (the other one is cancelled). Waiting for the worker to give up before asking the
 * helper made every start slow, because some servers refuse Cloudflare.
 */
async function sources(params, opts = {}) {
  const helper = lookupBase();
  if (!helper) return request("/api/sources", { params, timeout: 45000, ...opts });
  const ctrls = [new AbortController(), new AbortController()];
  const outer = opts.signal;
  const onAbort = () => ctrls.forEach((c) => c.abort());
  if (outer) outer.addEventListener("abort", onAbort, { once: true });
  const ask = (i) =>
    i === 0
      ? request("/api/sources", { params, timeout: 45000, ...opts, signal: ctrls[0].signal })
      : getJson(helper + "/api/sources" + query(params), { timeout: 45000, who: "worker", ...opts, signal: ctrls[1].signal }).then((r) => ({ ...r, via: "lookup" }));
  const attempts = [ask(0), ask(1)];
  try {
    const res = await Promise.any(attempts.map((p, i) => p.then((r) => (ctrls[1 - i].abort(), r))));
    return res;
  } catch (agg) {
    if (outer && outer.aborted) throw new ApiError("aborted", "Cancelled.");
    const [a, b] = agg.errors;
    if (a.code === "no_source" && b.code === "no_source") {
      const tried = [...((a.data && a.data.tried) || []), ...((b.data && b.data.tried) || []).map((t) => ({ ...t, name: `${t.name} (via Deno)` }))].filter((t) => t.error !== "refused");
      throw new ApiError("no_source", a.message, { status: 404, data: { ...a.data, tried } });
    }
    // the more useful of the two errors: a real "nothing here" beats "couldn't reach"
    throw a.code === "no_source" || a.code === "setup" ? a : b.code === "no_source" ? b : a;
  } finally {
    if (outer) outer.removeEventListener("abort", onAbort);
  }
}

export const api = {
  health: (deep = false, opts = {}) => request("/api/health", { params: { deep: deep ? 1 : "" }, timeout: deep ? 45000 : 15000, ...opts }),
  sources: ({ type, imdb, tmdb, title, year, s, e, server, fresh }, opts = {}) => sources({ type, imdb, tmdb, title, year, s, e, server, fresh: fresh ? 1 : "" }, opts),
  lookupHealth: (opts = {}) => getJson(lookupBase() + "/api/health?deep=1", { timeout: 45000, ...opts }),
  complain: (payload, opts = {}) => request("/api/complaint", { method: "POST", body: payload, timeout: 20000, ...opts }),
};

// ---------------------------------------------------------------------------
// Cinemeta

const year = (m) => (String(m.releaseInfo || m.year || "").match(/\d{4}/) || [""])[0];
const years = (m) => String(m.releaseInfo || m.year || "").replace(/[-–]\s*$/, "–").trim();

function card(m, type) {
  return {
    id: m.imdb_id || m.id,
    type,
    title: m.name,
    poster: m.poster || null,
    year: year(m),
    years: years(m),
  };
}

export const catalog = {
  /** Movies and series in one list, best matches first. */
  async search(q, opts = {}) {
    const one = (type) =>
      getJson(`${catalogBase()}/catalog/${type}/top/search=${encodeURIComponent(q)}.json`, { who: "catalog", cache: 10 * 60e3, timeout: 15000, ...opts }).then(
        (d) => ((d && d.metas) || []).filter((m) => /^tt\d+$/.test(m.imdb_id || m.id || "")).map((m) => card(m, type)),
        (e) => {
          if (e.code === "aborted") throw e;
          return e;
        },
      );
    const [movies, series] = await Promise.all([one("movie"), one("series")]);
    if (movies instanceof Error && series instanceof Error) throw movies;
    const a = movies instanceof Error ? [] : movies;
    const b = series instanceof Error ? [] : series;
    // interleave so the top movie and the top series both show up first
    const out = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i]) out.push(a[i]);
      if (b[i]) out.push(b[i]);
    }
    return out;
  },

  async meta(type, id, opts = {}) {
    const d = await getJson(`${catalogBase()}/meta/${type}/${id}.json`, { who: "catalog", cache: 30 * 60e3, timeout: 15000, ...opts });
    const m = d && d.meta;
    if (!m || !m.name) throw new ApiError("not_found", "Cinemeta doesn't know this one.");
    const episodes = (m.videos || [])
      .filter((v) => Number.isFinite(Number(v.season)) && Number.isFinite(Number(v.episode ?? v.number)))
      .map((v) => ({
        s: Number(v.season),
        e: Number(v.episode ?? v.number),
        title: v.name || v.title || "",
        overview: v.overview || v.description || "",
        thumb: v.thumbnail || null,
        aired: v.released || v.firstAired || null,
      }))
      .sort((x, y) => (x.s === 0) - (y.s === 0) || x.s - y.s || x.e - y.e);
    return {
      ...card(m, type),
      tmdb: m.moviedb_id ? String(m.moviedb_id) : "",
      background: m.background || null,
      logo: m.logo || null,
      description: m.description || "",
      runtime: m.runtime || "",
      genres: m.genres || m.genre || [],
      rating: m.imdbRating || "",
      cast: (m.cast || []).slice(0, 6),
      director: [].concat(m.director || []).slice(0, 2),
      episodes,
    };
  },
};

/** Has this episode aired? (Cinemeta lists upcoming ones too.) */
export function aired(ep) {
  return !ep.aired || new Date(ep.aired).getTime() <= Date.now() + 12 * 3600e3;
}

// Titles seen in search results, so the title page can show a title and poster right away.
const SEEN_KEY = "mma:seen";
export const seen = {
  remember(list) {
    try {
      const all = JSON.parse(sessionStorage.getItem(SEEN_KEY) || "{}");
      for (const s of list) all[s.id] = { id: s.id, type: s.type, title: s.title, poster: s.poster, year: s.year, years: s.years };
      sessionStorage.setItem(SEEN_KEY, JSON.stringify(all));
    } catch {
      /* fine */
    }
  },
  get(id) {
    try {
      return JSON.parse(sessionStorage.getItem(SEEN_KEY) || "{}")[id] || null;
    } catch {
      return null;
    }
  },
};
