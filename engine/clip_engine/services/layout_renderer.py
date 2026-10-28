"""
Layout Renderer - turns a ClipLayoutPlan into an FFmpeg filter graph.

Each shot is trimmed from the source and framed with its own layout, then the
shots are concatenated back into one 9:16 stream:

    talking_head  full-frame crop that pans with the speaker
    two_shot      each person in their own panel, stacked
    screen_cam    screen (zoomed on the active area) over the webcam
    screen        whole frame over a blurred copy of itself
    headline      a wide crop of the scene on black, between a title bar
                  and a caption bar (the Headline style)

Also provides per-shot positions for captions, the title card and the
channel banner so they never sit on top of a face or cut across a seam.

Everything here is pure string/number math so it can be unit tested without
FFmpeg.
"""

from bisect import bisect_left
from dataclasses import dataclass
from fractions import Fraction
from math import ceil
from typing import Optional

from clip_engine.services.layout_analyzer import Box, ClipLayoutPlan, LayoutType, ShotLayout
from clip_engine.services.video_speed import speed_audio_filter, validate_video_speed

TWO_SHOT_TOP_RATIO = 0.5
SCREEN_CAM_TOP_RATIO = 0.6
MAX_SCREEN_CAM_TOP_RATIO = 0.7
MAX_UPSCALE = 2.6
PERSON_CROP_FACE_MULT = 3.2
PERSON_FACE_Y = 0.40
AVOID_MARGIN = 0.15

def even(value: float) -> int:
    """Round down to an even integer (yuv420p needs even dimensions)."""
    return max(2, int(value) // 2 * 2)

def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))

def piecewise_expr(points: list[tuple[float, float]]) -> str:
    """Piecewise-linear FFmpeg expression of `t` through (t_sec, value) points."""
    if not points:
        return "0"
    points = sorted(points)
    expr = f"{points[-1][1]:.1f}"
    for (t0, v0), (t1, v1) in reversed(list(zip(points, points[1:]))):
        span = max(t1 - t0, 1e-3)
        expr = f"if(lt(t,{t1:.3f}),{v0:.1f}+({v1 - v0:.1f})*(t-{t0:.3f})/{span:.3f},{expr})"
    return expr

def step_expr(boundaries: list[float], values: list[float]) -> str:
    """Step-function expression: values[i] until boundaries[i], last value after."""
    expr = f"{values[-1]:.0f}"
    for boundary, value in reversed(list(zip(boundaries, values[:-1]))):
        expr = f"if(lt(t,{boundary:.3f}),{value:.0f},{expr})"
    return expr

