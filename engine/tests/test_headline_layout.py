"""Headline style: wide crop on black between a title bar and a caption bar,
its title card, and the Whisper cleanup that keeps its captions clean."""

import asyncio

import pytest

from clip_engine.config import CaptionStyle, LayoutStyle, get_available_layout_styles
from clip_engine.services.layout_analyzer import ClipLayoutPlan, LayoutType, ShotLayout
from clip_engine.services.layout_renderer import (
    HEADLINE_CROP_HEIGHT,
    caption_anchor,
    content_view,
    headline_box,
    shot_chain,
    title_y,
)
from clip_engine.services.local_whisper import clean_words
from clip_engine.services.rendering_service import HEADLINE_CAPTION_SCALE, RenderingService, RenderRequest

SRC_W, SRC_H, OUT_W, OUT_H = 1920, 1080, 1080, 1920

def headline_shot(**box) -> ShotLayout:
    return ShotLayout(0, 4000, LayoutType.SCREEN, source="headline", content_box=headline_box(SRC_W, SRC_H, **box))

def test_headline_is_offered_as_a_style():
    assert LayoutStyle.HEADLINE in LayoutStyle.ALL
    assert "headline" in [style["id"] for style in get_available_layout_styles()]

def test_default_crop_is_centered_near_square_and_skips_the_bottom_strip():
    box = headline_box(SRC_W, SRC_H)
    assert box.y == 0 and box.h == HEADLINE_CROP_HEIGHT
    assert box.cx == pytest.approx(0.5)
    assert (box.w * SRC_W) / (box.h * SRC_H) == pytest.approx(1.03)

def test_crop_can_be_moved_and_widened_but_stays_inside_the_frame():
    assert headline_box(SRC_W, SRC_H, center_x=0.52, width=0.625).w == 0.625
    edge = headline_box(SRC_W, SRC_H, center_x=0.95, width=0.6)
    assert edge.x + edge.w == pytest.approx(1.0)
    assert headline_box(SRC_W, SRC_H, width=3.0).w == 1.0

def test_scene_sits_on_black_with_bars_for_the_title_and_captions():
    shot = headline_shot()
    chain = shot_chain(0, shot, SRC_W, SRC_H, OUT_W, OUT_H)
    (_, _, _, _), (dx, dy, fw, fh) = content_view(shot, SRC_W, SRC_H, OUT_W, OUT_H)
    assert f"pad={OUT_W}:{OUT_H}:{dx}:{dy}:black" in chain and "gblur" not in chain
    assert fw == OUT_W and 400 < dy < 480

    alignment, y = caption_anchor(shot, SRC_W, SRC_H, OUT_W, OUT_H)
    assert alignment == 5 and y == dy + fh + (OUT_H - dy - fh) // 2
    top = title_y(shot, SRC_W, SRC_H, OUT_W, OUT_H, 250)
    assert 0 < top and top + 250 < dy

def test_render_uses_the_headline_crop_without_layout_analysis(monkeypatch, tmp_path):
    monkeypatch.setattr(RenderingService, "_verify_ffmpeg", lambda self: None)
    service = RenderingService()
    plans = []

    async def dims(_path):
        return SRC_W, SRC_H

    async def analyze(*_args, **_kwargs):
        raise AssertionError("the Headline style needs no layout analysis")

    async def render_edit(request, plan, time_map, *args):
        plans.append(plan)
        with open(request.output_path, "wb") as f:
            f.write(b"\0" * 1024)

    monkeypatch.setattr(service, "_get_video_dimensions", dims)
    monkeypatch.setattr(service.layout_analyzer, "analyze", analyze)
    monkeypatch.setattr(service, "_render_edit", render_edit)
    request = RenderRequest("src.mp4", str(tmp_path / "clip.mp4"), 0, 10000, SRC_W, SRC_H,
                            layout_style=LayoutStyle.HEADLINE, headline_crop=(0.52, 0.625))
    asyncio.run(service.render_clip(request))
    shot = plans[0].shots[0]
    assert shot.source == "headline" and shot.content_box.w == 0.625

def test_headline_title_spans_the_frame_and_shrinks_long_titles(tmp_path):
    service = RenderingService.__new__(RenderingService)
    service._font_path = service._resolve_font()
    short = service._build_headline_title("Speed was so sure it was Hawaii", 1080, str(tmp_path / "a.png"), ["Hawaii"])
    long = service._build_headline_title("Speed absolutely could not believe what came out of the suitcase today",
                                         1080, str(tmp_path / "b.png"), [])
    assert short["width"] == long["width"] == 1080
    assert 0 < short["height"] < 300 and 0 < long["height"] < 300
    assert service._build_headline_title("   ", 1080, str(tmp_path / "c.png"), []) is None

def test_headline_overlay_replaces_the_title_card(tmp_path):
    service = RenderingService.__new__(RenderingService)
    service._font_path = service._resolve_font()
    calls = []
    service._build_title_card = lambda *a, **k: calls.append("card")
    service._build_headline_title = lambda *a, **k: calls.append("headline") or {"width": 1080, "height": 200}
    plan = ClipLayoutPlan([headline_shot()], SRC_W, SRC_H)
    request = RenderRequest("src.mp4", str(tmp_path / "clip.mp4"), 0, 4000, SRC_W, SRC_H,
                            title_text="Speed has no idea where this is", layout_style=LayoutStyle.HEADLINE)
    service._overlays(request, plan, OUT_W, OUT_H, False)
    service._overlays(request, plan, 1920, 1080, True)
    assert calls == ["headline", "card"]

def test_headline_captions_are_scaled_up():
    style = CaptionStyle()
    scaled = RenderingService._scaled_caption_style(style, HEADLINE_CAPTION_SCALE)
    assert scaled.font_size == round(style.font_size * HEADLINE_CAPTION_SCALE)
    assert style.font_size == CaptionStyle().font_size

def word(text, start, end=None):
    return {"word": text, "start": start, "end": start + 0.3 if end is None else end}

def test_whisper_cleanup_drops_trailing_ghost_words_and_loops():
    words = [word("Hawaii.", t) for t in range(5)] + [word("No,", 5 + t * 0.1) for t in range(17)]
    words += [word("Who", 9, 9), word("lives", 9, 9)]
    cleaned = clean_words(words)
    assert [w["word"] for w in cleaned] == ["Hawaii."] * 5 + ["No,"] * 2

def test_whisper_cleanup_keeps_normal_speech():
    words = [word("Hold", 0), word("it,", 0.3), word("hold", 0.6), word("it.", 0.9)]
    assert clean_words(words) == words
