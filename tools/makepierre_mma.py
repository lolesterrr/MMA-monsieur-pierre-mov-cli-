#!/usr/bin/env python3
"""Monsieur Pierre's sprite sheet for MMA.

Every animation from MPA's makepierre_mpa.py (same 32x32 frames, palette and outline pass),
plus two for the cinema:

    clap     snaps a clapperboard shut while a stream is being found
    ticket   holds up a ticket for the title page

Writes (from the repo root):
    web/assets/pierre/pierre-mma.png and .json, docs/pierre-mma-preview.png,
    web/favicon.png, web/apple-touch-icon.png, web/og-image.png

    python3 tools/makepierre_mma.py      (needs Pillow)
"""
import json
import math
import os
import sys

from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import makepierre_mpa as base  # noqa: E402
from makepierre import Frame, ell, rect  # noqa: E402
from makepierre_mpa import Scene, cat, arm, paw, marks, sparkle, rot, union, cap  # noqa: E402


# ---------- props ----------

def slate(dy=0):
    """The board of a clapperboard, bottom right, with chalk lines."""
    f = Frame().add(rect(18, 21 + dy, 30, 30 + dy), "k")
    for yy in (23, 25, 27):
        f.px([(xx, yy + dy) for xx in range(20, 29 if yy != 25 else 26)], "q")
    return f