def _fill_crop_path(
    shot: ShotLayout, src_w: int, src_h: int, out_w: int, out_h: int,
) -> tuple[int, int, list[tuple[float, float]], list[tuple[float, float]]]:
    """Crop size and its (t_sec, x) / (t_sec, y) keyframes in window time.

    A talking head inside a padded inset (`crop_bounds`) is cropped from the
    inset only, with its edges rounded inward so no padding enters the frame.
    """
    target = out_w / out_h
    left, top, right, bottom = 0, 0, src_w, src_h
    if shot.crop_bounds is not None:
        bounds = shot.crop_bounds.clamp()
        left, top = min(src_w - 2, ceil(bounds.x * src_w / 2) * 2), min(src_h - 2, ceil(bounds.y * src_h / 2) * 2)
        right = max(left + 2, int((bounds.x + bounds.w) * src_w) // 2 * 2)
        bottom = max(top + 2, int((bounds.y + bounds.h) * src_h) // 2 * 2)
    width, height = right - left, bottom - top
    if width / height > target:
        crop_h = even(height)
        crop_w = even(height * target)
    else:
        crop_w = even(width)
        crop_h = even(width / target)

    path = shot.focus_path or [(0, 0.5, 0.5)]
    xs, ys = [], []
    for t_ms, cx, cy in path:
        t = (shot.start_ms + t_ms) / 1000
        xs.append((t, _clamp(cx * src_w - crop_w / 2, left, right - crop_w)))
        ys.append((t, _clamp(cy * src_h - crop_h * PERSON_FACE_Y, top, bottom - crop_h)))
    return crop_w, crop_h, xs, ys

def fill_crop(shot: ShotLayout, src_w: int, src_h: int, out_w: int, out_h: int) -> tuple[int, int, str, str]:
    """9:16 crop that follows the shot's focus path. Returns (w, h, x_expr, y_expr).

    Expressions are in window time (`t` before the piece's timestamps are
    reset), so the path is offset by the shot's start.
    """
    crop_w, crop_h, xs, ys = _fill_crop_path(shot, src_w, src_h, out_w, out_h)
    x_expr = piecewise_expr(xs) if crop_w < src_w else "0"
    y_expr = piecewise_expr(ys) if crop_h < src_h else "0"
    return crop_w, crop_h, x_expr, y_expr

def path_value_at(points: list[tuple[float, float]], t: float) -> float:
    """Value of piecewise_expr(points) at time t (held flat past either end)."""
    points = sorted(points)
    if t <= points[0][0]:
        return points[0][1]
    for (t0, v0), (t1, v1) in zip(points, points[1:]):
        if t < t1:
            return v0 + (v1 - v0) * (t - t0) / max(t1 - t0, 1e-3)
    return points[-1][1]

def _fit_rect(cx: float, cy: float, w: float, h: float, bounds: tuple[float, float, float, float]) -> tuple[int, int, int, int]:
    """Place a w x h rect centered on (cx, cy), shifted to stay inside bounds (x, y, w, h)."""
    bx, by, bw, bh = bounds
    w, h = min(w, bw), min(h, bh)
    x = _clamp(cx - w / 2, bx, bx + bw - w)
    y = _clamp(cy - h / 2, by, by + bh - h)
    return even(w), even(h), max(0, int(x) // 2 * 2), max(0, int(y) // 2 * 2)

def person_crop(
    face: Box,
    src_w: int,
    src_h: int,
    panel_w: int,
    panel_h: int,
    x_bounds: Optional[tuple[float, float]] = None,
) -> tuple[int, int, int, int]:
    """Head-and-shoulders crop for one person, at the panel's aspect ratio.

    `x_bounds` (source px) keeps the crop on this person's side of a
    two-shot so the neighbour doesn't bleed in. Near a frame edge the crop
    tightens (within MAX_UPSCALE) instead of pushing the face off-center.
    """
    aspect = panel_w / panel_h
    min_h = panel_h / MAX_UPSCALE
    x0, x1 = x_bounds or (0, src_w)
    fx, fy = face.cx * src_w, face.cy * src_h

    crop_h = _clamp(face.h * src_h * PERSON_CROP_FACE_MULT, min_h, src_h)
    crop_h = min(crop_h, max((x1 - x0) / aspect, min_h))
    crop_h = min(crop_h, max((src_h - fy) / (1 - 0.58), min_h), max(fy / 0.25, min_h))
    crop_w = crop_h * aspect

    bounds = (x0, 0, x1 - x0, src_h) if crop_w <= x1 - x0 else (0, 0, src_w, src_h)
    cy = fy + crop_h * (0.5 - PERSON_FACE_Y)
    return _fit_rect(fx, cy, crop_w, crop_h, bounds)

def cam_crop(cam: Box, face: Optional[Box], src_w: int, src_h: int, panel_w: int, panel_h: int) -> tuple[int, int, int, int]:
    """Crop inside the webcam overlay at the panel's aspect, centered on the face.

    The crop always fills the webcam panel edge to edge, so a small webcam is
    enlarged past MAX_UPSCALE rather than shown smaller over a blurred fill.
    stacked_panel_heights already gives a small webcam a shorter panel, which
    limits that enlargement.
    """
    aspect = panel_w / panel_h
    cam = cam.clamp()
    left, top = ceil(cam.x * src_w / 2) * 2, ceil(cam.y * src_h / 2) * 2
    right = int((cam.x + cam.w) * src_w) // 2 * 2
    bottom = int((cam.y + cam.h) * src_h) // 2 * 2
    bounds = (left, top, max(2, right - left), max(2, bottom - top))
    bw, bh = bounds[2], bounds[3]
    if bw / bh > aspect:
        crop_h, crop_w = bh, bh * aspect
    else:
        crop_w, crop_h = bw, bw / aspect
    fx = (face.cx if face else cam.cx) * src_w
    fy = (face.cy if face else cam.cy) * src_h
    if face and cam.contains(face.cx, face.cy):
        centered_w = 2 * min(fx - left, right - fx)
        tight_w = max(centered_w, panel_w / MAX_UPSCALE)
        tight_h = tight_w / aspect
        if (centered_w < crop_w * .9 and tight_w < crop_w and tight_w >= face.w * src_w * 1.5
                and tight_h >= face.h * src_h * 1.8):
            crop_w, crop_h = tight_w, tight_h
    return _fit_rect(fx, fy + crop_h * (0.5 - PERSON_FACE_Y), crop_w, crop_h, bounds)

def stacked_panel_heights(shot: ShotLayout, src_h: int, out_h: int) -> tuple[int, int]:
    """Return even top/bottom heights for one stacked shot.

    A webcam's source height limits how tall its destination can be before it
    must be enlarged beyond MAX_UPSCALE. Keep at least 30% for the webcam;
    overlays smaller still fill that panel anyway, enlarged further.
    The same seam is used by the graph and caption placement.
    """
    if shot.layout != LayoutType.SCREEN_CAM or shot.cam_box is None:
        top_h = even(out_h * TWO_SHOT_TOP_RATIO)
    else:
        preferred_bottom = out_h - even(out_h * SCREEN_CAM_TOP_RATIO)
        minimum_bottom = out_h - even(out_h * MAX_SCREEN_CAM_TOP_RATIO)
        webcam_budget = even(shot.cam_box.h * src_h * MAX_UPSCALE)
        bottom_h = max(minimum_bottom, min(preferred_bottom, webcam_budget))
        top_h = out_h - bottom_h
    return top_h, out_h - top_h

def screen_crop(
    screen: Optional[Box],
    focus: Optional[Box],
    src_w: int,
    src_h: int,
    panel_w: int,
    panel_h: int,
    avoid: Optional[Box] = None,
) -> tuple[int, int, int, int]:
    """Crop of the screen at the panel's aspect, covering the focus area if known.

    `avoid` (the webcam overlay) is slid out of the crop horizontally when the
    screen has room, so the webcam doesn't show twice.
    """
    aspect = panel_w / panel_h
    screen = screen or Box(0, 0, 1, 1)
    bounds = (screen.x * src_w, screen.y * src_h, screen.w * src_w, screen.h * src_h)
    bw, bh = bounds[2], bounds[3]

    if bw / bh > aspect:
        max_h, max_w = bh, bh * aspect
    else:
        max_w, max_h = bw, bw / aspect
    crop_w, crop_h = max_w, max_h
    cx, cy = bounds[0] + bw / 2, bounds[1] + bh / 2

    if focus is not None:
        fw, fh = focus.w * src_w * 1.1, focus.h * src_h * 1.1
        need_w = max(fw, fh * aspect)
        min_w = max(panel_w / MAX_UPSCALE, 0.6 * max_h * aspect)
        crop_w = _clamp(need_w, min_w, max_w)
        crop_h = crop_w / aspect
        cx, cy = focus.cx * src_w, focus.cy * src_h
    w, h, x, y = _fit_rect(cx, cy, crop_w, crop_h, bounds)

    if avoid is not None:
        mx, my = avoid.w * AVOID_MARGIN * src_w, avoid.h * AVOID_MARGIN * src_h
        ax0, ax1 = avoid.x * src_w - mx, (avoid.x + avoid.w) * src_w + mx
        ay0, ay1 = avoid.y * src_h - my, (avoid.y + avoid.h) * src_h + my
        if x < ax1 and x + w > ax0 and y < ay1 and y + h > ay0:
            on_right = avoid.cx * src_w > x + w / 2
            if on_right and ax0 - w >= bounds[0]:
                x = even(ax0 - w)
            elif not on_right and ax1 + w <= bounds[0] + bw:
                x = even(ax1)
            else:
                room = (ax0 - bounds[0]) if on_right else (bounds[0] + bw - ax1)
                if room >= panel_w / MAX_UPSCALE:
                    new_w = even(room)
                    new_h = even(new_w / aspect)
                    x = even(bounds[0]) if on_right else even(ax1)
                    y = even(_clamp(y + (h - new_h) / 2, bounds[1], bounds[1] + bh - new_h))
                    w, h = new_w, new_h
        if x < ax1 and x + w > ax0 and y < ay1 and y + h > ay0:
            min_h = panel_h / MAX_UPSCALE
            choices = []
            for top, bottom in ((bounds[1], ay0), (ay1, bounds[1] + bh)):
                available_h = bottom - top
                candidate_h = min(h, available_h, bw / aspect)
                if candidate_h < min_h:
                    continue
                candidate_w = candidate_h * aspect
                candidate_x = _clamp(cx - candidate_w / 2, bounds[0], bounds[0] + bw - candidate_w)
                candidate_y = _clamp(cy - candidate_h / 2, top, bottom - candidate_h)
                choices.append((candidate_h, (even(candidate_w), even(candidate_h), even(candidate_x), even(candidate_y))))
            if choices:
                _, (w, h, x, y) = max(choices, key=lambda choice: choice[0])
    return w, h, x, y

def screen_view(shot: ShotLayout, src_w: int, src_h: int, panel_w: int, panel_h: int):
    """Screen panel geometry shared by rendering and inspection.

    The screen fills its whole panel (main's behavior for screen + webcam
    shots): a panel-aspect crop that covers the focus area, so the panel
    destination is always the full panel.
    """
    rect = screen_crop(shot.screen_box, shot.screen_focus, src_w, src_h, panel_w, panel_h, shot.cam_box)
    return rect, (0, 0, panel_w, panel_h)

HEADLINE_CROP_ASPECT = 1.03
HEADLINE_CROP_HEIGHT = 0.955

def headline_box(src_w: int, src_h: int, center_x: float = 0.5, width: Optional[float] = None) -> Box:
    """The Headline crop as a source-relative box, centered on `center_x`.

    `width` (a fraction of the source width) widens the crop for a zoomed-in
    camera; by default it is HEADLINE_CROP_ASPECT times the crop's height.
    """
    if width is None:
        width = src_h * HEADLINE_CROP_HEIGHT * HEADLINE_CROP_ASPECT / src_w
    width = _clamp(width, 0.1, 1.0)
    return Box(_clamp(center_x - width / 2, 0.0, 1.0 - width), 0.0, width, HEADLINE_CROP_HEIGHT)

def _crop(rect: tuple[int, int, int, int]) -> str:
    w, h, x, y = rect
    return f"crop={w}:{h}:{x}:{y}"

def letterbox_geometry(src_w: int, src_h: int, out_w: int, out_h: int) -> tuple[int, int]:
    """(scaled video height, y offset) of the fit layout."""
    scaled_h = min(out_h, even(out_w * src_h / src_w + 1))
    return scaled_h, (out_h - scaled_h) // 2

def content_view(
    shot: ShotLayout, src_w: int, src_h: int, out_w: int, out_h: int,
) -> tuple[tuple[int, int, int, int], tuple[int, int, int, int]]:
    """The complete inset and its fitted destination, shared with diagnostics."""
    box = shot.content_box.clamp()
    x, y = max(0, int(box.x * src_w) // 2 * 2), max(0, int(box.y * src_h) // 2 * 2)
    w, h = min(even(box.w * src_w), src_w - x), min(even(box.h * src_h), src_h - y)
    scale = min(out_w / w, out_h / h)
    fw, fh = min(out_w, even(w * scale)), min(out_h, even(h * scale))
    return (x, y, w, h), ((out_w - fw) // 2, (out_h - fh) // 2, fw, fh)

def foreground_geometry(shot: ShotLayout, src_w: int, src_h: int, out_w: int, out_h: int) -> tuple[int, int]:
    if shot.content_box is not None:
        _, (_, y, _, h) = content_view(shot, src_w, src_h, out_w, out_h)
        return h, y
    return letterbox_geometry(src_w, src_h, out_w, out_h)

def shot_chain(
    i: int, shot: ShotLayout, src_w: int, src_h: int, out_w: int, out_h: int, landscape: bool = False,
    fps: str = '30', start_frame: int = 0,
) -> str:
    """Filters from [t{i}] (a trimmed piece) to [v{i}] (framed, out_w x out_h)."""
    scale = "flags=lanczos"
    if shot.manual_crops:
        views = manual_views(shot, src_w, src_h, out_w, out_h)
        n = len(views)
        parts = [f"[t{i}]split={n}" + ''.join(f"[mc{i}_{j}]" for j in range(n))] if n > 1 else []
        for j, ((x, y, w, h), (_, _, pw, ph)) in enumerate(views):
            source = f"mc{i}_{j}" if n > 1 else f"t{i}"
            target = f"mp{i}_{j}" if n > 1 else f"v{i}"
            if shot.manual_transition_ms:
                origin, dest = shot.manual_from_crops[j], shot.manual_crops[j]
                bx = max(0, int(min(origin[0], dest[0]) * src_w) // 2 * 2)
                by = max(0, int(min(origin[1], dest[1]) * src_h) // 2 * 2)
                bw = max(2, min(src_w - bx, (ceil(max(origin[0] + origin[2], dest[0] + dest[2]) * src_w) - bx + 1) // 2 * 2))
                bh = max(2, min(src_h - by, (ceil(max(origin[1] + origin[3], dest[1] + dest[3]) * src_h) - by + 1) // 2 * 2))
                def local(c):
                    return [(c[0] * src_w - bx) / bw, (c[1] * src_h - by) / bh, c[2] * src_w / bw, c[3] * src_h / bh]
                a, b = local(origin), local(dest)
                qw = max(2, min(pw, even(max(a[2], b[2]) * bw), even(8192 * min(a[2], b[2]))))
                qh = max(2, min(ph, even(max(a[3], b[3]) * bh), even(8192 * min(a[3], b[3]))))
                p = f"clip((t*1000-({shot.manual_transition_start_ms}))/{shot.manual_transition_ms},0,1)"
                ease = f"({p}*{p}*(3-2*{p}))"
                x0, y0, cw, ch = (f"({a[k]:.10f}+({b[k] - a[k]:.10f})*{ease})" for k in range(4))
                transform = (f"crop={bw}:{bh}:{bx}:{by},"
                    f"scale=w='round({qw}/{cw})':h='round({qh}/{ch})':eval=frame:{scale},"
                    f"crop=w={qw}:h={qh}:x='{x0}*round({qw}/{cw})':y='{y0}*round({qh}/{ch})':exact=1")
            else:
                transform = f"crop={w}:{h}:{x}:{y}"
            parts.append(f"[{source}]{transform},scale={pw}:{ph}:{scale},setsar=1[{target}]")
        if n > 1:
            parts.append(''.join(f"[mp{i}_{j}]" for j in range(n)) + f"vstack=inputs={n}[v{i}]")
        return ';'.join(parts)
    if landscape:
        if abs(src_w / src_h - out_w / out_h) < 0.01 * out_w / out_h:
            return f"[t{i}]scale={out_w}:{out_h}:{scale},setsar=1[v{i}]"
        bg_w, bg_h = even(out_w // 4), even(out_h // 4)
        return (
            f"[t{i}]split=2[lb{i}][lf{i}];"
            f"[lb{i}]scale={bg_w}:{bg_h}:force_original_aspect_ratio=increase,crop={bg_w}:{bg_h},"
            f"gblur=sigma=10,lutyuv=y=val-20,scale={out_w}:{out_h}[lbg{i}];"
            f"[lf{i}]scale={out_w}:{out_h}:force_original_aspect_ratio=decrease:{scale}[lfg{i}];"
            f"[lbg{i}][lfg{i}]overlay=(W-w)/2:(H-h)/2,setsar=1[v{i}]"
        )
    if shot.content_box is not None and shot.source == "headline":
        (x, y, w, h), (dx, dy, fw, fh) = content_view(shot, src_w, src_h, out_w, out_h)
        return (
            f"[t{i}]crop={w}:{h}:{x}:{y},scale={fw}:{fh}:{scale},"
            f"pad={out_w}:{out_h}:{dx}:{dy}:black,setsar=1[v{i}]"
        )
    if shot.content_box is not None:
        (x, y, w, h), (dx, dy, fw, fh) = content_view(shot, src_w, src_h, out_w, out_h)
        bg_w, bg_h = even(out_w // 4), even(out_h // 4)
        return (
            f"[t{i}]crop={w}:{h}:{x}:{y},split=2[ib{i}][if{i}];"
            f"[ib{i}]scale={bg_w}:{bg_h}:force_original_aspect_ratio=increase,crop={bg_w}:{bg_h},"
            f"gblur=sigma=10,lutyuv=y=val-20,scale={out_w}:{out_h}[ibg{i}];"
            f"[if{i}]scale={fw}:{fh}:{scale}[ifg{i}];"
            f"[ibg{i}][ifg{i}]overlay={dx}:{dy},setsar=1[v{i}]"
        )
    if shot.layout == LayoutType.TALKING_HEAD:
        w, h, x_expr, y_expr = fill_crop(shot, src_w, src_h, out_w, out_h)
        return (
            f"[t{i}]crop=w={w}:h={h}:x='{x_expr}':y='{y_expr}',"
            f"scale={out_w}:{out_h}:{scale},setsar=1[v{i}]"
        )

    top_h, bottom_h = stacked_panel_heights(shot, src_h, out_h)
    if shot.layout == LayoutType.TWO_SHOT and len(shot.people) >= 2:
        left, right = shot.people[0], shot.people[1]
        mid = (left.cx + right.cx) / 2 * src_w
        return (
            f"[t{i}]split=2[pa{i}][pb{i}];"
            f"[pa{i}]{_crop(person_crop(left, src_w, src_h, out_w, top_h, (0, mid)))},"
            f"scale={out_w}:{top_h}:{scale}[top{i}];"
            f"[pb{i}]{_crop(person_crop(right, src_w, src_h, out_w, bottom_h, (mid, src_w)))},"
            f"scale={out_w}:{bottom_h}:{scale}[bot{i}];"
            f"[top{i}][bot{i}]vstack=inputs=2,setsar=1[v{i}]"
        )
    if shot.layout == LayoutType.SCREEN_CAM and shot.cam_box is not None:
        cam_rect = cam_crop(shot.cam_box, shot.cam_face, src_w, src_h, out_w, bottom_h)
        screen_rect, _ = screen_view(shot, src_w, src_h, out_w, top_h)
        return (
            f"[t{i}]split=2[sa{i}][sb{i}];"
            f"[sa{i}]{_crop(screen_rect)},"
            f"scale={out_w}:{top_h}:{scale}[top{i}];"
            f"[sb{i}]{_crop(cam_rect)},scale={out_w}:{bottom_h}:{scale}[bot{i}];"
            f"[top{i}][bot{i}]vstack=inputs=2,setsar=1[v{i}]"
        )

    scaled_h, overlay_y = letterbox_geometry(src_w, src_h, out_w, out_h)
    bg_w = min(src_w, even(src_h * out_w / out_h))
    bg_h = min(src_h, even(src_w * out_h / out_w)) if bg_w == src_w else src_h
    return (
        f"[t{i}]split=2[bi{i}][fi{i}];"
        f"[bi{i}]crop={bg_w}:{bg_h}:{(src_w - bg_w) // 2}:{(src_h - bg_h) // 2},"
        f"scale={out_w // 4}:{out_h // 4},gblur=sigma=10,lutyuv=y=val-20,"
        f"scale={out_w}:{out_h}[bg{i}];"
        f"[fi{i}]scale={out_w}:{scaled_h}:{scale}[fg{i}];"
        f"[bg{i}][fg{i}]overlay=0:{overlay_y},setsar=1[v{i}]"
    )

def timeline_pieces(plan: ClipLayoutPlan, keeps: Optional[list[tuple[int, int]]] = None) -> list[tuple[int, int, int]]:
    """(shot index, start_ms, end_ms) for every kept piece of every shot, in order."""
    window_end = plan.shots[-1].end_ms
    keeps = [(0, window_end)] if keeps is None else keeps
    pieces = []
    for i, shot in enumerate(plan.shots):
        for k_start, k_end in keeps:
            s_, e_ = max(shot.start_ms, k_start), min(shot.end_ms, k_end)
            if e_ > s_:
                pieces.append((i, s_, e_))
    return pieces

AUDIO_FORMAT = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"
AUDIO_SYNC = "aresample=48000:async=1:first_pts=0:min_hard_comp=0.001"
LOUDNESS_TARGET = "I=-14:TP=-1.5:LRA=11"
FINITE_AUDIO = "aeval='if(isnan(val(ch))+isinf(val(ch)),0,val(ch))':c=same"
LOUDNESS_FILTER = f"loudnorm={LOUDNESS_TARGET},aresample=48000,{FINITE_AUDIO},{AUDIO_FORMAT}"

def measured_loudness_filter(measured: dict) -> Optional[str]:
    """Second pass of two-pass loudnorm: a linear gain from a first-pass
    measurement (FFmpeg's print_format=json output). Unlike single-pass
    dynamic mode it can't pump over a long clip. None if the measurement is
    unusable (e.g. digital silence)."""
    keys = ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset")
    try:
        values = {k: float(measured[k]) for k in keys}
    except (KeyError, TypeError, ValueError):
        return None
    if any(v != v or abs(v) == float("inf") for v in values.values()) or values["input_i"] < -70:
        return None
    return (
        f"loudnorm={LOUDNESS_TARGET}"
        f":measured_I={values['input_i']:.2f}:measured_TP={values['input_tp']:.2f}"
        f":measured_LRA={values['input_lra']:.2f}:measured_thresh={values['input_thresh']:.2f}"
        f":offset={values['target_offset']:.2f}:linear=true,"
        f"aresample=48000,{FINITE_AUDIO},{AUDIO_FORMAT}"
    )
EDGE_FADE_S = 0.012
START_FADE_S = 0.03
END_FADE_S = 0.08

def _audio_fades(duration_s: float, first: bool, last: bool) -> str:
    fade_in = START_FADE_S if first else EDGE_FADE_S
    fade_out = END_FADE_S if last else EDGE_FADE_S
    if duration_s <= fade_in + fade_out:
        return ""
    return (
        f",afade=t=in:st=0:d={fade_in}"
        f",afade=t=out:st={duration_s - fade_out:.3f}:d={fade_out}"
    )

def video_frame_pieces(plan: ClipLayoutPlan, keeps: Optional[list[tuple[int, int]]], fps: str) -> list[tuple[int, int, int]]:
    """Exact (shot index, source start frame, frame count) used by the renderer."""
    pieces = timeline_pieces(plan, keeps)
    if not pieces:
        raise ValueError("The edit contains no video")
    rate = Fraction(fps)
    if rate <= 0:
        raise ValueError("Frame rate must be positive")

    def frame_at(ms: int) -> int:
        return int(Fraction(str(ms)) / 1000 * rate + Fraction(1, 2))

    groups = []
    for piece in pieces:
        if not groups or groups[-1][-1][2] != piece[1]:
            groups.append([])
        groups[-1].append(piece)
    video_pieces = []
    elapsed_ms = frame_end = 0
    for group in groups:
        start, end = group[0][1], group[-1][2]
        start_frame = frame_at(start - elapsed_ms) + frame_end
        elapsed_ms += end - start
        next_frame = frame_at(elapsed_ms)
        source_end = start_frame + next_frame - frame_end
        cursor = start_frame
        for j, (i, _, boundary) in enumerate(group):
            until = source_end if j == len(group) - 1 else min(source_end, max(cursor, frame_at(boundary)))
            if until > cursor:
                video_pieces.append((i, cursor, until - cursor))
            cursor = until
        frame_end = next_frame
    if not video_pieces:
        raise ValueError("The edit is shorter than one video frame")
    return video_pieces

def build_layout_graph(
    plan: ClipLayoutPlan,
    out_w: int,
    out_h: int,
    keeps: Optional[list[tuple[int, int]]] = None,
    with_audio: bool = False,
    landscape: bool = False,
    fps: str = "30",
    loudness_filter: Optional[str] = None,
    video_speed: float = 1.0,
) -> str:
    """Filter graph from [0:v] (and [0:a]) to [base] (and [aout]).

    `fps` is the output frame rate (a number or rational like "30000/1001");
    `loudness_filter` replaces the default single-pass loudnorm.

    Video uses a single frame grid before trimming. Piece lengths are rounded
    on the cumulative output timeline, so rounding never accumulates at cuts.
    Audio uses the same window clock and exact keep intervals; framing changes
    must neither splice speech nor add concat's longest-stream padding.
    """
    validate_video_speed(video_speed)
    src_w, src_h = plan.source_width, plan.source_height
    window_end = plan.shots[-1].end_ms
    video_pieces = video_frame_pieces(plan, keeps, fps)
    n = len(video_pieces)
    parts: list[str] = [
        f"[0:v]fps={fps}:start_time=0:round=near,"
        f"tpad=stop_mode=clone:stop_duration={window_end / 1000:.3f}[clocked]"
    ]
    if n == 1:
        parts.append("[clocked]null[s0]")
    else:
        parts.append(f"[clocked]split={n}" + "".join(f"[s{k}]" for k in range(n)))
    for k, (i, start_frame, count) in enumerate(video_pieces):
        parts.append(f"[s{k}]trim=start_frame={start_frame}:end_frame={start_frame + count}[t{k}]")
        chain = shot_chain(k, plan.shots[i], src_w, src_h, out_w, out_h, landscape, fps, start_frame)
        parts.append(chain[: chain.rindex(f"[v{k}]")] + f"[c{k}]")
        parts.append(f"[c{k}]setpts=PTS-STARTPTS[v{k}]")

    inputs = "".join(f"[v{k}]" for k in range(n))
    parts.append(f"{inputs}concat=n={n}:v=1:a=0,settb=expr=1/({fps}),setpts=N,fps={fps}[base]")

    if with_audio:
        audio_keeps = [(0, window_end)] if keeps is None else keeps
        audio_n = len(audio_keeps)
        parts.append(f"anullsrc=r=48000:cl=stereo:d={window_end / 1000:.3f}[silence]")
        parts.append(f"[0:a:0]{AUDIO_FORMAT},{AUDIO_SYNC}[clocked_audio]")
        source_audio = (
            f"[silence][clocked_audio]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,"
            f"atrim=end={window_end / 1000:.3f}"
        )
        if audio_n == 1:
            parts.append(f"{source_audio}[as0]")
        else:
            parts.append(f"{source_audio},asplit={audio_n}" + "".join(f"[as{k}]" for k in range(audio_n)))
        for k, (start, end) in enumerate(audio_keeps):
            fades = _audio_fades((end - start) / 1000, k == 0, k == audio_n - 1)
            parts.append(
                f"[as{k}]atrim=start={start / 1000:.3f}:end={end / 1000:.3f},"
                f"asetpts=PTS-{start / 1000:.3f}/TB{fades}[a{k}]"
            )
        inputs = "".join(f"[a{k}]" for k in range(audio_n))
        parts.append(
            f"{inputs}concat=n={audio_n}:v=0:a=1,{loudness_filter or LOUDNESS_FILTER},"
            f"{speed_audio_filter(video_speed, sum(end - start for start, end in audio_keeps))}"
            "asettb=1/48000,asetpts=N[aout]"
        )
    return ";".join(parts)

FILL_CAPTION_Y = 1340
FILL_BANNER_Y = 1590
TOP_TITLE_Y = 110

def caption_anchor(shot: ShotLayout, src_w: int, src_h: int, out_w: int, out_h: int) -> tuple[int, int]:
    """(ASS alignment, y) for captions during this shot."""
    if shot.layout == LayoutType.TWO_SHOT or (shot.layout == LayoutType.SCREEN_CAM and shot.cam_box is not None):
        return 5, stacked_panel_heights(shot, src_h, out_h)[0]
    if shot.layout in (LayoutType.SCREEN, LayoutType.SCREEN_CAM):
        scaled_h, overlay_y = foreground_geometry(shot, src_w, src_h, out_w, out_h)
        bar = out_h - (overlay_y + scaled_h)
        if shot.source == "headline":
            return 5, overlay_y + scaled_h + bar // 2
        if bar >= 200:
            return 2, out_h - int(bar * 0.55)
    return 5, int(out_h * FILL_CAPTION_Y / 1920)

def title_y(shot: ShotLayout, src_w: int, src_h: int, out_w: int, out_h: int, title_h: int) -> int:
    if shot.layout == LayoutType.SCREEN:
        _, overlay_y = foreground_geometry(shot, src_w, src_h, out_w, out_h)
        if overlay_y > title_h + 20:
            return max(10, overlay_y // 2 - title_h // 2)
    return int(out_h * TOP_TITLE_Y / 1920)

def banner_y(shot: ShotLayout, src_w: int, src_h: int, out_w: int, out_h: int) -> int:
    if shot.layout == LayoutType.SCREEN:
        scaled_h, overlay_y = foreground_geometry(shot, src_w, src_h, out_w, out_h)
        if out_h - (overlay_y + scaled_h) >= 120:
            return overlay_y + scaled_h + 25
    return int(out_h * FILL_BANNER_Y / 1920)

def per_shot_expr(plan: ClipLayoutPlan, values: list[float]) -> str:
    """Expression of `t` that takes values[i] during shot i."""
    if len(set(values)) == 1:
        return f"{values[0]:.0f}"
    boundaries = [s.end_ms / 1000 for s in plan.shots[:-1]]
    return step_expr(boundaries, values)

Rect = tuple[int, int, int, int]

FACE_HOLD_MS = 375
MIN_ZONE_FACE_PX = 48

@dataclass(frozen=True)
class FaceZone:
    """Faces visible on the output frame during [start_ms, end_ms) of output time."""

    start_ms: int
    end_ms: int
    rects: tuple[Rect, ...]

def manual_views(shot, src_w, src_h, out_w, out_h, t_ms=None):
    """Exact normalized crops shared with the editor. Round inward for yuv420p."""
    result = []
    panel_h = even(out_h / len(shot.manual_crops))
    crops = shot.manual_crops
    if shot.manual_transition_ms and t_ms is not None:
        p = max(0, min(1, (t_ms - shot.manual_transition_start_ms) / shot.manual_transition_ms))
        ease = p * p * (3 - 2 * p)
        crops = [[a + (b - a) * ease for a, b in zip(start, end)] for start, end in zip(shot.manual_from_crops, crops)]
    for i, (x, y, w, h) in enumerate(crops):
        px, py = max(0, int(x * src_w) // 2 * 2), max(0, int(y * src_h) // 2 * 2)
        pw, ph = min(even(w * src_w), src_w - px), min(even(h * src_h), src_h - py)
        result.append(((px, py, pw, ph), (0, i * panel_h, out_w, out_h - panel_h if i == 1 else panel_h)))
    return result

def shot_views(
    shot: ShotLayout, t_ms: int, src_w: int, src_h: int, out_w: int, out_h: int,
) -> list[tuple[tuple[float, float, float, float], tuple[int, int, int, int]]]:
    """Where the source lands on the output at window time t_ms.

    One (source crop, output rect) pair per panel, both as (x, y, w, h). Mirrors
    the 9:16 branches of shot_chain.
    """
    if shot.manual_crops:
        return manual_views(shot, src_w, src_h, out_w, out_h, t_ms)
    if shot.content_box is not None:
        return [content_view(shot, src_w, src_h, out_w, out_h)]
    if shot.layout == LayoutType.TALKING_HEAD:
        crop_w, crop_h, xs, ys = _fill_crop_path(shot, src_w, src_h, out_w, out_h)
        t = t_ms / 1000
        x = path_value_at(xs, t) if crop_w < src_w else 0
        y = path_value_at(ys, t) if crop_h < src_h else 0
        return [((x, y, crop_w, crop_h), (0, 0, out_w, out_h))]

    top_h, bottom_h = stacked_panel_heights(shot, src_h, out_h)
    if shot.layout == LayoutType.TWO_SHOT and len(shot.people) >= 2:
        left, right = shot.people[0], shot.people[1]
        mid = (left.cx + right.cx) / 2 * src_w
        top = person_crop(left, src_w, src_h, out_w, top_h, (0, mid))
        bottom = person_crop(right, src_w, src_h, out_w, bottom_h, (mid, src_w))
        return [
            ((top[2], top[3], top[0], top[1]), (0, 0, out_w, top_h)),
            ((bottom[2], bottom[3], bottom[0], bottom[1]), (0, top_h, out_w, bottom_h)),
        ]
    if shot.layout == LayoutType.SCREEN_CAM and shot.cam_box is not None:
        screen, screen_dest = screen_view(shot, src_w, src_h, out_w, top_h)
        cam = cam_crop(shot.cam_box, shot.cam_face, src_w, src_h, out_w, bottom_h)
        return [
            ((screen[2], screen[3], screen[0], screen[1]), screen_dest),
            ((cam[2], cam[3], cam[0], cam[1]), (0, top_h, out_w, bottom_h)),
        ]

    scaled_h, overlay_y = letterbox_geometry(src_w, src_h, out_w, out_h)
    return [((0, 0, src_w, src_h), (0, overlay_y, out_w, scaled_h))]

def face_rects(
    shot: ShotLayout, faces: list[Box], t_ms: int, src_w: int, src_h: int, out_w: int, out_h: int,
) -> list[Rect]:
    """Output-pixel rects of the faces (normalized source boxes) visible at t_ms."""
    rects: list[Rect] = []
    for (cx, cy, cw, ch), (dx, dy, dw, dh) in shot_views(shot, t_ms, src_w, src_h, out_w, out_h):
        sx, sy = dw / cw, dh / ch
        for face in faces:
            x0 = max(dx + (face.x * src_w - cx) * sx, dx)
            y0 = max(dy + (face.y * src_h - cy) * sy, dy)
            x1 = min(dx + ((face.x + face.w) * src_w - cx) * sx, dx + dw)
            y1 = min(dy + ((face.y + face.h) * src_h - cy) * sy, dy + dh)
            if x1 - x0 >= MIN_ZONE_FACE_PX / 2 and (face.h * src_h * sy) >= MIN_ZONE_FACE_PX and y1 > y0:
                rects.append((round(x0), round(y0), round(x1), round(y1)))
    return rects

def _shot_faces(shot: ShotLayout) -> list[Box]:
    """The shot's summary face boxes, for shots the detector never saw a face in."""
    if shot.layout in (LayoutType.TALKING_HEAD, LayoutType.TWO_SHOT):
        return list(shot.people)
    if shot.layout == LayoutType.SCREEN_CAM and shot.cam_face is not None:
        return [shot.cam_face]
    return []

def face_zones(plan: ClipLayoutPlan, time_map, out_w: int, out_h: int) -> list[FaceZone]:
    """Faces on the output frame over the edited timeline (9:16 only).

    `plan` is in window time (not remapped); `time_map` moves each detection
    onto the output timeline and drops time the edit cut. A shot where the
    detector saw no face (e.g. a vision-refined shot) falls back to its
    summary boxes for its whole length.
    """
    src_w, src_h = plan.source_width, plan.source_height
    samples = sorted(plan.face_samples, key=lambda s: s[0])
    zones: list[FaceZone] = []
    for shot in plan.shots:
        in_shot = [(t, faces) for t, faces in samples if shot.start_ms <= t < shot.end_ms]
        hold = FACE_HOLD_MS
        if not any(faces for _, faces in in_shot):
            in_shot = [((shot.start_ms + shot.end_ms) // 2, _shot_faces(shot))]
            hold = shot.end_ms - shot.start_ms
        for t, faces in in_shot:
            rects = tuple(face_rects(shot, faces, t, src_w, src_h, out_w, out_h)) if faces else ()
            if not rects:
                continue
            for keep_start, keep_end in time_map.pieces_within(shot.start_ms, shot.end_ms):
                lo, hi = max(keep_start, t - hold), min(keep_end, t + hold)
                if hi > lo:
                    zones.append(FaceZone(time_map.to_output(lo), time_map.to_output(hi), rects))
    return sorted(zones, key=lambda z: z.start_ms)

CAPTION_TOP_LIMIT = 0.15
CAPTION_BOTTOM_LIMIT = 0.80
FACE_PAD_X = 0.15
FACE_PAD_TOP = 0.25
FACE_PAD_BOTTOM = 0.12
MAX_FACE_PAD_BOTTOM_PX = 40
CAPTION_FACE_GAP = 12

class CaptionPlacer:
    """Picks each caption group's position so it doesn't cover a face.

    A group starts at its shot's anchor (caption_anchor). If that would cover
    a face visible at any time while the group is up, it moves just below or
    above the faces, whichever is nearer the anchor, inside the band clear of
    the title and banner. Later groups in the same shot keep a moved position
    while it stays clear, so captions don't hop between phrases. If no spot
    is clear, the one covering the least face wins.
    """

    def __init__(self, anchors: list[tuple[int, int, int]], zones: list[FaceZone], out_w: int, out_h: int):
        self.anchors = anchors
        self.zones = sorted(zones, key=lambda z: z.start_ms)
        self._starts = [z.start_ms for z in self.zones]
        self._longest = max((z.end_ms - z.start_ms for z in self.zones), default=0)
        self.out_w, self.out_h = out_w, out_h
        self._last: Optional[tuple[int, float]] = None

    def faces_during(self, start_ms: int, end_ms: int) -> list[Rect]:
        first = bisect_left(self._starts, start_ms - self._longest)
        last = bisect_left(self._starts, end_ms)
        return [r for z in self.zones[first:last] if z.end_ms > start_ms for r in z.rects]

    def __call__(self, start_ms: int, end_ms: int, block_w: int, block_h: int) -> tuple[int, int]:
        """(ASS alignment, y) for a caption block on screen during [start_ms, end_ms)."""
        index = next((i for i, (until, _, _) in enumerate(self.anchors) if start_ms < until), len(self.anchors) - 1)
        _, alignment, anchor_y = self.anchors[index]
        half = block_h / 2
        default = anchor_y - half if alignment in (1, 2, 3) else anchor_y + half if alignment in (7, 8, 9) else anchor_y

        left, right = (self.out_w - block_w) / 2, (self.out_w + block_w) / 2
        faces, keep_clear = [], []
        for x0, y0, x1, y1 in self.faces_during(start_ms, end_ms):
            w, h = x1 - x0, y1 - y0
            if x1 + w * FACE_PAD_X > left and x0 - w * FACE_PAD_X < right:
                faces.append((y0, y1))
                keep_clear.append((
                    y0 - h * FACE_PAD_TOP - CAPTION_FACE_GAP,
                    y1 + min(h * FACE_PAD_BOTTOM, MAX_FACE_PAD_BOTTOM_PX) + CAPTION_FACE_GAP,
                ))

        top, bottom = self.out_h * CAPTION_TOP_LIMIT + half, self.out_h * CAPTION_BOTTOM_LIMIT - half
        if top > bottom:
            top = bottom = self.out_h / 2

        def in_band(c: float) -> float:
            return min(max(c, top), bottom)

        def overlap(c: float, spans: list[tuple[float, float]]) -> float:
            return sum(max(0.0, min(c + half, b) - max(c - half, a)) for a, b in spans)

        candidates = [(default, 1)]
        if self._last is not None and self._last[0] == index:
            candidates.append((self._last[1], 0))
        for a, b in keep_clear:
            candidates += [(in_band(b + half), 2), (in_band(a - half), 2)]
        candidates += [(top, 2), (bottom, 2)]

        center, _ = min(candidates, key=lambda c: (
            4 * overlap(c[0], faces) + overlap(c[0], keep_clear), c[1], abs(c[0] - default),
        ))
        self._last = (index, center)
        if center == default:
            return alignment, anchor_y
        return 5, round(center)
