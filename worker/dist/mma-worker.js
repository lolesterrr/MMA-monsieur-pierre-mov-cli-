// MMA worker, single file. Generated from worker/core.js by tools/build-worker.mjs. Don't edit by hand.
// Paste this into Cloudflare: Workers & Pages -> your worker -> Edit code.
/*
 * MMA worker core: the middleman between the MMA web app (GitHub Pages) and the movie sources.
 * worker.js is the Cloudflare entry point; local/server.mjs runs the same code on your computer.
 *
 * Search, posters and episode lists don't come through here: the app asks Cinemeta (Stremio's
 * public catalog) directly. The worker's job starts once you press play. Given an IMDb id (and
 * the TMDB id Cinemeta also knows), it asks the stream sources for a link:
 *
 *   videasy    movies and series   api.wecollege.net, decrypted by enc-dec.app   needs its referer
 *   lookmovie  movies              lmscript.xyz, links tied to the asker's IP    local helper only
 *   hexa       movies and series   theemoviedb.hexa.su, decrypted by enc-dec.app open, plays direct
 *   autoembed  movies and series   tom.autoembed.cc, plain JSON, no decrypting    down since Oct 2026 (HTTP 530), off by default
 *   vidlink    movies and series   vidlink.pro, id from enc-dec.app               MP4 files that want its app's User-Agent
 *
 * mov-cli (https://github.com/mov-cli/mov-cli) is a framework without scrapers of its own, and
 * its movie plugins and lobster's flixhq source are gone, so the steps here follow the live
 * references instead: the enc-dec.app samples (https://github.com/smy778/EncDecEndpoints) and
 * StreamViva's providers (https://github.com/loak7993-code/streamviva-providers). When a source
 * breaks, check those first.
 *
 * Then it relays the video through itself, because the stream hosts want a Referer a web page
 * can't set and some refuse requests that carry the site's Origin. Relay links are signed and
 * expire, so the worker can't be used as an open proxy.
 *
 * Routes
 *   GET  /api/health[?deep=1]          setup status (and a check of every source)
 *   GET  /api/sources?type=movie|series&imdb=tt..&tmdb=..&title=..&year=..[&s=1&e=1][&server=auto][&fresh=1]
 *        -> { server, master, direct?, subtitles, servers, tried, expires }
 *   POST /api/complaint                files a GitHub issue (needs GITHUB_TOKEN)
 *   GET  /p?t=<token>&u=<url>          signed relay for playlists, segments, subtitles
 *   GET  /m?t=<token>&v=<variants>     a master playlist made from separate quality playlists
 *
 * Settings (Cloudflare dashboard -> your worker -> Settings -> Variables and Secrets)
 *   SIGNING_KEY      secret, required. Any long random string. Signs relay links.
 *   GITHUB_TOKEN     secret, optional. Fine-grained token with Issues: read and write on the
 *                    MMA repo. Without it, complaints fall back to a prefilled GitHub link.
 *   GITHUB_REPO      default lolesterrr/MMA-monsieur-pierre-mov-cli-
 *   ALLOWED_ORIGINS  comma separated, default * . e.g. https://lolesterrr.github.io,http://localhost:*
 *   SERVERS          order for "auto", default videasy,lookmovie,hexa,vidlink (add autoembed if it comes back)
 *   RELAY_ORIGIN     set only on the lookup helper (deno/main.js): the Cloudflare worker's address.
 *                    Links it finds then play through that worker, which shares its SIGNING_KEY.
 *   COMPLAINTS_PER_10_MIN  per visitor, default 5
 *   HEALTH_TITLE     what the deep health check plays, "imdb,tmdb,title,year" (default Inception)
 *   ENCDEC_URL, VIDEASY_URL, LOOKMOVIE_URL, HEXA_URL, AUTOEMBED_URL, VIDLINK_URL, SUBS_URL   override hosts (tests, mirrors)
 */

const VERSION = "1.0.0";

