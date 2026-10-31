// MMA lookup helper for Deno Deploy.
//
// Some sources refuse to talk to Cloudflare's servers, but happily hand links to anyone else.
// This runs the same code as the worker, somewhere that isn't Cloudflare, and only does the
// lookups: the links it returns point at the Cloudflare worker's relay (RELAY_ORIGIN), signed
// with the same SIGNING_KEY, so the video itself still goes through Cloudflare. The exception is
// VidLink's MP4 files, whose host refuses Cloudflare: those play through here, and they're what
// uses Deno's free data (20 GiB a month, a few hundred MB per episode). Lookups are a few kilobytes.
//
// Deno Deploy settings: entrypoint deno/main.js, no build. Environment variables:
//   SIGNING_KEY     the same value as the Cloudflare worker's
//   RELAY_ORIGIN    the Cloudflare worker's address, e.g. https://mma.your-name.workers.dev
//   SERVERS         videasy,hexa,vidlink  (leave LookMovie out: its links only work from the machine that
//                   asked for them, so one found here gets "WRONG HASH!" in the browser)
//   ALLOWED_ORIGINS https://lolesterrr.github.io
import { createHandler, readToken } from "../worker/core.js";

const handle = createHandler();
const KEYS = ["SIGNING_KEY", "RELAY_ORIGIN", "SERVERS", "ALLOWED_ORIGINS", "HEALTH_TITLE", "TOKEN_TTL", "ENCDEC_URL", "VIDEASY_URL", "LOOKMOVIE_URL", "HEXA_URL", "AUTOEMBED_URL", "VIDLINK_URL", "SUBS_URL"];
const env = Object.fromEntries(KEYS.map((k) => [k, Deno.env.get(k)]).filter(([, v]) => v));
if (!env.SERVERS) env.SERVERS = "videasy,hexa,vidlink";

Deno.serve(async (request, info) => {
  const url = new URL(request.url);
  // VidLink's MP4 files are the one kind of video the helper carries itself: their host answers
  // Cloudflare with HTTP 427. Only links signed with a User-Agent (VidLink's) are relayed here,
  // so Videasy or Hexa video can't eat Deno's 20 GiB a month.
  if (url.pathname === "/p" && (request.method === "OPTIONS" || ((await readToken(env.SIGNING_KEY || "", url.searchParams.get("t"))) || {}).ua)) {
    return handle(request, env);
  }
  // otherwise lookups only: the video goes through the Cloudflare worker, and complaints too
  if (!url.pathname.startsWith("/api/") || url.pathname === "/api/complaint" || url.pathname === "/api/reach") {
    if (request.method === "OPTIONS") return handle(request, env);
    return new Response(JSON.stringify({ error: "not_here", message: "This helper only finds links. Video and complaints go through the worker." }), {
      status: 404,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    });
  }
  const headers = new Headers(request.headers);
  headers.set("CF-Connecting-IP", info.remoteAddr.hostname);
  return handle(new Request(request, { headers }), env);
});
