import json, time
from playwright.sync_api import sync_playwright
SITE = "https://lolesterrr.github.io/MMA-monsieur-pierre-mov-cli-/"
CASES = [("dw2005-s1e1", "#/watch/series/tt0436992/1/1"), ("dw2005-s2e1", "#/watch/series/tt0436992/2/1"), ("dw2023-s1e1", "#/watch/series/tt31433814/1/1"), ("dw2005-s4e1", "#/watch/series/tt0436992/4/1")]
out = {}
with sync_playwright() as p:
    browser = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
    ctx = browser.new_context(viewport={"width": 1280, "height": 800})
    ctx.add_init_script("try { localStorage.setItem('mma:pierre-pass', 'c060381bb81e9503d9037372e5683245e674068dfc0c1af1eb05f01086b90008') } catch (e) {}")
    page = ctx.new_page()
    for name, path in CASES:
        rec = {"api": [], "hosts": set()}
        def on_resp(r, rec=rec):
            if "/api/sources" in r.url:
                try: b = json.loads(r.text())
                except Exception: b = {}
                rec["api"].append({"status": r.status, "server": b.get("server"), "direct": (b.get("direct") or "")[:70], "msg": (b.get("message") or "")[:150]})
            elif ".m3u8" in r.url or "/p?" in r.url:
                rec["hosts"].add(("relay " if "/p?" in r.url else "direct ") + str(r.status))
        page.on("response", on_resp)
        t0 = time.time()
        page.goto(SITE + path)
        st = None
        for i in range(30):
            page.wait_for_timeout(2500)
            st = page.evaluate("() => { const v = document.querySelector('video'); const p = document.querySelector('.problem'); return { t: v ? v.currentTime : null, dur: v ? Math.round(v.duration / 6) / 10 : null, problem: p ? p.innerText.slice(0, 300) : null, ep: (document.querySelector('#watch-ep') || {}).innerText || null } }")
            if (st["t"] or 0) > 3 or st["problem"]:
                break
        page.remove_listener("response", on_resp)
        rec["final"] = st; rec["seconds"] = round(time.time() - t0, 1); rec["hosts"] = sorted(rec["hosts"])
        out[name] = rec
    browser.close()
json.dump(out, open("diag-browser.json", "w"), indent=1)