const DEFAULTS = {
  GITHUB_REPO: "lolesterrr/MMA-monsieur-pierre-mov-cli-",
  GITHUB_API: "https://api.github.com",
  ENCDEC_URL: "https://enc-dec.app",
  VIDEASY_URL: "https://api.wecollege.net",
  LOOKMOVIE_URL: "https://lmscript.xyz",
  HEXA_URL: "https://theemoviedb.hexa.su",
  AUTOEMBED_URL: "https://tom.autoembed.cc",
  VIDLINK_URL: "https://vidlink.pro",
  SUBS_URL: "https://opensubtitles-v3.strem.io",
  SERVERS: "videasy,lookmovie,hexa,vidlink",
  TOKEN_TTL: 4 * 60 * 60,
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

const SERVERS = {
  videasy: { id: "videasy", name: "Videasy", types: ["movie", "series"], note: "Up to 4K" },
  lookmovie: { id: "lookmovie", name: "LookMovie", types: ["movie"], note: "Lots of subtitles, plays direct" },
  hexa: { id: "hexa", name: "Hexa", types: ["movie", "series"], note: "Slow to start, light on the worker" },
  autoembed: { id: "autoembed", name: "AutoEmbed", types: ["movie", "series"], note: "One quality, by IMDb id" },
  vidlink: { id: "vidlink", name: "VidLink", types: ["movie", "series"], note: "MP4 files, has some episodes the others don't" },
};

// Videasy moved its player to vidy.st (Oct 2026): the old player.videasy.to referer gets a 403 bot-check page
const VIDEASY_REFERER = "https://vidy.st/";
const VIDEASY_SERVERS = ["miami", "boise", "vegas", "reno", "oakland"];
const HEXA_REFERER = "https://hexa.su/";
// MovieBox's Android app: VidLink's MP4 hosts want this User-Agent (and no Referer) when it doesn't say
const MOVIEBOX_UA = "com.community.oneroom/50020115 (Linux; U; Android 15; en_US; OPPO CPH2579; Build/AP3A.240905.015.A2; Cronet/140.0.7339.51)";

const COMPLAINT_KINDS = {
  video: "Video won't play",
  slow: "Slow or keeps buffering",
  subs: "Subtitles",
  wrong: "Wrong movie or episode",
  search: "Search",
  idea: "Idea or request",
  other: "Something else",
};

// ---------------------------------------------------------------------------
// small helpers

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function b64ToBytes(b64) {
  let s = String(b64 || "").replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlText(s) {
  return bytesToB64url(enc.encode(s));
}

function textFromB64url(s) {
  return dec.decode(b64ToBytes(s));
}

function randomHex(bytes) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function short(url) {
  try {
    const u = new URL(url);
    return u.host + u.pathname.slice(0, 40);
  } catch {
    return String(url).slice(0, 60);
  }
}

function isChallenge(status, text) {
  const t = String(text || "").slice(0, 20000);
  if (/<title>\s*Just a moment/i.test(t)) return true;
  return (status === 403 || status === 503 || status === 429) && /cf-chl|challenge-platform|cf_chl_opt|Attention Required/i.test(t);
}

// ---------------------------------------------------------------------------
// subtitles: language names and SRT -> WebVTT

const LANGS = {
  en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian", pt: "Portuguese", nl: "Dutch",
  ru: "Russian", ar: "Arabic", tr: "Turkish", pl: "Polish", sv: "Swedish", no: "Norwegian", da: "Danish",
  fi: "Finnish", el: "Greek", he: "Hebrew", hi: "Hindi", id: "Indonesian", ms: "Malay", th: "Thai",
  vi: "Vietnamese", zh: "Chinese", ja: "Japanese", ko: "Korean", cs: "Czech", hu: "Hungarian", ro: "Romanian",
  bg: "Bulgarian", hr: "Croatian", sr: "Serbian", sl: "Slovenian", sk: "Slovak", uk: "Ukrainian", fa: "Persian",
  bn: "Bengali", ta: "Tamil", te: "Telugu", ml: "Malayalam", ur: "Urdu", sw: "Swahili", tl: "Filipino",
  et: "Estonian", lv: "Latvian", lt: "Lithuanian", is: "Icelandic", sq: "Albanian", mk: "Macedonian",
  ka: "Georgian", hy: "Armenian", az: "Azerbaijani", kk: "Kazakh", si: "Sinhala", my: "Burmese", km: "Khmer",
};
const ISO3 = {
  eng: "en", spa: "es", fre: "fr", fra: "fr", ger: "de", deu: "de", ita: "it", por: "pt", pob: "pt", dut: "nl",
  nld: "nl", rus: "ru", ara: "ar", tur: "tr", pol: "pl", swe: "sv", nor: "no", dan: "da", fin: "fi", gre: "el",
  ell: "el", heb: "he", hin: "hi", ind: "id", may: "ms", msa: "ms", tha: "th", vie: "vi", chi: "zh", zho: "zh",
  jpn: "ja", kor: "ko", cze: "cs", ces: "cs", hun: "hu", rum: "ro", ron: "ro", bul: "bg", hrv: "hr", scc: "sr",
  srp: "sr", slv: "sl", slo: "sk", slk: "sk", ukr: "uk", per: "fa", fas: "fa", ben: "bn", tam: "ta", tel: "te",
  mal: "ml", urd: "ur", swa: "sw", tgl: "tl", fil: "tl", est: "et", lav: "lv", lit: "lt", ice: "is", isl: "is",
  alb: "sq", sqi: "sq", mac: "mk", mkd: "mk", geo: "ka", kat: "ka", arm: "hy", hye: "hy", aze: "az", kaz: "kk",
  sin: "si", bur: "my", mya: "my", khm: "km",
};
const NAME_TO_CODE = Object.fromEntries(Object.entries(LANGS).map(([k, v]) => [v.toLowerCase(), k]));

/** "eng", "en", "English", "English (SDH)", "pt-BR" -> { lang: "en", label: "English" } */
function language(raw) {
  const s = String(raw || "").trim();
  const low = s.toLowerCase();
  let code = "";
  if (ISO3[low]) code = ISO3[low];
  else if (LANGS[low]) code = low;
  else if (/^[a-z]{2}[-_]/.test(low) && LANGS[low.slice(0, 2)]) code = low.slice(0, 2);
  else {
    const word = low.replace(/[^a-z ]/g, " ").trim().split(/\s+/)[0] || "";
    if (NAME_TO_CODE[word]) code = NAME_TO_CODE[word];
    else if (/brazil/.test(low)) code = "pt";
  }
  if (!code) return { lang: low.slice(0, 8) || "und", label: s || "Unknown" };
  let label = LANGS[code];
  if (/brazil|pt[-_]br|pob/.test(low)) label = "Portuguese (Brazil)";
  if (/sdh|hearing|\bcc\b/.test(low)) label += " (SDH)";
  return { lang: code, label };
}

function srtToVtt(text) {
  const body = String(text || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, "$1.$2")
    .trim();
  return body.startsWith("WEBVTT") ? body + "\n" : `WEBVTT\n\n${body}\n`;
}

/** One track per label, English first, at most `max`. */
function tidySubtitles(list, max = 40) {
  const seen = new Set();
  const out = [];
  for (const s of list) {
    if (!s || !s.url) continue;
    const key = s.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  out.sort((a, b) => (a.lang === "en" ? 0 : 1) - (b.lang === "en" ? 0 : 1) || a.label.localeCompare(b.label));
  return out.slice(0, max);
}

// ---------------------------------------------------------------------------
// HLS relay: signed tokens + playlist rewriting (same scheme as MPA)

const keyCache = new Map();

function hmacKey(secret) {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    keyCache.set(secret, key);
  }
  return key;
}

async function sign(secret, payload) {
  const key = await hmacKey(secret);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
  return bytesToB64url(mac.slice(0, 18));
}

/** Token = exp.referer.hosts.sig  (referer and hosts base64url). */
/**
 * A signed relay token: expiry, the Referer (and, after a newline, a User-Agent) to send, and the
 * hosts it may fetch. Tokens without a User-Agent look exactly like before.
 */
async function makeToken(secret, { referer = "", ua = "", hosts = [], ttl = DEFAULTS.TOKEN_TTL, now = Date.now() }) {
  const exp = Math.floor(now / 1000) + ttl;
  const who = ua ? `${referer}\n${String(ua).replace(/[\r\n]/g, " ")}` : referer;
  const payload = `${exp}.${b64urlText(who)}.${b64urlText([...new Set(hosts)].join(","))}`;
  return `${payload}.${await sign(secret, payload)}`;
}

async function readToken(secret, token, now = Date.now()) {
  const parts = String(token || "").split(".");
  if (parts.length !== 4) return null;
  const payload = parts.slice(0, 3).join(".");
  const expected = await sign(secret, payload);
  if (!timingSafeEqual(expected, parts[3])) return null;
  const exp = Number(parts[0]);
  if (!Number.isFinite(exp) || exp * 1000 < now) return null;
  let referer, ua, hosts;
  try {
    [referer, ua = ""] = textFromB64url(parts[1]).split("\n");
    hosts = textFromB64url(parts[2]).split(",").filter(Boolean);
  } catch {
    return null;
  }
  return { exp, referer, ua, hosts };
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function relayUrl(origin, token, url, extra = "") {
  return `${origin}/p?t=${token}&u=${encodeURIComponent(url)}${extra}`;
}

const URI_ATTR = /URI="([^"]*)"/g;

/** Every absolute URL a playlist points at, resolved against its own address. */
function playlistTargets(text, base) {
  const urls = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#")) {
      for (const m of line.matchAll(URI_ATTR)) urls.push(new URL(m[1], base).href);
    } else {
      urls.push(new URL(line, base).href);
    }
  }
  return urls;
}

