import { esc, fmtTime, toast, copyText } from "../util.js";
import { api, catalog, seen, aired } from "../api.js";
import { history, prefs, progress, epKey } from "../store.js";
import { state, noteError } from "../state.js";
import { hydrate, pierre } from "../pierre.js";
import { problem, epCode, typeLabel } from "./common.js";

let hlsLoading = null;
function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (!hlsLoading) {
    hlsLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = new URL("../../vendor/hls.min.js", import.meta.url).href;
      s.onload = () => resolve(window.Hls);
      s.onerror = () => {
        hlsLoading = null;
        reject(new Error("Couldn't load the video player script."));
      };
      document.head.append(s);
    });
  }
  return hlsLoading;
}

const SERVER_NAMES = { auto: "Auto", videasy: "Videasy", lookmovie: "LookMovie", hexa: "Hexa" };
const SERVER_TYPES = { videasy: ["movie", "series"], lookmovie: ["movie"], hexa: ["movie", "series"] };

export const title = (params, route) => {
  const t = (seen.get(route.id) || {}).title || typeLabel(route.type);
  return route.type === "series" ? `${epCode(route.s, route.e)}, ${t} | MMA` : `${t} | MMA`;
};

const isMac = () => /Macintosh|Mac OS X/.test(navigator.userAgent) && !/iPhone|iPad/.test(navigator.userAgent);

