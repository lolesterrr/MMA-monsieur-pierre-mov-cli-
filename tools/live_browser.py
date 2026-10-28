# Plays titles on the live MMA site in headless Chromium and records what happens.
import json, os, time
from playwright.sync_api import sync_playwright

SITE = "https://lolesterrr.github.io/MMA-monsieur-pierre-mov-cli-/"
CASES = [
    ("rehearsal-s1e1-videasy", "#/watch/series/tt10802170/1/1?server=videasy"),
    ("rehearsal-s1e1-auto", "#/watch/series/tt10802170/1/1"),
    ("bb-s1e1-videasy", "#/watch/series/tt0903747/1/1?server=videasy"),
    ("inception-videasy", "#/watch/movie/tt1375666?server=videasy"),
    ("inception-auto", "#/watch/movie/tt1375666"),
]
os.makedirs("diag-shots", exist_ok=True)
out = {}
with sync_playwright() as p:
    browser = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
    for name, path in CASES:
        ctx = browser.new_context(viewport={"width": 1280, "height": 800})
        page = ctx.new_page()
        rec = {"api": [], "media": [], "failed": [], "console": [], "pageerrors": []}
        page.on("console", lambda m, rec=rec: rec["console"].append(f"{m.type}: {m.text[:300]}") if m.type in ("error", "warning") else None)
        page.on("pageerror", lambda e, rec=rec: rec["pageerrors"].append(str(e)[:300]))
        page.on("requestfailed", lambda r, rec=rec: rec["failed"].append(f"{r.url[:160]} {r.failure}"))
        def on_resp(r, rec=rec):
            u = r.url
            if "/api/sources" in u:
                try:
                    body = r.text()[:1500]
                except Exception as e:
                    body = f"(no body: {e})"
                rec["api"].append({"url": u[:220], "status": r.status, "body": body, "t": round(time.time() - rec["t0"], 1)})
            elif "/p?" in u or "/m?" in u or ".m3u8" in u or ".ts" in u or "hexa" in u:
                if len(rec["media"]) < 40:
                    rec["media"].append({"url": u[:160], "status": r.status, "type": r.headers.get("content-type"), "len": r.headers.get("content-length"), "t": round(time.time() - rec["t0"], 1)})
        page.on("response", on_resp)
        rec["t0"] = time.time()
        page.goto(SITE + path)
        state = None
        for i in range(30):  # up to ~75s
            page.wait_for_timeout(2500)
            state = page.evaluate("""() => {
              const v = document.querySelector('video');
              const prob = document.querySelector('.problem');
              return { t: v ? v.currentTime : null, ready: v ? v.readyState : null, err: v && v.error ? v.error.message : null,
                problem: prob ? prob.innerText.slice(0, 600) : null,
                toasts: [...document.querySelectorAll('#toasts .toast')].map(x => x.innerText),
                stage: (document.querySelector('.stage-msg') || {}).innerText || null }
            }""")
            if (state["t"] or 0) > 3 or state["problem"]:
                break
        rec["final"] = state
        rec["seconds"] = round(time.time() - rec["t0"], 1)
        page.screenshot(path=f"diag-shots/{name}.png")
        del rec["t0"]
        out[name] = rec
        print(name, json.dumps(state)[:400])
        ctx.close()
    browser.close()
json.dump(out, open("diag-browser.json", "w"), indent=1)