/** Point every URI in an m3u8 at the relay. */
function rewritePlaylist(text, base, toRelay) {
  return String(text)
    .split(/\r?\n/)
    .map((raw) => {
      const line = raw.trim();
      if (!line) return raw;
      if (line.startsWith("#")) {
        if (!line.includes('URI="')) return raw;
        return raw.replace(URI_ATTR, (_, u) => `URI="${toRelay(new URL(u, base).href)}"`);
      }
      return toRelay(new URL(line, base).href);
    })
    .join("\n");
}

/** A master playlist for sources that hand out one playlist per quality. */
function masterPlaylist(variants) {
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3"];
  for (const v of variants) {
    const h = Number(v.h) || 0;
    const w = h ? Math.round((h * 16) / 9 / 2) * 2 : 0;
    const bw = Number(v.b) || (h >= 2160 ? 16000000 : h >= 1080 ? 5000000 : h >= 720 ? 2800000 : h >= 480 ? 1400000 : 800000);
    lines.push(`#EXT-X-STREAM-INF:BANDWIDTH=${bw}${h ? `,RESOLUTION=${w}x${h}` : ""}`, v.u);
  }
  return lines.join("\n") + "\n";
}

const MEDIA_EXT = /\.(ts|m4s|mp4|m4a|m4v|aac|mp3|vtt|webvtt|srt|ass|jpe?g|png|webp|gif|key|bin)$/i;

function concatBytes(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function looksLikePlaylist(url, contentType) {
  return /mpegurl/i.test(contentType || "") || /\.m3u8?(\?|$)/i.test(new URL(url).pathname);
}

function heightOf(label) {
  const s = String(label || "").toLowerCase();
  if (/4k|2160/.test(s)) return 2160;
  const m = s.match(/(\d{3,4})p?/);
  return m ? Number(m[1]) : 0;
}

// ---------------------------------------------------------------------------
// tiny per-isolate memory: response cache and rate limits

const memo = new Map();

function memoGet(key) {
  const hit = memo.get(key);
  if (!hit) return undefined;
  if (hit.exp < Date.now()) {
    memo.delete(key);
    return undefined;
  }
  return hit.value;
}

function memoSet(key, value, ttlMs) {
  if (memo.size > 300) memo.delete(memo.keys().next().value);
  memo.set(key, { value, exp: Date.now() + ttlMs });
}

const buckets = new Map();

function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  const b = buckets.get(key) || { n: 0, reset: now + windowMs };
  if (b.reset < now) {
    b.n = 0;
    b.reset = now + windowMs;
  }
  b.n++;
  buckets.set(key, b);
  if (buckets.size > 5000) buckets.delete(buckets.keys().next().value);
  return b.n > limit;
}

// ---------------------------------------------------------------------------
// HTTP plumbing

