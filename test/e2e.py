"""Click through MMA in headless Chromium against the offline demo (node test/demo.mjs).

    pip install playwright && python -m playwright install chromium
    FAKE_CODEC=vp9 node test/demo.mjs &   python3 test/e2e.py [--shots docs/screenshots]

Checks: home and popular, search with filters, a movie through the relay (HLS + AES key +
subtitles), resume, server switching, a direct stream, the no-server state, a series with
seasons, specials, upcoming episodes and next-episode countdown, the complaint desk, Backstage,
phones, and no console errors. Writes screenshots when --shots is given.
"""
import os
import sys
import time

from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("MMA_URL", "http://127.0.0.1:8787")
SHOTS = sys.argv[sys.argv.index("--shots") + 1] if "--shots" in sys.argv else None
if SHOTS:
    os.makedirs(SHOTS, exist_ok=True)

errors = []


def shot(page, name):
    if SHOTS:
        page.wait_for_timeout(350)
        page.screenshot(path=os.path.join(SHOTS, f"{name}.png"))


def watch_errors(page):
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    page.on("console", lambda m: m.type == "error" and errors.append(f"console: {m.text}"))


def playing(page, past=0.8, timeout=30000):
    page.wait_for_function(f"() => {{ const v = document.querySelector('video'); return v && v.currentTime > {past} }}", timeout=timeout)


