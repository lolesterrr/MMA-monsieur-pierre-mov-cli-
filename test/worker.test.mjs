// Worker tests against the fake sources (test/fake-sources.mjs). Needs ffmpeg for the test stream.
//   node --test test/worker.test.mjs
import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createHandler, makeToken, readToken, rewritePlaylist, masterPlaylist, language, srtToVtt, tidySubtitles, complaintIssue, issueLink, b64urlText } from "../worker/core.js";
import { startFake } from "./fake-sources.mjs";

let fake;
let env;
const handle = createHandler();
const ORIGIN = "https://w.test";
const ask = (path, init = {}) => handle(new Request(ORIGIN + path.replace(ORIGIN, ""), init), env);
const askJson = async (path, init) => {
  const res = await ask(path, init);
  return { status: res.status, body: await res.json(), headers: res.headers };
};
const movie = (id, tmdb, title, year, extra = "") => `/api/sources?type=movie&imdb=${id}&tmdb=${tmdb}&title=${encodeURIComponent(title)}&year=${year}${extra}`;

before(async () => {
  fake = await startFake();
  env = { ...fake.env, SIGNING_KEY: "test-key", GITHUB_TOKEN: "test-github-token", HEALTH_TITLE: "tt0000101,9101,The Grand Budapest Nap,2014" };
});
after(() => fake.stop());

// ---------- pieces

test("language names from codes, names and SDH labels", () => {
  assert.deepEqual(language("eng"), { lang: "en", label: "English" });
  assert.deepEqual(language("fre"), { lang: "fr", label: "French" });
  assert.deepEqual(language("English (SDH)"), { lang: "en", label: "English (SDH)" });
  assert.deepEqual(language("pob"), { lang: "pt", label: "Portuguese (Brazil)" });
  assert.deepEqual(language("pt-BR"), { lang: "pt", label: "Portuguese (Brazil)" });
  assert.equal(language("Klingon").label, "Klingon");
});

test("SRT becomes WebVTT", () => {
  const vtt = srtToVtt("﻿1\r\n00:00:01,500 --> 00:00:03,000\r\nHello\r\n");
  assert.equal(vtt, "WEBVTT\n\n1\n00:00:01.500 --> 00:00:03.000\nHello\n");
  assert.equal(srtToVtt("WEBVTT\n\n00:01.000 --> 00:02.000\nx"), "WEBVTT\n\n00:01.000 --> 00:02.000\nx\n");
});

test("subtitles: one per label, English first", () => {
  const out = tidySubtitles([
    { lang: "fr", label: "French", url: "a" },
    { lang: "en", label: "English", url: "b" },
    { lang: "en", label: "English", url: "c" },
    { lang: "de", label: "German", url: "" },
  ]);
  assert.deepEqual(out.map((s) => s.url), ["b", "a"]);
});

test("tokens: round trip, tampering and expiry", async () => {
  const t = await makeToken("k", { referer: "https://r.test/", hosts: ["a.test", "b.test"], ttl: 60 });
  assert.deepEqual((await readToken("k", t)).hosts, ["a.test", "b.test"]);
  assert.equal(await readToken("other", t), null);
  assert.equal(await readToken("k", t.replace(/^\d+/, (n) => String(Number(n) + 1))), null);
  assert.equal(await readToken("k", t, Date.now() + 120e3), null);
});

test("playlists: rewriting and a made-up master", () => {
  const text = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:2,\nseg000.ts\n';
  const out = rewritePlaylist(text, "https://cdn.test/a/720/index.m3u8", (u) => `R(${u})`);
  assert.match(out, /URI="R\(https:\/\/cdn\.test\/a\/720\/key\.bin\)"/);
  assert.match(out, /^R\(https:\/\/cdn\.test\/a\/720\/seg000\.ts\)$/m);
  const m = masterPlaylist([{ u: "x", h: 1080 }, { u: "y", h: 480 }]);
  assert.match(m, /BANDWIDTH=5000000,RESOLUTION=1920x1080\nx/);
  assert.match(m, /RESOLUTION=854x480\ny/);
});

// ---------- routes