function originAllowed(origin, allowed) {
  if (!origin) return false;
  const list = String(allowed || "*").split(",").map((s) => s.trim()).filter(Boolean);
  return list.some((pattern) => {
    if (pattern === "*") return true;
    if (pattern === origin) return true;
    if (pattern.endsWith(":*")) {
      const prefix = pattern.slice(0, -2);
      return origin === prefix || (origin.startsWith(prefix + ":") && /^\d+$/.test(origin.slice(prefix.length + 1)));
    }
    return false;
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = env.ALLOWED_ORIGINS || "*";
  const h = {
    "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Range",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (allowed.trim() === "*") h["Access-Control-Allow-Origin"] = "*";
  else if (originAllowed(origin, allowed)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

function json(request, env, status, data, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...corsHeaders(request, env), ...extra },
  });
}

const trim = (u) => String(u).replace(/\/+$/, "");

function settings(env) {
  const order = String(env.SERVERS || DEFAULTS.SERVERS)
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => SERVERS[s]);
  return {
    repo: env.GITHUB_REPO || DEFAULTS.GITHUB_REPO,
    githubApi: trim(env.GITHUB_API || DEFAULTS.GITHUB_API),
    encdec: trim(env.ENCDEC_URL || DEFAULTS.ENCDEC_URL),
    videasy: trim(env.VIDEASY_URL || DEFAULTS.VIDEASY_URL),
    lookmovie: trim(env.LOOKMOVIE_URL || DEFAULTS.LOOKMOVIE_URL),
    hexa: trim(env.HEXA_URL || DEFAULTS.HEXA_URL),
    autoembed: trim(env.AUTOEMBED_URL || DEFAULTS.AUTOEMBED_URL),
    vidlink: trim(env.VIDLINK_URL || DEFAULTS.VIDLINK_URL),
    subs: trim(env.SUBS_URL || DEFAULTS.SUBS_URL),
    order: order.length ? order : DEFAULTS.SERVERS.split(","),
    ttl: Number(env.TOKEN_TTL) > 0 ? Number(env.TOKEN_TTL) : DEFAULTS.TOKEN_TTL,
    relayOrigin: env.RELAY_ORIGIN ? trim(env.RELAY_ORIGIN) : "",
  };
}

// ---------------------------------------------------------------------------
// the app

/**
 * createHandler({ upstream }) -> (request, env, ctx) => Response
 * upstream(url, init, kind) lets tests and the local helper swap the network.
 * kind is "api" for source lookups, "media" for playlists, segments and subtitles.
 */
function createHandler(hooks = {}) {
  const upstream = hooks.upstream || ((url, init) => fetch(url, init));

  async function call(url, { method = "GET", headers = {}, body, json: payload, timeout = 15000, what } = {}) {
    let res;
    try {
      res = await upstream(
        url,
        {
          method,
          headers: {
            "User-Agent": UA,
            Accept: "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
            ...(payload ? { "Content-Type": "application/json" } : {}),
            ...headers,
          },
          body: payload ? JSON.stringify(payload) : body,
          redirect: "follow",
          signal: AbortSignal.timeout(timeout),
        },
        "api",
      );
    } catch (e) {
      throw new HttpError(502, "unreachable", `Couldn't reach ${what || short(url)} (${e.name === "TimeoutError" ? "timed out" : e.message || "network error"}).`);
    }
    const text = await res.text();
    if (isChallenge(res.status, text)) throw new HttpError(503, "blocked", `Cloudflare's bot check stopped the worker at ${what || short(url)}.`);
    if (!res.ok) {
      const err = new HttpError(502, "upstream", `${what || short(url)} answered HTTP ${res.status}.`);
      err.body = text.slice(0, 500);
      throw err;
    }
    return text;
  }

  async function callJson(url, opts = {}) {
    const text = await call(url, opts);
    try {
      return JSON.parse(text);
    } catch {
      throw new HttpError(502, "upstream", `${opts.what || short(url)} didn't answer with JSON.`);
    }
  }

  const wait = hooks.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  /**
   * enc-dec.app answers { status, result }. It rate-limits in bursts of a few seconds
   * ("oop! too many requests", as an HTTP 500), so those get a few more tries, waiting longer each time.
   */
  async function encdec(cfg, path, init = {}) {
    const pauses = [700, 1500, 3000];
    for (let attempt = 0; ; attempt++) {
      let data;
      try {
        data = await callJson(`${cfg.encdec}/api/${path}`, { ...init, what: "enc-dec.app" });
      } catch (e) {
        // the limit comes back as HTTP 500 {"status":500,"error":"oop! too many requests"}
        let parsed = null;
        try {
          parsed = JSON.parse(e.body || "");
        } catch {
          /* not JSON */
        }
        if (!parsed || typeof parsed !== "object") throw e;
        data = parsed;
      }
      const busy = data && data.status && data.status !== 200 && (/too many/i.test(data.error || "") || data.status === 429);
      if (busy && attempt < pauses.length) {
        await wait(pauses[attempt]);
        continue;
      }
      if (data && data.status && data.status !== 200) {
        throw new HttpError(502, busy ? "busy" : "decrypt", busy ? "enc-dec.app is busy (too many requests), try again in a minute." : `enc-dec.app couldn't ${path.replace(/-.*/, "")} this one (${data.error || data.status}).`);
      }
      return data ? data.result : null;
    }
  }

  // ---- sources. Each returns { master, variants?, referer, direct?, subtitles: [{label, lang, url}] }

  async function videasy(cfg, m) {
    const H = { Origin: VIDEASY_REFERER.slice(0, -1), Referer: VIDEASY_REFERER };
    if (!m.tmdb) throw new HttpError(404, "no_id", "Videasy needs the TMDB id, and Cinemeta doesn't have one for this.");
    const seedData = await callJson(`${cfg.videasy}/seed?mediaId=${m.tmdb}`, { headers: H, what: "Videasy" });
    const seed = seedData && seedData.seed;
    if (!seed) throw new HttpError(502, "upstream", "Videasy didn't hand out a seed.");
    const title = encodeURIComponent(encodeURIComponent(m.title || ""));
    let last = null;
    for (const server of VIDEASY_SERVERS) {
      const q =
        `title=${title}&mediaType=${m.type === "series" ? "tv" : "movie"}&year=${encodeURIComponent(m.year || "")}` +
        (m.type === "series" ? `&episodeId=${m.e}&seasonId=${m.s}` : "") +
        `&tmdbId=${m.tmdb}&imdbId=${m.imdb}&enc=2&seed=${encodeURIComponent(seed)}`;
      try {
        const encrypted = await call(`${cfg.videasy}/${server}/sources?${q}`, { headers: H, what: "Videasy" });
        if (!encrypted || encrypted.length < 20) throw new HttpError(404, "no_source", "Videasy has nothing for this.");
        const res = await encdec(cfg, "dec-videasy", { method: "POST", json: { text: encrypted, id: String(m.tmdb), seed } });
        const list = (res && res.sources) || [];
        if (!list.length) throw new HttpError(404, "no_source", "Videasy has nothing for this.");
        const variants = list
          .filter((s) => s && s.url)
          .map((s) => ({ u: s.url, h: heightOf(s.quality) }))
          .sort((a, b) => b.h - a.h);
        return {
          master: res.playlist || null,
          variants,
          referer: VIDEASY_REFERER,
          subtitles: ((res && res.subtitles) || []).filter((s) => s && s.url).map((s) => ({ ...language(s.language || s.lang), url: s.url })),
        };
      } catch (e) {
        last = e;
      }
    }
    throw last || new HttpError(404, "no_source", "Videasy has nothing for this.");
  }

  async function lookmovie(cfg, m) {
    if (m.type !== "movie") throw new HttpError(404, "no_source", "LookMovie only does movies here.");
    const search = await callJson(`${cfg.lookmovie}/v1/movies?filters[q]=${encodeURIComponent(m.title || "")}`, { what: "LookMovie" });
    const items = (search && search.items) || [];
    const digits = String(m.imdb).replace(/\D/g, "");
    const hit =
      items.find((i) => String(i.imdb_id || "").replace(/\D/g, "") === digits) ||
      items.find((i) => String(i.slug || "").startsWith(`${digits}-`)) ||
      items.find((i) => String(i.year) === String(m.year) && clean(i.title, 200).toLowerCase() === clean(m.title, 200).toLowerCase());
    if (!hit) throw new HttpError(404, "no_source", "LookMovie doesn't have this one.");
    const view = await callJson(`${cfg.lookmovie}/v1/movies/view?expand=streams,subtitles&id=${encodeURIComponent(hit.id_movie)}`, { what: "LookMovie" });
    const streams = (view && view.streams) || {};
    const variants = Object.entries(streams)
      .filter(([, u]) => typeof u === "string" && /^https?:/.test(u))
      .map(([k, u]) => ({ u, h: heightOf(k) }))
      .sort((a, b) => b.h - a.h);
    if (!variants.length) throw new HttpError(404, "no_source", "LookMovie has this one but no stream right now.");
    const auto = streams.auto && /^https?:/.test(streams.auto) ? streams.auto : null;
    // Its video host turns Cloudflare away (a segment comes back as 11 bytes) but sends CORS *.
    // Links are tied to the IP that asked ("WRONG HASH!" from anywhere else), so this only helps
    // the local helper, where the browser shares the computer's connection.
    return {
      master: auto,
      variants: auto ? [] : variants,
      direct: auto || variants[0].u,
      referer: "",
      subtitles: ((view && view.subtitles) || [])
        .filter((s) => s && s.url)
        .map((s) => ({ ...language(s.language), url: new URL(s.url, cfg.lookmovie + "/").href })),
    };
  }

  async function hexa(cfg, m) {
    if (!m.tmdb) throw new HttpError(404, "no_id", "Hexa needs the TMDB id, and Cinemeta doesn't have one for this.");
    const key = randomHex(32);
    const challenge = await encdec(cfg, "enc-hexa");
    const token = challenge && challenge.token;
    if (!token) throw new HttpError(502, "decrypt", "enc-dec.app didn't hand out a Hexa token.");
    const path = m.type === "series" ? `tv/${m.tmdb}/season/${m.s}/episode/${m.e}` : `movie/${m.tmdb}`;
    const encrypted = await call(`${cfg.hexa}/api/tmdb/${path}/images`, {
      headers: { Referer: HEXA_REFERER, Accept: "text/plain", "X-Fingerprint-Lite": "e9136c41504646444", "X-Api-Key": key, "X-Cap-Token": token },
      timeout: 25000,
      what: "Hexa",
    });
    const res = await encdec(cfg, "dec-hexa", { method: "POST", json: { text: encrypted, key } });
    const list = ((res && res.sources) || []).filter((s) => s && s.url);
    if (!list.length) throw new HttpError(404, "no_source", "Hexa has nothing for this.");
    // "alpha" is the plain stream; the others go through Hexa's own proxy
    const pick = list.find((s) => s.server === "alpha") || list[0];
    return { master: pick.url, variants: [], referer: "", direct: true, subtitles: [] };
  }

  /**
   * AutoEmbed: one GET by IMDb id, plain JSON back ({ videoSource, subtitles? }), nothing to decrypt.
   * Series ask for id=tt123/<season>/<episode>. The stream wants AutoEmbed's referer.
   */
  async function autoembed(cfg, m) {
    if (!/^tt\d+$/.test(m.imdb || "")) throw new HttpError(404, "no_id", "AutoEmbed needs the IMDb id.");
    const referer = `${cfg.autoembed}/`;
    const id = m.type === "series" ? `${m.imdb}/${m.s}/${m.e}` : m.imdb;
    const data = await callJson(`${cfg.autoembed}/api/getVideoSource?type=${m.type === "series" ? "tv" : "movie"}&id=${id}`, {
      headers: { Referer: referer, Origin: cfg.autoembed },
      what: "AutoEmbed",
    });
    const src = data && typeof data.videoSource === "string" ? data.videoSource : "";
    if (!/^https?:\/\//.test(src)) throw new HttpError(404, "no_source", "AutoEmbed has nothing for this.");
    const subs = (Array.isArray(data.subtitles) ? data.subtitles : [])
      .map((s) => ({ s, url: s && (s.url || s.file) }))
      .filter(({ url }) => typeof url === "string" && /^https?:\/\//.test(url))
      .map(({ s, url }) => ({ ...language(s.lang || s.language || s.label), url, srt: /\.srt(\?|$)/i.test(url) }));
    return { master: src, variants: [], referer, subtitles: subs };
  }

  /**
   * VidLink: enc-dec.app turns the TMDB id into VidLink's id, then one GET answers JSON. Mostly
   * MoviBox MP4 files ("file", one per quality) that only load with MoviBox's Android User-Agent
   * and no Referer (anything else gets HTTP 428), sometimes an HLS playlist ("hls").
   */
  async function vidlink(cfg, m) {
    if (!m.tmdb) throw new HttpError(404, "no_id", "VidLink needs the TMDB id, and Cinemeta doesn't have one for this.");
    const id = await encdec(cfg, `enc-vidlink?text=${encodeURIComponent(m.tmdb)}`);
    if (!id || typeof id !== "string") throw new HttpError(502, "decrypt", "enc-dec.app didn't hand out a VidLink id.");
    const path = m.type === "series" ? `tv/${encodeURIComponent(id)}/${m.s}/${m.e}` : `movie/${encodeURIComponent(id)}`;
    const data = await callJson(`${cfg.vidlink}/api/b/${path}`, { headers: { Origin: cfg.vidlink, Referer: `${cfg.vidlink}/` }, what: "VidLink" });
    const stream = data && data.stream;
    if (!stream) throw new HttpError(404, "no_source", "VidLink has nothing for this.");
    const subtitles = (stream.captions || [])
      .filter((c) => c && typeof c.url === "string" && /^https?:/.test(c.url))
      .map((c) => ({ ...language(c.language || c.lang), url: c.url, srt: c.type === "srt" || /\.srt(\?|$)/i.test(c.url) }));
    if (stream.type === "hls" && stream.playlist) {
      const h = stream.headers || {};
      return { master: stream.playlist, variants: [], referer: h.Referer || h.referer || `${cfg.vidlink}/`, subtitles };
    }
    const files = Object.entries(stream.qualities || {})
      .filter(([, v]) => v && typeof v.url === "string" && /^https?:/.test(v.url))
      .map(([q, v]) => ({ u: v.url, h: heightOf(q) || Number(q) || 0, codec: /hevc|h265|hvc/i.test(v.codecName || "") ? "hevc" : "h264", ua: (v.headers && v.headers["User-Agent"]) || "" }))
      .sort((a, b) => b.h - a.h);
    if (!files.length) throw new HttpError(404, "no_source", "VidLink has nothing for this.");
    return { kind: "mp4", files, master: null, variants: [], referer: "", ua: files.find((f) => f.ua)?.ua || MOVIEBOX_UA, subtitles };
  }

  const RUN = { videasy, lookmovie, hexa, autoembed, vidlink };

  /** Does an MP4 load? The first two bytes are enough. */
  async function verifyFile(url, ua) {
    let res;
    try {
      res = await upstream(url, { headers: { "User-Agent": ua || UA, Accept: "*/*", Range: "bytes=0-1" }, redirect: "follow", signal: AbortSignal.timeout(10000) }, "media");
    } catch (e) {
      throw new HttpError(502, "dead_link", `The video file didn't answer (${e.name === "TimeoutError" ? "timed out" : e.message}).`);
    }
    const type = res.headers.get("Content-Type") || "";
    if (res.body) await res.body.cancel().catch(() => {});
    if (!res.ok || /text\/html|json/i.test(type)) throw new HttpError(502, "dead_link", `The video file answered HTTP ${res.status}${res.ok ? ` (${type})` : ""}.`);
  }

  /** Does the playlist load? A 5xx gets one more try a moment later (Hexa's hosts blip). */
  async function verify(url, referer) {
    try {
      return await verifyOnce(url, referer);
    } catch (e) {
      if (!/HTTP 5\d\d\b|didn't answer/.test(e.message || "")) throw e;
      await wait(1000);
      return verifyOnce(url, referer);
    }
  }

  /** Does the playlist load? A source can hand out links that 403 or 404. */
  async function verifyOnce(url, referer) {
    const headers = { "User-Agent": UA, Accept: "*/*" };
    if (referer) {
      headers.Referer = referer;
      headers.Origin = referer.replace(/\/$/, "");
    }
    let res;
    try {
      res = await upstream(url, { headers, redirect: "follow", signal: AbortSignal.timeout(10000) }, "media");
    } catch (e) {
      throw new HttpError(502, "dead_link", `The stream link didn't answer (${e.name === "TimeoutError" ? "timed out" : e.message}).`);
    }
    const text = res.ok ? await res.text() : "";
    if (!res.ok || !text.replace(/^\uFEFF/, "").trimStart().startsWith("#EXTM3U")) {
      throw new HttpError(502, "dead_link", `The stream link answered HTTP ${res.status}${res.ok ? " but isn't a playlist" : ""}.`);
    }
    return text;
  }

  async function extraSubtitles(cfg, m) {
    const id = m.type === "series" ? `series/${m.imdb}:${m.s}:${m.e}` : `movie/${m.imdb}`;
    try {
      const data = await callJson(`${cfg.subs}/subtitles/${id}.json`, { timeout: 5000, what: "OpenSubtitles" });
      return ((data && data.subtitles) || []).filter((s) => s && s.url).map((s) => ({ ...language(s.lang), url: s.url, srt: true }));
    } catch {
      return [];
    }
  }

  async function sources(request, env, cfg, m) {
    if (!env.SIGNING_KEY) throw new HttpError(501, "setup", "The worker has no SIGNING_KEY yet, so it can't relay video. Add it in the worker's settings.");
    const fits = (id) => SERVERS[id].types.includes(m.type);
    const order = m.server === "auto" ? cfg.order.filter(fits) : [m.server];
    if (m.server !== "auto" && cfg.relayOrigin && !cfg.order.includes(m.server)) {
      throw new HttpError(404, "no_source", `The lookup helper doesn't use ${SERVERS[m.server].name}.`, { tried: [] });
    }
    if (m.server !== "auto" && !fits(m.server)) {
      throw new HttpError(404, "no_source", `${SERVERS[m.server].name} doesn't do ${m.type === "series" ? "series" : "movies"}.`, { tried: [] });
    }
    const subsPromise = extraSubtitles(cfg, m);
    const tried = [];
    let got = null;
    let server = null;
    for (const id of order) {
      const cacheKey = `s:${id}:${m.type}:${m.imdb}:${m.s}:${m.e}`;
      // a server that just refused this worker (403, 429, bot check) gets skipped for a while on
      // "auto", so nobody waits for the same no again. Picking it by hand still asks.
      const refused = memoGet(`refused:${id}`);
      if (refused && m.server === "auto") {
        tried.push({ server: id, name: SERVERS[id].name, error: "refused", message: `${refused} (skipped for now)` });
        continue;
      }
      try {
        let res = m.fresh ? undefined : memoGet(cacheKey);
        if (!res) {
          res = await RUN[id](cfg, m);
          if (res.kind === "mp4") {
            await verifyFile(res.files[0].u, res.ua);
            memoSet(cacheKey, res, 10 * 60e3);
            got = res;
            server = id;
            break;
          }
          const first = res.master || (res.variants[0] && res.variants[0].u);
          if (!first) throw new HttpError(404, "no_source", "No stream link.");
          const text = await verify(first, res.referer);
          // a "quality" that is itself a master playlist (Videasy's backup servers do this) plays
          // as the master: wrapping it in a made-up master nests masters, and hls.js gives up
          // with levelParsingError
          if (!res.master && /#EXT-X-STREAM-INF/.test(text)) res = { ...res, master: first, variants: [] };
          memoSet(cacheKey, res, 10 * 60e3);
        }
        got = res;
        server = id;
        break;
      } catch (e) {
        tried.push({ server: id, name: SERVERS[id].name, error: e.code || "error", message: e.message || String(e) });
        if (e.code === "blocked" || /HTTP (403|429)\b/.test(e.message || "")) memoSet(`refused:${id}`, e.message, 15 * 60e3);
      }
    }
    if (!got) {
      const blocked = tried.length && tried.every((t) => t.error === "blocked");
      const msg = tried.map((t) => `${t.name}: ${t.message}`).join(" ");
      throw new HttpError(blocked ? 503 : 404, blocked ? "blocked" : "no_source", msg || "No server has this.", { tried, servers: listServers(m.type) });
    }

    // the lookup helper (deno/main.js) hands out links that play through the Cloudflare worker
    const origin = cfg.relayOrigin || new URL(request.url).origin;
    const extra = await subsPromise;
    const allSubs = tidySubtitles([...got.subtitles, ...extra]);
    const files = got.kind === "mp4" ? got.files : [];
    const urls = [got.master, ...got.variants.map((v) => v.u), ...files.map((f) => f.u), ...allSubs.map((s) => s.url)].filter(Boolean);
    const hosts = urls.map((u) => new URL(u).host);
    const token = await makeToken(env.SIGNING_KEY, { referer: got.referer || "", ua: got.ua || "", hosts, ttl: cfg.ttl });
    const relayed = files.map((f) => ({ h: f.h, codec: f.codec, url: relayUrl(origin, token, f.u) }));
    const master = relayed.length
      ? relayed[0].url
      : got.master
      ? relayUrl(origin, token, got.master)
      : `${origin}/m?t=${token}&v=${b64urlText(JSON.stringify(got.variants.map((v) => ({ u: v.u, h: v.h }))))}`;
    return {
      server,
      name: SERVERS[server].name,
      type: m.type,
      imdb: m.imdb,
      // "mp4": plain video files, one per quality (files), for the <video> element, not hls.js
      kind: got.kind === "mp4" ? "mp4" : "hls",
      ...(relayed.length ? { files: relayed } : {}),
      master,
      // true: play the master straight from the host. A link: play that one straight.
      direct: typeof got.direct === "string" ? got.direct : got.direct && got.master ? got.master : null,
      subtitles: allSubs.map((s) => ({ label: s.label, lang: s.lang, url: relayUrl(origin, token, s.url, s.srt ? "&f=vtt" : "") })),
      servers: listServers(m.type),
      tried,
      expires: Math.floor(Date.now() / 1000) + cfg.ttl,
    };
  }

  function listServers(type) {
    return Object.values(SERVERS)
      .filter((s) => !type || s.types.includes(type))
      .map(({ id, name, note }) => ({ id, name, note }));
  }

  async function syntheticMaster(request, env, cfg) {
    const url = new URL(request.url);
    if (!env.SIGNING_KEY) return json(request, env, 501, { error: "setup", message: "SIGNING_KEY is missing." });
    const t = url.searchParams.get("t");
    const tok = await readToken(env.SIGNING_KEY, t);
    if (!tok) return json(request, env, 403, { error: "bad_token", message: "This link expired. Reload the page." });
    let variants;
    try {
      variants = JSON.parse(textFromB64url(url.searchParams.get("v") || ""));
    } catch {
      return json(request, env, 400, { error: "bad_variants", message: "Bad playlist list." });
    }
    if (!Array.isArray(variants) || !variants.length || variants.length > 8) return json(request, env, 400, { error: "bad_variants", message: "Bad playlist list." });
    const list = [];
    for (const v of variants) {
      let u;
      try {
        u = new URL(v.u);
      } catch {
        return json(request, env, 400, { error: "bad_variants", message: "Bad playlist list." });
      }
      if (!tok.hosts.includes(u.host)) return json(request, env, 403, { error: "not_allowed", message: "That host isn't part of this stream." });
      list.push({ u: relayUrl(url.origin, t, u.href), h: v.h });
    }
    return new Response(masterPlaylist(list), {
      status: 200,
      headers: { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store", ...corsHeaders(request, env) },
    });
  }

  async function relay(request, env, cfg) {
    const url = new URL(request.url);
    if (!env.SIGNING_KEY) return json(request, env, 501, { error: "setup", message: "SIGNING_KEY is missing." });
    const tok = await readToken(env.SIGNING_KEY, url.searchParams.get("t"));
    if (!tok) return json(request, env, 403, { error: "bad_token", message: "This link expired or wasn't made by this worker. Reload the page." });
    let target;
    try {
      target = new URL(url.searchParams.get("u") || "");
    } catch {
      return json(request, env, 400, { error: "bad_url", message: "Missing target." });
    }
    if (!/^https?:$/.test(target.protocol) || !tok.hosts.includes(target.host)) {
      return json(request, env, 403, { error: "not_allowed", message: "That host isn't part of this stream." });
    }
    const headers = { "User-Agent": tok.ua || UA, Accept: "*/*", "Accept-Language": "en-US,en;q=0.9" };
    if (tok.referer) {
      headers.Referer = tok.referer;
      headers.Origin = tok.referer.replace(/\/$/, "");
    }
    const range = request.headers.get("Range");
    if (range) headers.Range = range;
    let res;
    try {
      res = await upstream(target.href, { method: request.method === "HEAD" ? "HEAD" : "GET", headers, redirect: "follow" }, "media");
    } catch (e) {
      return json(request, env, 502, { error: "unreachable", message: `Couldn't reach ${target.host}: ${e.message || "network error"}` });
    }
    const cors = corsHeaders(request, env);
    const finalUrl = res.url || target.href;
    const type = res.headers.get("Content-Type") || "";

    if (url.searchParams.get("f") === "vtt") {
      const text = res.ok ? await res.text() : "";
      if (!res.ok) return new Response(null, { status: res.status, headers: cors });
      return new Response(srtToVtt(text), { status: 200, headers: { "Content-Type": "text/vtt; charset=utf-8", "Cache-Control": "public, max-age=86400", ...cors } });
    }

    let body = res.body;
    let playlist = null;
    if (res.ok && request.method !== "HEAD" && body) {
      if (looksLikePlaylist(finalUrl, type)) {
        playlist = await res.text();
      } else if (!/^(video|audio|image)\//i.test(type) && !MEDIA_EXT.test(new URL(finalUrl).pathname)) {
        // some hosts serve playlists as text/plain from odd paths: peek at the start
        const reader = body.getReader();
        const first = await reader.read();
        const head = first.value ? dec.decode(first.value.slice(0, 32)) : "";
        if (/^\uFEFF?\s*#EXTM3U/.test(head)) {
          const chunks = first.value ? [first.value] : [];
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
          }
          playlist = dec.decode(concatBytes(chunks));
        } else {
          body = new ReadableStream({
            start(c) {
              if (first.done) c.close();
              else c.enqueue(first.value);
            },
            async pull(c) {
              const { done, value } = await reader.read();
              if (done) c.close();
              else c.enqueue(value);
            },
            cancel(reason) {
              return reader.cancel(reason);
            },
          });
        }
      }
    }
    if (playlist !== null) {
      const text = playlist.replace(/^\uFEFF/, "");
      if (!text.trimStart().startsWith("#EXTM3U")) {
        return new Response(text, { status: res.status, headers: { "Content-Type": type || "text/plain", ...cors } });
      }
      const hosts = new Set(tok.hosts);
      const before = hosts.size;
      playlistTargets(text, finalUrl).forEach((t) => hosts.add(new URL(t).host));
      hosts.add(new URL(finalUrl).host);
      const token = hosts.size === before ? url.searchParams.get("t") : await makeToken(env.SIGNING_KEY, { referer: tok.referer, ua: tok.ua, hosts: [...hosts], ttl: cfg.ttl });
      return new Response(rewritePlaylist(text, finalUrl, (u) => relayUrl(url.origin, token, u)), {
        status: 200,
        headers: { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "no-store", ...cors },
      });
    }
    const out = new Headers(cors);
    for (const h of ["Content-Type", "Content-Length", "Content-Range", "Accept-Ranges", "Last-Modified", "ETag"]) {
      const v = res.headers.get(h);
      if (v) out.set(h, v);
    }
    if (/\.vtt(\?|$)/i.test(finalUrl) && !/vtt/i.test(type)) out.set("Content-Type", "text/vtt; charset=utf-8");
    out.set("Cache-Control", res.ok ? "public, max-age=3600" : "no-store");
    return new Response(request.method === "HEAD" ? null : body, { status: res.status, headers: out });
  }

  async function complaint(request, env, cfg) {
    const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "local";
    const limit = Number(env.COMPLAINTS_PER_10_MIN) > 0 ? Number(env.COMPLAINTS_PER_10_MIN) : 5;
    if (rateLimited(`c:${ip}`, limit, 10 * 60e3)) throw new HttpError(429, "slow_down", "Pierre is still reading your last complaints. Try again in a few minutes.");
    const raw = await request.text();
    if (raw.length > 20000) throw new HttpError(413, "too_long", "That complaint is longer than Pierre's attention span.");
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      throw new HttpError(400, "bad_json", "Couldn't read that.");
    }
    if (body.website) return json(request, env, 200, { ok: true, number: 0 }); // honeypot: pretend it worked
    const kind = COMPLAINT_KINDS[body.kind] ? body.kind : "other";
    const message = clean(body.message, 3000);
    if (message.length < 3) throw new HttpError(400, "empty", "Write at least a few words, Pierre can't read minds. Only snacks.");
    if (Number(body.elapsed) > 0 && Number(body.elapsed) < 1500) throw new HttpError(400, "too_fast", "That was fast. Too fast. Try again.");
    const dupKey = `d:${ip}:${message.slice(0, 200)}`;
    if (memoGet(dupKey)) throw new HttpError(409, "duplicate", "Pierre already has this one on his desk.");
    const issue = complaintIssue(kind, message, body);
    if (!env.GITHUB_TOKEN) {
      throw new HttpError(501, "not_configured", "The complaint desk isn't connected to GitHub yet.", { fallback: issueLink(cfg.repo, issue) });
    }
    const res = await upstream(
      `${cfg.githubApi}/repos/${cfg.repo}/issues`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "User-Agent": "MMA-worker",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: JSON.stringify(issue),
      },
      "github",
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new HttpError(502, "github", `GitHub said ${res.status}${detail ? ": " + clean(detail, 160) : ""}.`, { fallback: issueLink(cfg.repo, issue) });
    }
    const made = await res.json();
    memoSet(dupKey, true, 10 * 60e3);
    return json(request, env, 201, { ok: true, number: made.number, url: made.html_url });
  }

  async function health(request, env, cfg, deep) {
    const out = {
      ok: true,
      name: cfg.relayOrigin ? "MMA lookup helper" : "MMA worker",
      version: VERSION,
      signing: Boolean(env.SIGNING_KEY),
      complaints: Boolean(env.GITHUB_TOKEN),
      repo: cfg.repo,
      servers: cfg.order,
      ...(cfg.relayOrigin ? { relay: cfg.relayOrigin } : {}),
    };
    if (deep) {
      // Inception by default: every source has it
      const [imdb, tmdb, title, year] = String(env.HEALTH_TITLE || "tt1375666,27205,Inception,2010").split(",");
      const m = { type: "movie", imdb, tmdb, title, year, s: "", e: "" };
      out.sources = {};
      await Promise.all(
        cfg.order.map(async (id) => {
          const t = Date.now();
          try {
            const res = await RUN[id](cfg, m);
            if (res.kind === "mp4") await verifyFile(res.files[0].u, res.ua);
            else await verify(res.master || res.variants[0].u, res.referer);
            out.sources[id] = { ok: true, ms: Date.now() - t };
          } catch (e) {
            out.sources[id] = { ok: false, error: e.code || "error", message: e.message, ms: Date.now() - t };
          }
        }),
      );
      out.upstream = Object.values(out.sources).some((s) => s.ok) ? "ok" : "down";
    }
    return json(request, env, 200, out);
  }

  async function handle(request, env = {}, ctx) {
    const url = new URL(request.url);
    const cfg = settings(env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    try {
      if (url.pathname === "/p") return await relay(request, env, cfg);
      if (url.pathname === "/m") return await syntheticMaster(request, env, cfg);

      if (url.pathname === "/api/complaint") {
        if (request.method !== "POST") throw new HttpError(405, "method", "POST a complaint here.");
        return await complaint(request, env, cfg);
      }

      if (request.method !== "GET" && request.method !== "HEAD") throw new HttpError(405, "method", "Only GET here.");
      const ip = request.headers.get("CF-Connecting-IP") || "local";
      if (url.pathname.startsWith("/api/") && rateLimited(`a:${ip}`, 120, 60e3)) {
        throw new HttpError(429, "slow_down", "Too many requests. Pierre needs a nap. Try again in a minute.");
      }
      const p = url.searchParams;

      switch (url.pathname) {
        case "/":
        case "/api":
        case "/api/health":
          return await health(request, env, cfg, Boolean(p.get("deep")));
        case "/api/sources": {
          const type = p.get("type") === "series" ? "series" : "movie";
          const imdb = String(p.get("imdb") || "");
          if (!/^tt\d{5,10}$/.test(imdb)) throw new HttpError(400, "bad_id", "That doesn't look like an IMDb id (tt1234567).");
          const tmdb = /^\d{1,9}$/.test(p.get("tmdb") || "") ? p.get("tmdb") : "";
          const s = type === "series" ? p.get("s") || "" : "";
          const e = type === "series" ? p.get("e") || "" : "";
          if (type === "series" && (!/^\d{1,4}$/.test(s) || !/^\d{1,5}$/.test(e))) throw new HttpError(400, "no_episode", "Which season and episode?");
          const server = SERVERS[p.get("server")] ? p.get("server") : "auto";
          const m = { type, imdb, tmdb, s, e, server, title: clean(p.get("title"), 200), year: (clean(p.get("year"), 20).match(/\d{4}/) || [""])[0], fresh: p.get("fresh") === "1" };
          return json(request, env, 200, await sources(request, env, cfg, m));
        }
        case "/api/reach": {
          // Can this worker reach a stream host? Answers with the status and size only, never the
          // content, so it can't be used as a proxy. The "Check the worker" workflow uses it.
          let target;
          try {
            target = new URL(p.get("u") || "");
          } catch {
            throw new HttpError(400, "bad_url", "Which URL?");
          }
          if (!/^https:$/.test(target.protocol)) throw new HttpError(400, "bad_url", "https only.");
          if (rateLimited(`r:${ip}`, 20, 60e3)) throw new HttpError(429, "slow_down", "Slow down.");
          const referer = p.get("ref") || "";
          const headers = { "User-Agent": clean(p.get("ua"), 300) || UA, Accept: "*/*", Range: "bytes=0-2047" };
          if (referer) {
            headers.Referer = referer;
            headers.Origin = referer.replace(/\/$/, "");
          }
          try {
            const r = await upstream(target.href, { headers, redirect: "follow", signal: AbortSignal.timeout(10000) }, "media");
            const buf = new Uint8Array(await r.arrayBuffer());
            return json(request, env, 200, { status: r.status, bytes: buf.length, playlist: dec.decode(buf.slice(0, 7)) === "#EXTM3U", server: r.headers.get("server") });
          } catch (e) {
            return json(request, env, 200, { status: 0, error: e.message });
          }
        }
        case "/api/servers":
          return json(request, env, 200, { servers: listServers(p.get("type") === "series" ? "series" : p.get("type") === "movie" ? "movie" : "") });
        default:
          throw new HttpError(404, "not_found", "Nothing here. Pierre checked under the sofa.");
      }
    } catch (e) {
      if (e instanceof HttpError) return json(request, env, e.status, { error: e.code, message: e.message, ...(e.extra || {}) });
      console.error(e && e.stack ? e.stack : e);
      return json(request, env, 500, { error: "internal", message: "Something broke inside the worker." });
    }
  }

  return handle;
}

function clean(v, max) {
  return String(v || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim()
    .slice(0, max);
}

function cell(v, max = 300) {
  return clean(v, max).replace(/\r?\n/g, " ").replace(/\|/g, "\\|").replace(/@/g, "@\u200b") || "-";
}

function complaintIssue(kind, message, body = {}) {
  const c = body.context && typeof body.context === "object" ? body.context : {};
  const label = COMPLAINT_KINDS[kind] || COMPLAINT_KINDS.other;
  const firstLine = message.split(/\r?\n/)[0].slice(0, 70);
  const quoted = message
    .replace(/@/g, "@\u200b")
    .split(/\r?\n/)
    .map((l) => `> ${l}`)
    .join("\n");
  const rows = [
    ["Kind", label],
    ["Page", c.page],
    ["Title", c.title ? `${c.title}${c.id ? ` (\`${c.id}\`)` : ""}` : c.id],
    ["Episode", c.ep],
    ["Server", c.server],
    ["Error", c.error],
    ["Worker", c.api],
    ["Browser", c.ua],
    ["App", c.app],
    ["Contact", body.contact],
  ].filter(([, v]) => v);
  const table = ["| | |", "|---|---|", ...rows.map(([k, v]) => `| ${k} | ${cell(v)} |`)].join("\n");
  return {
    title: `[${label}] ${firstLine}`,
    body: `${quoted}\n\n${table}\n\n_Filed at the MMA complaint desk. Monsieur Pierre has read it. Probably._`,
    labels: ["complaint", kind],
  };
}

function issueLink(repo, issue) {
  const q = new URLSearchParams({ title: issue.title, body: issue.body.slice(0, 6000), labels: issue.labels.join(",") });
  return `https://github.com/${repo}/issues/new?${q}`;
}

export default { fetch: createHandler() };