def run_desktop(p, scheme="light"):
    browser = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
    ctx = browser.new_context(viewport={"width": 1366, "height": 900}, color_scheme=scheme)
    page = ctx.new_page()
    watch_errors(page)
    sfx = "" if scheme == "light" else "-dark"

    # home: Pierre, the search box, popular movies and series
    page.goto(BASE + "/")
    expect(page.locator(".hero .bubble")).to_contain_text("Bonjour")
    expect(page.locator("[data-popular] .show")).to_have_count(5)
    page.click('[data-pop="series"]')
    expect(page.locator("[data-popular] .show")).to_have_count(2)
    page.click('[data-pop="movie"]')
    expect(page.locator("[data-popular] .show")).to_have_count(5)
    page.wait_for_function("() => [...document.querySelectorAll('.grid img')].every(i => i.complete && i.naturalWidth > 0)")
    shot(page, f"home{sfx}")

    # search, with the movies / series filter
    page.fill("#hero-q", "nap")
    page.press("#hero-q", "Enter")
    expect(page.locator(".grid .show")).to_have_count(5)
    expect(page.locator(".count")).to_have_text("3 movies, 2 series")
    page.click('[data-filter="series"]')
    expect(page.locator(".grid .show")).to_have_count(2)
    page.click('[data-filter="all"]')
    page.wait_for_function("() => [...document.querySelectorAll('.grid img')].every(i => i.complete && i.naturalWidth > 0)")
    shot(page, f"results{sfx}")

    # a movie: title page, then play through the relay
    page.click("text=The Grand Budapest Nap")
    expect(page.locator("#anime-title")).to_have_text("The Grand Budapest Nap")
    expect(page.locator(".about")).to_contain_text("made-up movie")
    expect(page.locator(".play")).to_have_text("Watch")
    shot(page, f"movie{sfx}")
    page.click(".play")
    playing(page)
    expect(page.locator("#toasts .toast").last).to_contain_text("Playing from Videasy")
    tracks = page.evaluate("() => [...document.querySelector('video').textTracks].map(t => [t.label, t.mode])")
    assert tracks == [["English", "disabled"], ["German", "disabled"]], tracks
    expect(page.locator("[data-quality] option")).to_have_count(3)
    expect(page.locator("[data-server] option")).to_have_count(5)
    expect(page.locator(".perch")).to_have_attribute("data-anim", "popcorn")
    page.select_option("[data-subs]", label="English")
    page.wait_for_function("() => [...document.querySelector('video').textTracks].some(t => t.label === 'English' && t.mode === 'showing')")
    shot(page, f"watch{sfx}")

    # switch server mid-movie: LookMovie, carrying on from where we were
    page.select_option("[data-server]", "lookmovie")
    expect(page).to_have_url(f"{BASE}/#/watch/movie/tt0000101?server=lookmovie")
    playing(page, 0.5)
    tracks = page.evaluate("() => [...document.querySelector('video').textTracks].map(t => t.label)")
    assert tracks == ["English", "French", "German"], tracks
    # and it plays straight from LookMovie's host, not through the relay
    lm = page.evaluate("() => performance.getEntriesByType('resource').map(e => e.name).filter(n => n.includes('/lm/'))")
    assert lm and all("/p?" not in n and "/m?" not in n for n in lm), lm
    # the subtitle choice stuck
    page.wait_for_function("() => [...document.querySelector('video').textTracks].some(t => t.label === 'English' && t.mode === 'showing')")

    # Continue watching remembers it, and resuming picks up
    page.wait_for_function("() => document.querySelector('video').currentTime > 2")
    page.evaluate("() => document.querySelector('video').pause()")
    page.wait_for_timeout(300)
    page.click(".brand")
    expect(page.locator(".cw-title").first).to_have_text("The Grand Budapest Nap")
    expect(page.locator(".cw-ep").first).to_have_text("Movie, 2014")
    page.click(".cw-link >> nth=0")
    expect(page.locator("#toasts .toast").last).to_contain_text("Picked up at", timeout=20000)
    page.evaluate("() => document.querySelector('video').pause()")

    # complaint desk from the watch page
    page.click(".top .complain")
    expect(page.locator("#desk")).to_be_visible()
    expect(page.locator('#desk input[name="kind"][value="video"]')).to_be_checked()
    expect(page.locator("#desk [data-context]")).to_contain_text("server: LookMovie")
    page.fill("#desk textarea", f"The Grand Budapest Nap is a test pattern ({scheme} run {int(time.time() * 1000)}). Also Pierre ate my popcorn.")
    shot(page, f"desk{sfx}")
    page.wait_for_timeout(1600)  # the desk ignores complaints sent faster than a human could type
    page.click("#desk [data-send]")
    expect(page.locator("#desk [data-done-title]")).to_contain_text("Filed as #", timeout=10000)
    page.click("#desk [data-done-actions] [data-close]")

    # Pierre Fiction is only on hexa, which plays straight from the stream host
    page.goto(BASE + "/#/watch/movie/tt0000103")
    playing(page)
    relayed = page.evaluate("() => performance.getEntriesByType('resource').map(e => e.name).filter(n => n.includes('/hx/') || (n.includes('/p?') && n.includes('hx')))")
    assert relayed and all("/p?" not in n for n in relayed), relayed

    # VidLink: a plain MP4 file through the relay, in the <video> element without hls.js
    page.goto(BASE + "/#/watch/movie/tt0000103?server=vidlink")
    playing(page)
    assert page.evaluate("() => document.querySelector('video').src.includes('/p?')")
    expect(page.locator("[data-quality] option").first).to_be_attached()
    # an HEVC-only copy: plays where the browser does HEVC, otherwise says so plainly
    page.goto(BASE + "/#/watch/series/tt0000202/1/3?server=vidlink")
    hevc = page.evaluate("""() => ['video/mp4; codecs="hvc1.1.6.L93.B0"'].some(t => document.createElement('video').canPlayType(t) !== '' || (window.MediaSource && MediaSource.isTypeSupported(t)))""")
    if not hevc:
        expect(page.locator(".problem h2")).to_contain_text("HEVC")
        shot(page, f"hevc{sfx}")

    # nothing anywhere
    page.goto(BASE + "/#/watch/movie/tt0000104")
    expect(page.locator(".problem h2")).to_have_text("No server has The Nap Knight right now")
    expect(page.locator(".tried li")).to_have_count(4)
    shot(page, f"none{sfx}")
    page.click(".problem [data-complain]")
    expect(page.locator("#desk [data-context]")).to_contain_text("error: no_source")
    page.keyboard.press("Escape")

    # a series: seasons, specials, an episode that isn't out yet
    page.goto(BASE + "/#/title/series/tt0000201")
    expect(page.locator("#anime-title")).to_have_text("Breaking Nap")
    expect(page.locator("[data-season]")).to_have_count(3)
    expect(page.locator('[data-season="1"]')).to_have_attribute("aria-selected", "true")
    expect(page.locator(".ep-list li")).to_have_count(3)
    expect(page.locator(".play")).to_have_text("Start S1 E1")
    page.wait_for_function("() => [...document.querySelectorAll('.ep-thumb img')].every(i => i.complete)")
    shot(page, f"series{sfx}")
    page.click('[data-season="2"]')
    expect(page.locator(".ep-list li")).to_have_count(3)
    expect(page.locator(".ep-row.upcoming")).to_have_count(1)
    page.click('[data-season="0"]')
    expect(page.locator(".ep-title")).to_have_text("Behind the Naps")
    page.click('[data-season="1"]')
    page.click(".ep-list li >> nth=1")
    expect(page.locator("#watch-ep")).to_have_text("S1 E2: The Nap, Part 2")
    playing(page)
    expect(page.locator("[data-prev]")).to_have_attribute("href", "#/watch/series/tt0000201/1/1")
    expect(page.locator("[data-next]")).to_have_attribute("href", "#/watch/series/tt0000201/1/3")
    # the end of S1 E3 leads to S2 E1
    page.goto(BASE + "/#/watch/series/tt0000201/1/3")
    playing(page, 0.3)
    expect(page.locator("[data-next]")).to_have_attribute("href", "#/watch/series/tt0000201/2/1")
    page.evaluate("() => { const v = document.querySelector('video'); v.currentTime = v.duration - 0.4 }")
    expect(page.locator(".next-up")).to_contain_text("S2 E1 starts in", timeout=15000)
    shot(page, f"next-up{sfx}")
    page.click(".next-up [data-cancel]")
    page.click(".brand")
    expect(page.locator(".cw-ep").first).to_contain_text("S2 E1")

    # Backstage check
    page.click(".foot [data-backstage]")
    page.click("#backstage [data-check]")
    expect(page.locator("#backstage .status li")).to_have_count(8, timeout=20000)
    expect(page.locator("#backstage .status")).to_contain_text("Reachable, version")
    expect(page.locator("#backstage .status li.ok")).to_have_count(8)
    shot(page, f"backstage{sfx}")
    page.keyboard.press("Escape")

    # Cinemeta drops the series half of a search: say so instead of quietly showing only movies
    page.goto(BASE + "/#/search?q=pierre")
    expect(page.locator(".grid .show")).to_have_count(1)
    expect(page.locator(".half-missing")).to_contain_text("didn't send the series")
    # and an exact title goes to the top
    page.goto(BASE + "/#/search?q=breaking%20nap")
    expect(page.locator(".grid .show-title").first).to_have_text("Breaking Nap")

    # Pierre judges spicy searches (and still searches)
    page.goto(BASE + "/#/search?q=hentai")
    expect(page.locator(".judge .bubble")).to_have_text("I know what kind of man you are.")
    shot(page, f"judged{sfx}")
    page.goto(BASE + "/#/search?q=nap")
    expect(page.locator(".grid .show")).to_have_count(5)
    expect(page.locator(".judge")).to_have_count(0)

    # no internet: blame the internet, not the worker, and retry by itself when it's back
    page.goto(BASE + "/")
    ctx.set_offline(True)
    page.fill("#hero-q", "nap")
    page.press("#hero-q", "Enter")
    expect(page.locator(".problem h2")).to_have_text("Bro, your internet might be shit", timeout=15000)
    shot(page, f"offline{sfx}")
    ctx.set_offline(False)
    expect(page.locator(".grid .show")).to_have_count(5, timeout=15000)
    browser.close()


