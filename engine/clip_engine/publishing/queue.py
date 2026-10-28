"""A posting queue: which clip goes where and when, and what happened to it.

queue.json:
{"posts": [{
  "file": "clip.mp4",                      # relative to the queue file
  "title": "...", "caption": "...", "tags": ["..."],
  "youtube": {"publish_at": "2026-10-27T08:30:00+08:00"},
  "tiktok": {"send_at": "2026-10-27T08:15:00+08:00"}
}]}

`run_due` is safe to call repeatedly (e.g. every 15 minutes). Each platform
entry moves pending -> scheduled/published (YouTube) or pending -> sent ->
in_inbox -> posted (TikTok), or to failed with the error kept.
"""

import os
from datetime import datetime, timedelta
from pathlib import Path
from typing import Callable

from clip_engine.publishing.client import PublishError
from clip_engine.publishing.store import read_json, write_json

YOUTUBE_LEAD = timedelta(days=7)
MIN_SCHEDULE_AHEAD = timedelta(minutes=15)
MAX_ATTEMPTS = 5

def load_queue(path: str) -> dict:
    queue = read_json(Path(path))
    if not isinstance(queue, dict) or not isinstance(queue.get("posts"), list):
        raise PublishError(f"{path} is not a queue file", retryable=False)
    return queue

def save_queue(path: str, queue: dict) -> None:
    write_json(Path(path), queue)

def parse_time(value: str) -> datetime:
    moment = datetime.fromisoformat(value)
    if moment.tzinfo is None:
        raise ValueError(f"Time without a time zone: {value}")
    return moment

def _failed(entry: dict, error: Exception, now: datetime) -> str:
    entry["error"] = str(error)
    entry["attempts"] = entry.get("attempts", 0) + 1
    entry["last_try"] = now.isoformat()
    final = not getattr(error, "retryable", True) or entry["attempts"] >= MAX_ATTEMPTS
    if final:
        entry["state"] = "failed"
    return "failed" if final else "will retry"

def run_due(
    queue: dict,
    queue_dir: str,
    now: datetime,
    youtube=None,
    tiktok=None,
    save: Callable[[], None] = lambda: None,
    dry_run: bool = False,
    instagram=None,
) -> list[str]:
    """Do everything that is due at `now`; returns one line per action."""
    log: list[str] = []
    for post in queue["posts"]:
        name = post.get("title") or post.get("file")
        path = os.path.join(queue_dir, post["file"])

        yt = post.get("youtube")
        if youtube and yt and yt.get("state", "pending") == "pending":
            publish_at = parse_time(yt["publish_at"])
            if publish_at - now <= YOUTUBE_LEAD:
                when = publish_at if publish_at - now >= MIN_SCHEDULE_AHEAD else None
                if dry_run:
                    log.append(f"youtube  would upload  {name}  ({'for ' + publish_at.isoformat() if when else 'public now'})")
                else:
                    try:
                        if not os.path.isfile(path):
                            raise PublishError(f"Missing file {post['file']}", retryable=False)
                        video = youtube.upload(path, post["title"], post.get("description", post.get("caption", "")),
                                               post.get("tags"), when)
                        yt.update(state="scheduled" if when else "published", video_id=video.get("id"),
                                  url=f"https://youtube.com/shorts/{video.get('id')}", error=None)
                        log.append(f"youtube  {yt['state']}  {name}  {yt['url']}")
                    except Exception as e:
                        log.append(f"youtube  {_failed(yt, e, now)}  {name}: {e}")
                    save()

        ig = post.get("instagram")
        if instagram and ig:
            log.extend(_run_instagram(post, ig, path, name, now, instagram, save, dry_run))

        tt = post.get("tiktok")
        if not (tiktok and tt):
            continue
        state = tt.get("state", "pending")
        if state == "pending" and now >= parse_time(tt["send_at"]):
            if dry_run:
                log.append(f"tiktok   would send draft  {name}")
                continue
            try:
                if not os.path.isfile(path):
                    raise PublishError(f"Missing file {post['file']}", retryable=False)
                tt.update(publish_id=tiktok.send_draft(path), state="sent", sent_at=now.isoformat(), error=None)
                log.append(f"tiktok   draft sent  {name}  (caption: {post.get('caption', '')})")
            except Exception as e:
                log.append(f"tiktok   {_failed(tt, e, now)}  {name}: {e}")
            save()
        elif state in ("sent", "in_inbox") and not dry_run:
            try:
                status = tiktok.status(tt["publish_id"])
            except Exception as e:
                log.append(f"tiktok   status check failed  {name}: {e}")
                continue
            new = {"SEND_TO_USER_INBOX": "in_inbox", "PUBLISH_COMPLETE": "posted", "FAILED": "failed"}.get(
                status.get("status"), state)
            if new != state:
                tt["state"] = new
                if new == "failed":
                    tt["error"] = status.get("fail_reason")
                log.append(f"tiktok   {new}  {name}" + (f": {tt['error']}" if new == "failed" else ""))
                save()
    return log

def _run_instagram(post, ig, path, name, now, instagram, save, dry_run) -> list[str]:
    """Instagram has no scheduling in its API: publish at the slot, finish processing on a later run."""
    state = ig.get("state", "pending")
    if state == "pending" and now >= parse_time(ig["publish_at"]):
        if dry_run:
            return [f"instagram would post  {name}"]
        try:
            if not os.path.isfile(path):
                raise PublishError(f"Missing file {post['file']}", retryable=False)
            result = instagram.publish_reel(path, post.get("caption", ""))
            ig.update(container_id=result["container_id"], error=None)
            if result.get("media_id"):
                _ig_posted(ig, instagram, result["media_id"])
            else:
                ig["state"] = "processing"
            line = f"instagram {ig['state']}  {name}" + (f"  {ig['url']}" if ig.get("url") else "")
        except Exception as e:
            line = f"instagram {_failed(ig, e, now)}  {name}: {e}"
        save()
        return [line]
    if state == "processing" and not dry_run:
        try:
            result = instagram.finish(ig["container_id"], wait_s=0)
        except Exception as e:
            line = f"instagram {_failed(ig, e, now)}  {name}: {e}"
            save()
            return [line]
        if result.get("media_id"):
            _ig_posted(ig, instagram, result["media_id"])
            save()
            return [f"instagram posted  {name}" + (f"  {ig['url']}" if ig.get("url") else "")]
    return []

def _ig_posted(ig, instagram, media_id) -> None:
    """Keep the post's link: Content Rewards wants it submitted within 30 minutes."""
    ig.update(state="posted", media_id=media_id)
    try:
        ig["url"] = instagram.permalink(media_id)
    except Exception:
        pass

def summary(queue: dict) -> list[str]:
    rows = []
    for post in queue["posts"]:
        yt, tt, ig = post.get("youtube") or {}, post.get("tiktok") or {}, post.get("instagram") or {}
        error = yt.get("error") or tt.get("error") or ig.get("error")
        rows.append(f"{post.get('title', post['file'])[:50]:50}  "
                    f"YT {yt.get('state', 'pending') if yt else '-':10} {yt.get('publish_at', '')[:16]:16}  "
                    f"TT {tt.get('state', 'pending') if tt else '-':9}  "
                    f"IG {ig.get('state', 'pending') if ig else '-':10}"
                    + (f"  ! {error}" if error else ""))
    return rows