export async function render(main, params, ctx, route) {
  const { type, id } = route;
  const series = type === "series";
  const s = series ? Number(route.s) : null;
  const e = series ? Number(route.e) : null;
  const ek = epKey(s, e);
  const enc = encodeURIComponent;
  const fitting = (srv) => srv === "auto" || (SERVER_TYPES[srv] || []).includes(type);
  const asked = params.get("server");
  // a server you pick sticks to this title through the address, not to every title
  let server = fitting(asked) ? asked : "auto";
  let meta = seen.get(id) || { id, type, title: "" };
  state.current = { id, type, title: meta.title, ep: series ? epCode(s, e) : "", server };
  const href = (ss, ee) => (series ? `#/watch/series/${id}/${ss}/${ee}` : `#/watch/movie/${id}`);

  main.innerHTML = `
  <article class="watch" aria-labelledby="watch-ep">
    <div class="stage-wrap">
      <span class="perch" data-pierre="peek" data-scale="3" data-joke></span>
      <div class="stage" data-stage>
        <div class="stage-msg"><span data-pierre="clap" data-scale="4"></span><p class="bubble bubble-left">Finding a projector…</p></div>
      </div>
    </div>
    <div class="watch-bar">
      <div class="watch-titles">
        <a class="watch-show" href="#/title/${type}/${id}">${esc(meta.title || typeLabel(type))}</a>
        <h1 id="watch-ep" class="watch-ep">${series ? esc(epCode(s, e)) : esc(meta.title || "")}<span class="ep-name"></span></h1>
      </div>
      <nav class="watch-nav" aria-label="Episodes" ${series ? "" : "hidden"}>
        <a class="btn" data-prev hidden>Previous</a>
        <a class="btn primary" data-next hidden>Next episode</a>
      </nav>
    </div>
    <div class="watch-tools">
      <label class="pick"><span>Server</span><select data-server>
        ${["auto", "videasy", "lookmovie", "hexa"]
          .filter(fitting)
          .map((k) => `<option value="${k}"${k === server ? " selected" : ""}>${SERVER_NAMES[k]}</option>`)
          .join("")}
      </select></label>
      <label class="pick"><span>Quality</span><select data-quality disabled><option value="-1">Auto</option></select></label>
      <label class="pick"><span>Subtitles</span><select data-subs disabled><option value="off">Off</option></select></label>
      <details class="more">
        <summary class="btn">Other players</summary>
        <div class="more-menu">
          <button class="btn" type="button" data-copy disabled>Copy stream link</button>
          ${isMac() ? '<a class="btn" data-iina hidden>Open in IINA</a>' : ""}
          <p class="fine">The link plays in mpv, VLC and IINA too. It stops working after a few hours.</p>
        </div>
      </details>
      <button class="link-btn" type="button" data-complain="video">Something wrong with this ${series ? "episode" : "movie"}?</button>
    </div>
  </article>`;
  hydrate(main);

  const stage = main.querySelector("[data-stage]");
  const perchEl = main.querySelector(".perch");
  const perch = (anim) => pierre(perchEl, anim, { scale: 3 });
  const timers = new Set();
  const later = (fn, ms) => {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return t;
  };
  let hls = null;
  let video = null;
  let cleanupMedia = () => {};

  const showProblem = (err, opts = {}) => {
    noteError(err);
    stage.innerHTML = `<div class="stage-msg stage-problem">${problem(err, { kind: "video", ...opts })}</div>`;
    hydrate(stage);
    perch("peek");
    const retry = stage.querySelector("[data-retry]");
    if (retry) retry.addEventListener("click", () => start(null, true), { once: true });
    for (const b of stage.querySelectorAll("[data-try]")) b.addEventListener("click", () => switchServer(b.dataset.try), { once: true });
  };

  // the catalog entry: title, TMDB id, year, and for series the episode list
  try {
    meta = await catalog.meta(type, id, { signal: ctx.signal });
  } catch (err) {
    if (err.code === "aborted") return;
    showProblem(err, { kind: "wrong" });
    return;
  }
  if (ctx.signal.aborted) return;
  seen.remember([meta]);
  document.title = title(params, route);
  main.querySelector(".watch-show").textContent = series ? meta.title : `${typeLabel(type)}${meta.year ? `, ${meta.year}` : ""}`;
  if (!series) main.querySelector(".watch-ep").firstChild.textContent = meta.title;
  state.current = { ...state.current, title: meta.title };

  let ep = null;
  let prev = null;
  let next = null;
  if (series) {
    const list = meta.episodes.filter((x) => (s === 0 ? x.s === 0 : x.s > 0) && aired(x));
    const idx = list.findIndex((x) => x.s === s && x.e === e);
    ep = idx >= 0 ? list[idx] : meta.episodes.find((x) => x.s === s && x.e === e) || null;
    if (!ep) {
      showProblem({ code: "no_episode", message: `${epCode(s, e)} isn't listed for ${meta.title}.` }, { title: "There's no such episode", retry: false, anim: "shrug" });
      return;
    }
    if (idx >= 0) {
      prev = list[idx - 1] || null;
      next = list[idx + 1] || null;
    }
    const name = ep.title && !/^episode \d+$/i.test(ep.title) ? ep.title : "";
    if (name) main.querySelector(".ep-name").textContent = `: ${name}`;
    const prevA = main.querySelector("[data-prev]");
    const nextA = main.querySelector("[data-next]");
    if (prev) Object.assign(prevA, { hidden: false, href: href(prev.s, prev.e) });
    if (next) Object.assign(nextA, { hidden: false, href: href(next.s, next.e) });
    if (!aired(ep)) {
      showProblem({ code: "not_out", message: `${epCode(s, e)} comes out ${new Date(ep.aired).toLocaleDateString()}.` }, { title: "Not out yet", retry: false, anim: "sleep" });
      return;
    }
  }
  const epTitle = ep && ep.title && !/^episode \d+$/i.test(ep.title) ? ep.title : "";

  let src = null;
  let usingDirect = false;
  let retriedNetwork = false;
  let mediaRecoveries = 0;

  const serverSel = main.querySelector("[data-server]");
  serverSel.addEventListener(
    "change",
    () => switchServer(serverSel.value),
    { signal: ctx.signal },
  );

  function switchServer(id2) {
    server = id2;
    serverSel.value = id2;
    state.current = { ...state.current, server };
    const at = video && video.currentTime > 5 ? video.currentTime : null;
    window.history.replaceState(null, "", `${href(s, e)}${server === "auto" ? "" : `?server=${server}`}`);
    retriedNetwork = false;
    start(at);
  }

  async function start(resumeAt = null, fresh = false) {
    cleanupMedia();
    const what = series ? epCode(s, e) : meta.title;
    stage.innerHTML = `<div class="stage-msg"><span data-pierre="clap" data-scale="4"></span><p class="bubble bubble-left">${server === "auto" ? `Finding ${esc(what)}…` : `Asking ${esc(SERVER_NAMES[server])}…`}</p></div>`;
    hydrate(stage);
    perch("peek");
    try {
      src = await api.sources({ type, imdb: id, tmdb: meta.tmdb, title: meta.title, year: meta.year, s: series ? s : "", e: series ? e : "", server, fresh }, { signal: ctx.signal });
    } catch (err) {
      if (err.code === "aborted") return;
      if (err.code === "no_source") {
        const tried = (err.data && err.data.tried) || [];
        const others = Object.keys(SERVER_TYPES).filter((k) => fitting(k) && k !== server && !tried.some((t) => t.server === k));
        const list = tried.length ? `<ul class="tried">${tried.map((t) => `<li>${t.message.startsWith(t.name) ? `<b>${esc(t.name)}</b>${esc(t.message.slice(t.name.length))}` : `<b>${esc(t.name)}:</b> ${esc(t.message)}`}</li>`).join("")}</ul>` : "";
        const buttons = others.length ? `<div class="row">${others.map((k) => `<button class="btn" type="button" data-try="${k}">Try ${SERVER_NAMES[k]}</button>`).join("")}</div>` : "";
        showProblem(err, {
          title: server === "auto" ? `No server has ${what} right now` : `${SERVER_NAMES[server]} doesn't have ${what}`,
          body: server === "auto" ? "Pierre asked every server. New releases often take a few days to show up, and servers come and go, so try again later." : "Another server might.",
          anim: "shrug",
          extra: list + buttons,
        });
        return;
      }
      showProblem(err);
      return;
    }
    if (ctx.signal.aborted) return;
    state.current = { ...state.current, server: `${src.name}${server === "auto" ? " (auto)" : ""}${src.via === "lookup" ? ", found by the Deno helper" : ""}` };
    usingDirect = Boolean(src.direct);
    mountVideo(resumeAt);
    if (server === "auto" || src.via === "lookup") toast(`Playing from ${src.name}${src.via === "lookup" ? ", found by the Deno helper" : ""}${src.direct ? ", straight from the source" : ""}`);
  }

  function mountVideo(resumeAt) {
    video = document.createElement("video");
    video.controls = true;
    video.playsInline = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    video.setAttribute("aria-label", series ? `${meta.title}, ${epCode(s, e)}` : meta.title);
    const want = prefs.get().subs;
    const chosen = want === "off" ? -1 : src.subtitles.findIndex((x) => x.lang === want);
    src.subtitles.forEach((x, i) => {
      const t = document.createElement("track");
      t.kind = "subtitles";
      t.label = x.label;
      t.srclang = x.lang || "und";
      t.src = x.url;
      if (i === chosen) t.default = true;
      video.append(t);
    });
    const overlay = document.createElement("div");
    overlay.className = "next-up";
    overlay.hidden = true;
    stage.replaceChildren(video, overlay);

    wireSubtitles(chosen);
    wireLinks();
    attach(resumeAt ?? resumePoint());
    wirePlayback(overlay);
  }

  function resumePoint() {
    // skip the resume when you'd barely started or were basically done (the credits)
    const p = progress.get(id, ek);
    if (!p || !p.d) return null;
    const margin = Math.min(series ? 60 : 300, p.d * 0.06);
    return p.t > Math.min(30, p.d * 0.1) && p.t < p.d - margin ? p.t : null;
  }

  async function attach(startAt) {
    let Hls = null;
    try {
      Hls = await loadHls();
    } catch (err) {
      if (!video.canPlayType("application/vnd.apple.mpegurl")) return showProblem({ code: "player", message: err.message });
    }
    if (ctx.signal.aborted || !video) return;
    const url = usingDirect ? src.direct : src.master;
    if (startAt) {
      video.addEventListener(
        "loadedmetadata",
        () => {
          video.currentTime = startAt;
          toast(`Picked up at ${fmtTime(startAt)}`);
        },
        { once: true },
      );
    }
    if (Hls && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, backBufferLength: 90, maxBufferLength: 40, startPosition: startAt ?? -1 });
      hls.on(Hls.Events.MANIFEST_PARSED, () => fillQuality());
      hls.on(Hls.Events.ERROR, (_, data) => onHlsError(Hls, data));
      hls.loadSource(url);
      hls.attachMedia(video);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
      video.addEventListener(
        "error",
        () => {
          if (usingDirect) return fallBackToRelay();
          showProblem({ code: "media", message: (video.error && video.error.message) || "The browser couldn't play this stream." });
        },
        { once: true },
      );
    } else {
      showProblem({ code: "unsupported", message: "This browser can't play HLS video. Try Chrome, Firefox, Edge or Safari." }, { retry: false });
      return;
    }
    video.play().catch(() => {});
  }

  function fallBackToRelay() {
    // the direct link didn't work from this browser: go through the worker instead
    const at = video && video.currentTime > 1 ? video.currentTime : null;
    cleanupMedia();
    usingDirect = false;
    mountVideo(at);
  }

  function onHlsError(Hls, data) {
    noteError({ code: data.details || data.type, message: `${data.type}: ${data.details}${data.response && data.response.code ? ` (HTTP ${data.response.code})` : ""}` });
    if (!data.fatal) return;
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      if (usingDirect) return fallBackToRelay();
      if (!retriedNetwork) {
        // most often the relay link expired: get fresh links and carry on from here
        retriedNetwork = true;
        const at = video && video.currentTime > 1 ? video.currentTime : null;
        start(at, true);
        return;
      }
      const others = Object.keys(SERVER_TYPES).filter((k) => fitting(k) && k !== src.server);
      showProblem(
        { code: data.details, message: "The video stopped loading." },
        {
          body: `${src.name}'s stream host may be down, or the worker used up Cloudflare's free daily limit (it resets at midnight UTC). Another server might work.`,
          extra: `<div class="row">${others.map((k) => `<button class="btn" type="button" data-try="${k}">Try ${SERVER_NAMES[k]}</button>`).join("")}</div>`,
        },
      );
      return;
    }
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 2) {
      mediaRecoveries++;
      if (mediaRecoveries === 2) hls.swapAudioCodec();
      hls.recoverMediaError();
      return;
    }
    showProblem({ code: data.details, message: "The browser couldn't decode this video." }, { body: "Some streams use codecs a browser can't play. Try another server." });
  }

  function fillQuality() {
    const sel = main.querySelector("[data-quality]");
    const levels = hls.levels.map((l, i) => ({ i, h: l.height || 0, b: l.bitrate })).sort((a, b) => b.h - a.h || b.b - a.b);
    const label = (h, b) => (h >= 2160 ? "4K" : h ? `${h}p` : `${Math.round(b / 1000)} kbps`);
    sel.innerHTML = `<option value="-1">Auto</option>` + levels.map((l) => `<option value="${l.i}">${label(l.h, l.b)}</option>`).join("");
    sel.disabled = levels.length < 2;
    const pref = prefs.get().quality;
    const match = levels.find((l) => l.h === pref);
    if (match) {
      hls.currentLevel = match.i;
      sel.value = String(match.i);
    } else {
      // don't start at 4K: Auto would happily pick it on a fast connection and burn data
      const cap = levels.find((l) => l.h && l.h <= 1080);
      if (cap) hls.autoLevelCapping = cap.i;
    }
    sel.onchange = () => {
      const v = Number(sel.value);
      hls.autoLevelCapping = -1;
      hls.currentLevel = v;
      prefs.set({ quality: v < 0 ? -1 : hls.levels[v].height || -1 });
    };
  }

  function wireSubtitles(chosen) {
    const sel = main.querySelector("[data-subs]");
    sel.innerHTML = `<option value="off">Off</option>` + src.subtitles.map((x, i) => `<option value="${i}">${esc(x.label)}</option>`).join("");
    sel.disabled = !src.subtitles.length;
    sel.value = chosen >= 0 ? String(chosen) : "off";
    const apply = () => {
      const v = sel.value;
      [...video.textTracks].forEach((t, i) => (t.mode = String(i) === v ? "showing" : "disabled"));
    };
    video.addEventListener("loadedmetadata", apply, { once: true });
    sel.onchange = () => {
      apply();
      const v = sel.value;
      prefs.set({ subs: v === "off" ? "off" : src.subtitles[Number(v)].lang });
    };
  }

  function wireLinks() {
    const link = src.master;
    const copy = main.querySelector("[data-copy]");
    copy.disabled = false;
    copy.onclick = async () => {
      const ok = await copyText(link);
      toast(ok ? "Stream link copied. Paste it into mpv, VLC or IINA." : "Couldn't copy. Your browser said no.");
    };
    const iina = main.querySelector("[data-iina]");
    if (iina) {
      iina.hidden = false;
      iina.href = `iina://weblink?url=${encodeURIComponent(link)}`;
    }
  }

  function wirePlayback(overlay) {
    let lastSave = 0;
    let napTimer = 0;
    let movedOn = false; // after the end, Continue watching points at the next episode: leave it
    const save = (force = false) => {
      if (!video || !video.duration || !Number.isFinite(video.duration)) return;
      const now = Date.now();
      if (!force && now - lastSave < 5000) return;
      lastSave = now;
      progress.save(id, ek, video.currentTime, video.duration);
      if (movedOn && video.ended) return;
      movedOn = false;
      history.save({ id, type, title: meta.title, poster: meta.poster || null, year: meta.year, server: server === "auto" ? "" : server, s, e, epTitle });
    };
    const on = (evt, fn) => video.addEventListener(evt, fn, { signal: ctx.signal });

    on("playing", () => {
      clearTimeout(napTimer);
      perch("popcorn");
      save(true);
    });
    on("waiting", () => perch("think"));
    on("pause", () => {
      save(true);
      if (video.ended) return;
      perch("peek");
      clearTimeout(napTimer);
      napTimer = later(() => perch("sleep"), 90e3);
    });
    on("timeupdate", () => save());
    on("ended", () => {
      save(true);
      progress.save(id, ek, video.duration, video.duration);
      perch("happy");
      if (!next) {
        if (series) history.save({ id, type, title: meta.title, poster: meta.poster || null, year: meta.year, server: server === "auto" ? "" : server, s, e, epTitle });
        return;
      }
      // keep Continue watching pointed at what's next
      movedOn = true;
      history.save({ id, type, title: meta.title, poster: meta.poster || null, year: meta.year, server: server === "auto" ? "" : server, s: next.s, e: next.e, epTitle: next.title || "" });
      if (!prefs.get().autoplay) return;
      let left = 8;
      overlay.hidden = false;
      overlay.innerHTML = `<p>${esc(epCode(next.s, next.e))} starts in <b data-left>${left}</b></p>
        <div class="row"><a class="btn primary" href="${href(next.s, next.e)}">Play now</a><button class="btn" type="button" data-cancel>Stay here</button></div>`;
      const tick = () => {
        left--;
        const b = overlay.querySelector("[data-left]");
        if (b) b.textContent = left;
        if (left <= 0) location.hash = href(next.s, next.e);
        else countdown = later(tick, 1000);
      };
      let countdown = later(tick, 1000);
      overlay.querySelector("[data-cancel]").onclick = () => {
        clearTimeout(countdown);
        overlay.hidden = true;
      };
    });
    window.addEventListener("pagehide", () => save(true), { signal: ctx.signal });

    if ("mediaSession" in navigator && window.MediaMetadata) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: series ? `${epCode(s, e)}${epTitle ? `: ${epTitle}` : ""}` : meta.title,
          artist: series ? meta.title : meta.year || "",
          album: "MMA",
          artwork: meta.poster ? [{ src: meta.poster }] : [],
        });
        navigator.mediaSession.setActionHandler("previoustrack", prev ? () => (location.hash = href(prev.s, prev.e)) : null);
        navigator.mediaSession.setActionHandler("nexttrack", next ? () => (location.hash = href(next.s, next.e)) : null);
      } catch {
        /* optional */
      }
    }

    cleanupMedia = () => {
      save(true);
      clearTimeout(napTimer);
      if (hls) {
        hls.destroy();
        hls = null;
      }
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
        video = null;
      }
      cleanupMedia = () => {};
    };
  }

  await start();

  return () => {
    cleanupMedia();
    timers.forEach(clearTimeout);
    if ("mediaSession" in navigator) {
      try {
        navigator.mediaSession.metadata = null;
        navigator.mediaSession.setActionHandler("previoustrack", null);
        navigator.mediaSession.setActionHandler("nexttrack", null);
      } catch {
        /* optional */
      }
    }
  };
}
