"""Hook-sentence title cards and campaign watermarks."""

from PIL import Image

from clip_engine.services.rendering_service import (
    TITLE_CARD_MAX_LINES,
    TITLE_CARD_MAX_WIDTH,
    RenderingService,
    RenderRequest,
)

def _service():
    service = RenderingService.__new__(RenderingService)
    service._font_path = service._resolve_font()
    return service

def test_hook_sentence_wraps_without_dropping_words(tmp_path):
    service = _service()
    hook = "Adin Ross was opening his mail but had to LEAVE HIS ROOM after he heard this.."
    card = service._build_title_card(hook, 1080, 0, str(tmp_path / "hook.png"))
    assert card and card["width"] <= 1080 * TITLE_CARD_MAX_WIDTH + 1
    from PIL import ImageFont
    font = ImageFont.truetype(service._font_path, 42)
    lines = RenderingService._wrap_words(hook.split(), font, 1080 * TITLE_CARD_MAX_WIDTH - 56)
    assert " ".join(lines) == hook and len(lines) <= TITLE_CARD_MAX_LINES

def test_wrap_puts_a_long_word_on_its_own_line():
    from PIL import ImageFont
    font = ImageFont.truetype(_service()._font_path, 42)
    assert RenderingService._wrap_words(["a", "W" * 40, "b"], font, 200) == ["a", "W" * 40, "b"]

def _request(tmp_path, watermark):
    return RenderRequest(
        video_path="in.mp4", output_path=str(tmp_path / "clip.mp4"), start_time_ms=0, end_time_ms=1000,
        source_width=1920, source_height=1080, watermark_path=watermark,
    )

def test_watermark_is_trimmed_and_scaled(tmp_path):
    source = Image.new("RGBA", (400, 400), (0, 0, 0, 0))
    source.paste((255, 255, 255, 255), (50, 180, 350, 220))
    path = tmp_path / "mark.png"
    source.save(path)
    result = RenderingService._watermark_overlay_image(_request(tmp_path, str(path)), 1080, False)
    assert result
    out_path, width, height = result
    assert (width, height) == (540, 72)
    assert Image.open(out_path).size == (540, 72)

def test_missing_or_blank_watermark_is_skipped(tmp_path):
    assert RenderingService._watermark_overlay_image(_request(tmp_path, None), 1080, False) is None
    assert RenderingService._watermark_overlay_image(_request(tmp_path, str(tmp_path / "nope.png")), 1080, False) is None
    blank = tmp_path / "blank.png"
    Image.new("RGBA", (10, 10), (0, 0, 0, 0)).save(blank)
    assert RenderingService._watermark_overlay_image(_request(tmp_path, str(blank)), 1080, False) is None
