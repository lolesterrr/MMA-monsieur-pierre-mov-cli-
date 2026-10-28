// The test stream: 12 seconds of ffmpeg's test pattern as HLS, 720p (AES-128 encrypted) and 360p.
// Copied from MPA's fake hianime.
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { randomBytes, createCipheriv } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Make a 12 second HLS stream with ffmpeg: 720p AES-128 encrypted, 360p clear.
 * codec "h264" (TS segments, what real hosts serve) or "vp9" (fMP4 + Opus, for test browsers
 * like Playwright's Chromium that ship without H.264).
 */
export function ensureMedia(codec = "h264", dir = join(tmpdir(), `mma-fake-media-${codec}`)) {
  const marker = join(dir, "ready");
  if (existsSync(marker)) return ensureFile(codec, dir);
  for (const q of ["720", "360"]) mkdirSync(join(dir, q), { recursive: true });
  writeFileSync(join(dir, "720", "key.bin"), randomBytes(16));
  writeFileSync(join(dir, "720", "keyinfo.txt"), `key.bin\n${join(dir, "720", "key.bin")}\n`);
  const common = ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i"];
  const hls = ["-f", "hls", "-hls_time", "2", "-hls_playlist_type", "vod"];
  const enc =
    codec === "vp9"
      ? ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "700k", "-g", "48", "-keyint_min", "48", "-pix_fmt", "yuv420p", "-c:a", "libopus", "-b:a", "64k", ...hls, "-hls_segment_type", "fmp4", "-hls_fmp4_init_filename", "init.mp4"]
      : ["-c:v", "libx264", "-preset", "veryfast", "-g", "48", "-keyint_min", "48", "-sc_threshold", "0", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "64k", ...hls];
  const ext = codec === "vp9" ? "m4s" : "ts";
  // ffmpeg can't encrypt fMP4 HLS, so for vp9 the 720p segments get encrypted below instead
  const keyFlags = codec === "vp9" ? [] : ["-hls_key_info_file", join(dir, "720", "keyinfo.txt")];
  for (const [q, size, extra] of [
    ["720", "1280x720", keyFlags],
    ["360", "640x360", []],
  ]) {
    execFileSync("ffmpeg", [
      ...common, `testsrc2=size=${size}:rate=24`, "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=48000",
      "-t", "12", ...enc, ...extra, "-hls_segment_filename", join(dir, q, `seg%03d.${ext}`), join(dir, q, "index.m3u8"),
    ]);
  }
  if (codec === "vp9") {
    const key = readFileSync(join(dir, "720", "key.bin"));
    const iv = Buffer.alloc(16);
    for (const f of readdirSync(join(dir, "720")).filter((x) => x.endsWith(".m4s"))) {
      const path = join(dir, "720", f);
      const c = createCipheriv("aes-128-cbc", key, iv);
      writeFileSync(path, Buffer.concat([c.update(readFileSync(path)), c.final()]));
    }
    const list = join(dir, "720", "index.m3u8");
    const text = readFileSync(list, "utf8").replace(/(#EXT-X-MAP:[^\n]*\n)/, `$1#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x${iv.toString("hex")}\n`);
    writeFileSync(list, text);
  }
  writeFileSync(marker, "ok");
  return ensureFile(codec, dir);
}

/** The same test pattern as one plain MP4 file (file.mp4), like VidLink's MovieBox copies. */
function ensureFile(codec, dir) {
  const file = join(dir, "file.mp4");
  if (existsSync(file)) return dir;
  const enc = codec === "vp9" ? ["-c:v", "libvpx-vp9", "-deadline", "realtime", "-cpu-used", "8", "-b:v", "500k", "-c:a", "libopus"] : ["-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac"];
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "12", ...enc, "-movflags", "+faststart", file]);
  return dir;
}

