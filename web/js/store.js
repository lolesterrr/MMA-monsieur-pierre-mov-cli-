// Everything MMA remembers lives in this browser's localStorage. No accounts, nothing on a server.
// Every read and write is wrapped, because private windows and blocked storage throw.

const PREFIX = "mma:";

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function remove(key) {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    /* nothing to do */
  }
}

const DEFAULT_PREFS = { quality: -1, subs: "off", autoplay: true };

export const prefs = {
  get() {
    return { ...DEFAULT_PREFS, ...read("prefs", {}) };
  },
  set(patch) {
    const next = { ...prefs.get(), ...patch };
    write("prefs", next);
    return next;
  },
};

/** "s1e3" for an episode, "" for a movie */
export const epKey = (s, e) => (s === undefined || s === null || s === "" ? "" : `s${s}e${e}`);

// Titles you've started: newest first, one entry per title.
// { id, type, title, poster, s, e, epTitle }
export const history = {
  all() {
    const list = read("history", []);
    return Array.isArray(list) ? list : [];
  },
  get(id) {
    return history.all().find((h) => h.id === id) || null;
  },
  save(entry) {
    const list = history.all().filter((h) => h.id !== entry.id);
    list.unshift({ ...entry, at: Date.now() });
    write("history", list.slice(0, 40));
  },
  forget(id) {
    write("history", history.all().filter((h) => h.id !== id));
    const p = read("progress", {});
    for (const k of Object.keys(p)) if (k.startsWith(id + "#")) delete p[k];
    write("progress", p);
  },
};

// Where you stopped in each movie or episode.
export const progress = {
  key: (id, ep = "") => `${id}#${ep}`,
  get(id, ep = "") {
    return read("progress", {})[progress.key(id, ep)] || null;
  },
  save(id, ep, t, d) {
    const all = read("progress", {});
    all[progress.key(id, ep)] = { t: Math.round(t), d: Math.round(d), at: Date.now() };
    const keys = Object.keys(all);
    if (keys.length > 800) {
      keys.sort((a, b) => all[a].at - all[b].at).slice(0, keys.length - 800).forEach((k) => delete all[k]);
    }
    write("progress", all);
  },
  watched(id, ep = "") {
    const p = progress.get(id, ep);
    return Boolean(p && p.d && p.t / p.d > 0.9);
  },
  started(id, ep = "") {
    const p = progress.get(id, ep);
    return Boolean(p && p.t > 20);
  },
};

export const recent = {
  all: () => read("recent", []),
  add(q) {
    const list = recent.all().filter((x) => x.toLowerCase() !== q.toLowerCase());
    list.unshift(q);
    write("recent", list.slice(0, 8));
  },
  clear: () => remove("recent"),
};

export const settings = {
  apiOverride: () => read("api", ""),
  setApiOverride: (url) => (url ? write("api", url) : remove("api")),
  pierreAwake: () => read("pierre", true) !== false,
  setPierreAwake: (on) => write("pierre", Boolean(on)),
};