test("health says what's set up, and checks every source", async () => {
  const { body } = await askJson("/api/health");
  assert.equal(body.signing, true);
  assert.equal(body.complaints, true);
  assert.deepEqual(body.servers, ["videasy", "lookmovie", "hexa"]);
  const deep = await askJson("/api/health?deep=1");
  assert.equal(deep.body.upstream, "ok");
  for (const s of ["videasy", "lookmovie", "hexa"]) assert.equal(deep.body.sources[s].ok, true, s);
});

test("a movie on videasy plays through the relay with videasy's referer", async () => {
  const { status, body } = await askJson(movie("tt0000101", "9101", "The Grand Budapest Nap", "2014"));
  assert.equal(status, 200);
  assert.equal(body.server, "videasy");
  assert.equal(body.direct, null);
  assert.ok(body.master.startsWith(`${ORIGIN}/p?`));
  // videasy's English plus OpenSubtitles' German (its English is a duplicate label)
  assert.deepEqual(body.subtitles.map((s) => s.label), ["English", "German"]);

  const master = await (await ask(body.master)).text();
  assert.match(master, /^#EXTM3U/);
  const variants = master.split("\n").filter((l) => l.startsWith(`${ORIGIN}/p?`));
  assert.equal(variants.length, 2);
  const media = await (await ask(variants[0])).text();
  const seg = media.split("\n").find((l) => l.startsWith(`${ORIGIN}/p?`));
  assert.ok(/URI="https:\/\/w\.test\/p\?/.test(media), "the AES key goes through the relay too");
  const s = await ask(seg);
  assert.equal(s.status, 200);
  assert.ok((await s.arrayBuffer()).byteLength > 1000);
  const hits = fake.requests.filter((r) => r.server === "guarded");
  assert.ok(hits.length >= 3);
  assert.ok(hits.every((r) => r.headers.referer === "https://player.videasy.to/"));

  const de = body.subtitles.find((x) => x.label === "German");
  const vtt = await ask(de.url);
  assert.equal(vtt.headers.get("content-type"), "text/vtt; charset=utf-8");
  assert.match(await vtt.text(), /^WEBVTT\n\n1\n00:00:00\.500 --> 00:00:04\.000\nHallo/);
});

test("auto falls back to lookmovie, which gets a made-up master and its own subtitles", async () => {
  const { status, body } = await askJson(movie("tt0000102", "9102", "Napocalypse Now", "1979"));
  assert.equal(status, 200);
  assert.equal(body.server, "lookmovie");
  assert.deepEqual(body.tried.map((t) => t.server), ["videasy"]);
  assert.ok(body.master.startsWith(`${ORIGIN}/m?`));
  assert.deepEqual(body.subtitles.map((s) => s.label), ["English", "French", "German"]);
  const master = await (await ask(body.master)).text();
  assert.match(master, /RESOLUTION=1280x720\nhttps:\/\/w\.test\/p\?/);
  assert.match(master, /RESOLUTION=640x360\nhttps:\/\/w\.test\/p\?/);
  const variant = master.split("\n").find((l) => l.startsWith(`${ORIGIN}/p?`));
  assert.match(await (await ask(variant)).text(), /#EXTINF/);
});

test("hexa streams come with a direct link the browser can play", async () => {
  const { body } = await askJson(movie("tt0000103", "9103", "Pierre Fiction", "1994"));
  assert.equal(body.server, "hexa");
  assert.deepEqual(body.tried.map((t) => t.server), ["videasy", "lookmovie"]);
  assert.match(body.direct, /^http:\/\/127\.0\.0\.1:\d+\/hx\/tt0000103\/720\/index\.m3u8$/);
  const direct = await fetch(body.direct, { headers: { Origin: "https://lolesterrr.github.io" } });
  assert.equal(direct.headers.get("access-control-allow-origin"), "*");
  assert.match(await (await ask(body.master)).text(), /^#EXTM3U/);
});

test("nothing anywhere: 404 with what every server said", async () => {
  const { status, body } = await askJson(movie("tt0000104", "9104", "The Nap Knight", "2008"));
  assert.equal(status, 404);
  assert.equal(body.error, "no_source");
  assert.deepEqual(body.tried.map((t) => t.server), ["videasy", "lookmovie", "hexa"]);
  assert.ok(body.servers.length === 3);
});

test("no TMDB id: videasy and hexa step aside, lookmovie still finds it by IMDb id", async () => {
  const { body } = await askJson(movie("tt0000105", "", "No Ids Here", "2001"));
  assert.equal(body.server, "lookmovie");
  assert.equal(body.tried[0].error, "no_id");
});

test("series episodes, on the second videasy server when the first has nothing", async () => {
  const a = await askJson("/api/sources?type=series&imdb=tt0000201&tmdb=9201&title=Breaking%20Nap&year=2008&s=1&e=2");
  assert.equal(a.body.server, "videasy");
  assert.match(await (await ask(a.body.master)).text(), /^#EXTM3U/);
  const b = await askJson("/api/sources?type=series&imdb=tt0000202&tmdb=9202&title=Stranger%20Naps&year=2016&s=1&e=3");
  assert.equal(b.status, 200);
  assert.ok(fake.requests.some((r) => r.path.startsWith("/videasy/boise/sources") && r.path.includes("seasonId=1&") && r.path.includes("episodeId=3&")));
});

test("picking a server: hexa for a series works, lookmovie for a series doesn't", async () => {
  const h = await askJson("/api/sources?type=series&imdb=tt0000201&tmdb=9201&title=Breaking%20Nap&year=2008&s=2&e=1&server=hexa");
  assert.equal(h.body.server, "hexa");
  assert.ok(fake.requests.some((r) => r.path === "/hexa/api/tmdb/tv/9201/season/2/episode/1/images"));
  const l = await askJson("/api/sources?type=series&imdb=tt0000201&tmdb=9201&title=Breaking%20Nap&s=1&e=1&server=lookmovie");
  assert.equal(l.status, 404);
  assert.match(l.body.message, /doesn't do series/);
});

test("Cloudflare's bot check everywhere shows up as blocked", async () => {
  fake.set({ blocked: true });
  try {
    const { status, body } = await askJson(movie("tt0000101", "9101", "The Grand Budapest Nap", "2014", "&server=lookmovie"));
    assert.equal(status, 503);
    assert.equal(body.error, "blocked");
  } finally {
    fake.set({ blocked: false });
  }
});

test("bad requests", async () => {
  assert.equal((await askJson("/api/sources?type=movie&imdb=nope")).body.error, "bad_id");
  assert.equal((await askJson("/api/sources?type=series&imdb=tt0000201&s=1")).body.error, "no_episode");
  assert.equal((await askJson("/api/nothing")).status, 404);
  assert.equal((await askJson("/api/sources?type=movie&imdb=tt1", { method: "DELETE" })).status, 405);
});

test("the relay only follows its own signed links, to their own hosts", async () => {
  const { body } = await askJson(movie("tt0000101", "9101", "The Grand Budapest Nap", "2014"));
  const u = new URL(body.master);
  const t = u.searchParams.get("t");
  assert.equal((await ask(`/p?t=${t}&u=${encodeURIComponent("https://evil.test/x")}`)).status, 403);
  assert.equal((await ask(`/p?t=${t.slice(0, -2)}xx&u=${encodeURIComponent(u.searchParams.get("u"))}`)).status, 403);
  const other = await makeToken("someone-else", { hosts: ["evil.test"] });
  assert.equal((await ask(`/p?t=${other}&u=${encodeURIComponent("https://evil.test/x")}`)).status, 403);
  assert.equal((await ask(`/m?t=${t}&v=${b64urlText(JSON.stringify([{ u: "https://evil.test/a.m3u8", h: 720 }]))}`)).status, 403);
  const noKey = await handle(new Request(body.master), { ...env, SIGNING_KEY: "" });
  assert.equal(noKey.status, 501);
});

test("no SIGNING_KEY: sources says how to fix it", async () => {
  const res = await handle(new Request(ORIGIN + movie("tt0000101", "9101", "x", "2014")), { ...env, SIGNING_KEY: "" });
  assert.equal(res.status, 501);
  assert.equal((await res.json()).error, "setup");
});

test("CORS: allowed origins only", async () => {
  const e2 = { ...env, ALLOWED_ORIGINS: "https://lolesterrr.github.io,http://localhost:*" };
  const h = async (origin) => (await handle(new Request(`${ORIGIN}/api/health`, { headers: { Origin: origin } }), e2)).headers.get("access-control-allow-origin");
  assert.equal(await h("https://lolesterrr.github.io"), "https://lolesterrr.github.io");
  assert.equal(await h("http://localhost:5500"), "http://localhost:5500");
  assert.equal(await h("https://evil.test"), null);
});

test("complaints become GitHub issues", async () => {
  const before = fake.issues.length;
  const payload = { kind: "video", message: "The Grand Budapest Nap is just a test pattern.\nAlso Pierre ate my popcorn.", elapsed: 5000, context: { page: "#/watch/movie/tt0000101", title: "The Grand Budapest Nap", id: "tt0000101", server: "Videasy (auto)", error: "x: y" } };
  const { status, body } = await askJson("/api/complaint", { method: "POST", body: JSON.stringify(payload), headers: { "CF-Connecting-IP": "1.1.1.1" } });
  assert.equal(status, 201);
  assert.equal(body.number, before + 1);
  const issue = fake.issues.at(-1);
  assert.equal(issue.path, "/github/repos/lolesterrr/MMA-monsieur-pierre-mov-cli-/issues");
  assert.deepEqual(issue.labels, ["complaint", "video"]);
  assert.match(issue.title, /^\[Video won't play\] The Grand Budapest Nap is just/);
  assert.match(issue.body, /\| Server \| Videasy \(auto\) \|/);
  const dup = await askJson("/api/complaint", { method: "POST", body: JSON.stringify(payload), headers: { "CF-Connecting-IP": "1.1.1.1" } });
  assert.equal(dup.body.error, "duplicate");
  const fast = await askJson("/api/complaint", { method: "POST", body: JSON.stringify({ ...payload, message: "quick", elapsed: 200 }), headers: { "CF-Connecting-IP": "1.1.1.2" } });
  assert.equal(fast.body.error, "too_fast");
  const pot = await askJson("/api/complaint", { method: "POST", body: JSON.stringify({ ...payload, website: "spam" }), headers: { "CF-Connecting-IP": "1.1.1.3" } });
  assert.equal(pot.body.number, 0);
});

test("without GITHUB_TOKEN, complaints come back as a prefilled link", async () => {
  const res = await handle(new Request(`${ORIGIN}/api/complaint`, { method: "POST", body: JSON.stringify({ kind: "idea", message: "More naps please", elapsed: 4000 }), headers: { "CF-Connecting-IP": "2.2.2.2" } }), { ...env, GITHUB_TOKEN: "" });
  const body = await res.json();
  assert.equal(res.status, 501);
  assert.match(body.fallback, /^https:\/\/github\.com\/lolesterrr\/MMA-monsieur-pierre-mov-cli-\/issues\/new\?/);
  const issue = complaintIssue("idea", "More naps please", {});
  assert.ok(issueLink("a/b", issue).includes("labels=complaint%2Cidea"));
});

test("complaints are rate limited per visitor", async () => {
  const e2 = { ...env, COMPLAINTS_PER_10_MIN: "2" };
  const send = (i) => handle(new Request(`${ORIGIN}/api/complaint`, { method: "POST", body: JSON.stringify({ kind: "other", message: `number ${i}`, elapsed: 4000 }), headers: { "CF-Connecting-IP": "3.3.3.3" } }), e2);
  assert.equal((await send(1)).status, 201);
  assert.equal((await send(2)).status, 201);
  assert.equal((await send(3)).status, 429);
});

test("the lookup helper's links play through the worker (shared SIGNING_KEY, RELAY_ORIGIN)", async () => {
  const helper = createHandler();
  const helperEnv = { ...env, RELAY_ORIGIN: `${ORIGIN}/`, SERVERS: "videasy,hexa" };
  const res = await helper(new Request(`https://helper.test${movie("tt0000101", "9101", "The Grand Budapest Nap", "2014")}`), helperEnv);
  const body = await res.json();
  assert.equal(body.server, "videasy");
  assert.ok(body.master.startsWith(`${ORIGIN}/p?`), body.master);
  assert.ok(body.subtitles.every((s) => s.url.startsWith(`${ORIGIN}/p?`)));
  const health = await (await helper(new Request("https://helper.test/api/health"), helperEnv)).json();
  assert.equal(health.name, "MMA lookup helper");
  assert.deepEqual(health.servers, ["videasy", "hexa"]);
  // the worker (no RELAY_ORIGIN, same key) relays it
  const master = await ask(body.master);
  assert.equal(master.status, 200);
  assert.match(await master.text(), /^#EXTM3U/);
});