def run_mobile(p):
    browser = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    page = ctx.new_page()
    watch_errors(page)

    def no_sideways():
        width = page.evaluate("() => document.documentElement.scrollWidth")
        assert width <= 390, f"horizontal scroll on mobile at {page.url}: {width}px"

    page.goto(BASE + "/")
    expect(page.locator(".hero .bubble")).to_contain_text("Bonjour")
    page.wait_for_function("() => document.querySelectorAll('[data-popular] .show').length === 5")
    shot(page, "m-home")
    no_sideways()
    page.goto(BASE + "/#/title/series/tt0000201")
    expect(page.locator(".ep-list li")).to_have_count(3)
    page.wait_for_function("() => [...document.querySelectorAll('.ep-thumb img')].every(i => i.complete)")
    shot(page, "m-series")
    no_sideways()
    page.goto(BASE + "/#/watch/series/tt0000202/1/2")
    playing(page, 0.5)
    shot(page, "m-watch")
    no_sideways()
    browser.close()


with sync_playwright() as p:
    run_desktop(p, "light")
    run_desktop(p, "dark")
    run_mobile(p)

# expected API failures (the no-server movie) show up as failed loads; the assertions above
# already check how the UI handles them
noise = [e for e in errors if "favicon" not in e and "Failed to load resource" not in e and "search=pierre.json" not in e]
if noise:
    print("\n".join(noise))
    sys.exit(1)
print("e2e ok")