def clapper(angle=0, dy=0):
    """The striped stick on top, hinged at its left end. angle opens it (degrees, counterclockwise)."""
    hx, hy = 18.0, 20.5 + dy
    bar = rect(18, 17 + dy, 30, 20 + dy)
    stripes = lambda x, y: bar(x, y) and ((x - y) // 3) % 2 == 0
    f = Frame()
    f.add(rot(bar, hx, hy, -angle) if angle else bar, "w")
    f.paint(rot(stripes, hx, hy, -angle) if angle else stripes, "k")
    return f


def ticket(x, y, tilt=0):
    """A cinema ticket, top left corner at (x, y): gold, notched, with a red stub line."""
    w, h = 10, 6
    body = rect(x, y, x + w, y + h)
    notch = union(ell(x + .5, y + h / 2 + .5, 1.2, 1.2), ell(x + w + .5, y + h / 2 + .5, 1.2, 1.2))
    shape = lambda xx, yy: body(xx, yy) and not notch(xx, yy)
    stub = lambda xx, yy: shape(xx, yy) and xx == x + 3 and (yy % 2 == 0)
    star = lambda xx, yy: shape(xx, yy) and (xx, yy) in {(x + 6, y + 2), (x + 5, y + 3), (x + 6, y + 3), (x + 7, y + 3), (x + 6, y + 4)}
    cx, cy = x + w / 2, y + h / 2
    t = (lambda s: rot(s, cx, cy, tilt)) if tilt else (lambda s: s)
    return Frame().add(t(shape), "Y").paint(t(stub), "r").paint(t(star), "r")


# ---------- animations ----------

def anim_clap():
    body = lambda **kw: cat(tail_side="left", **kw).shift(-4, 0)
    hold = lambda dy=0: arm(16.5, 21.5, 19.5, 26.5 + dy, w=1.8, paw=2.1)
    opened = Scene(body(look=(1, 0)), slate(), clapper(32), hold())
    half = Scene(body(look=(1, 0)), slate(), clapper(14), hold())
    shut = Scene(body(eyes="closed", mouth="o"), slate(1), clapper(0, 1), hold(1),
                 marks([(31, 15), (29, 13), (26, 13)]))
    after = Scene(body(eyes="happy"), slate(), clapper(0), hold(), sparkle(28, 12))
    return [(opened, 700), (half, 90), (shut, 160), (after, 700), (Scene(body(look=(1, 0)), slate(), clapper(0), hold()), 500)]


def anim_ticket():
    low = Scene(cat(look=(1, 1)), ticket(20, 22), paw(22, 25))
    up = lambda eyes="happy", tilt=-12, y=7, extra=None: Scene(cat(eyes=eyes, tail=1), arm(22.5, 21.5, 25.0, 14.5), ticket(19, y, tilt), extra)
    return [(low, 900), (up("open", -6), 180), (up(), 900), (up(tilt=-18, y=6, extra=sparkle(17, 4)), 500), (up("open", -6), 400)]


ANIMS = base.ANIMS + [("clap", anim_clap), ("ticket", anim_ticket)]


def main(root):
    base.ANIMS[:] = ANIMS
    frames, manifest = base.build()
    out_dir = os.path.join(root, "web", "assets", "pierre")
    os.makedirs(out_dir, exist_ok=True)
    os.makedirs(os.path.join(root, "docs"), exist_ok=True)
    cols = 8
    rows = math.ceil(len(frames) / cols)
    sheet = Image.new("RGBA", (cols * 32, rows * 32), (0, 0, 0, 0))
    for i, (_, img) in enumerate(frames):
        sheet.alpha_composite(img, ((i % cols) * 32, (i // cols) * 32))
    sheet.save(os.path.join(out_dir, "pierre-mma.png"), optimize=True)
    with open(os.path.join(out_dir, "pierre-mma.json"), "w") as fh:
        json.dump({"image": "pierre-mma.png", "size": 32, "cols": cols, "anims": manifest}, fh, indent=1)
        fh.write("\n")
    preview(root, frames, manifest)
    icons(root, frames, manifest)
    print(f"{len(frames)} frames, {len(manifest)} animations")


def preview(root, frames, manifest):
    """One row per animation, 4x, alternating light and dark rows."""
    scale, pad, label_w = 4, 6, 120
    longest = max(len(a["frames"]) for a in manifest.values())
    w = label_w + longest * (32 * scale + pad)
    h = len(manifest) * (32 * scale + pad) + pad
    prev = Image.new("RGBA", (w, h), (238, 240, 245, 255))
    draw = ImageDraw.Draw(prev)
    font = base.load_font("DejaVuSans-Bold.ttf", 15)
    for r, (name, a) in enumerate(manifest.items()):
        y = pad + r * (32 * scale + pad)
        draw.text((8, y + 56), name, fill=(30, 30, 36, 255), font=font)
        for c, i in enumerate(a["frames"]):
            x = label_w + c * (32 * scale + pad)
            bg = (205, 214, 228, 255) if r % 2 == 0 else (40, 44, 52, 255)
            prev.paste(Image.new("RGBA", (32 * scale, 32 * scale), bg), (x, y))
            prev.alpha_composite(frames[i][1].resize((32 * scale, 32 * scale), Image.NEAREST), (x, y))
    prev.save(os.path.join(root, "docs", "pierre-mma-preview.png"), optimize=True)


def icons(root, frames, manifest):
    """Favicon and touch icon like MPA's; a share card with Pierre and his clapperboard."""
    web = os.path.join(root, "web")
    beret_frame = frames[manifest["beret"]["frames"][0]][1]
    clap = frames[manifest["clap"]["frames"][3]][1]
    beret_frame.save(os.path.join(web, "favicon.png"))
    size = 180
    bg = base.gradient(size, size, [(28, 30, 60), (120, 40, 70), (230, 90, 70)])
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), 40, fill=255)
    icon = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    icon.paste(bg, (0, 0), mask)
    icon.alpha_composite(beret_frame.resize((160, 160), Image.NEAREST), (10, 14))
    icon.save(os.path.join(web, "apple-touch-icon.png"))
    W, H = 1200, 630
    card = base.gradient(W // 4, H // 4, [(18, 20, 44), (90, 30, 70), (200, 70, 70), (250, 170, 110)])
    card = card.resize((W, H), Image.BILINEAR)
    # film strip along the bottom
    d = ImageDraw.Draw(card)
    d.rectangle((0, H - 70, W, H), fill=(14, 14, 18, 255))
    for x in range(10, W, 46):
        d.rectangle((x, H - 60, x + 24, H - 46), fill=(240, 236, 226, 255))
        d.rectangle((x, H - 24, x + 24, H - 10), fill=(240, 236, 226, 255))
    card.alpha_composite(clap.resize((448, 448), Image.NEAREST), (690, 90))
    d.text((96, 130), "MMA", fill=(255, 255, 255, 255), font=base.load_font("Poppins-Bold.ttf", 190))
    d.text((102, 360), "Monsieur Pierre's mov-cli", fill=(255, 255, 255, 235), font=base.load_font("Poppins-Medium.ttf", 46))
    d.text((104, 432), "movies \u00b7 series \u00b7 no accounts", fill=(255, 255, 255, 190), font=base.load_font("Poppins-Regular.ttf", 34))
    card.convert("RGB").save(os.path.join(web, "og-image.png"), optimize=True)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
