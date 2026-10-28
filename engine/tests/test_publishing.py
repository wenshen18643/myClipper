"""Publishing clients and queue, against mocked platform endpoints."""

import base64
import hashlib
import json
import threading
import time
from datetime import datetime, timedelta, timezone

import httpx
import pytest

from clip_engine.publishing import oauth
from clip_engine.publishing import queue as posting_queue
from clip_engine.publishing.client import PublishError, require_host
from clip_engine.publishing.store import TokenStore
from clip_engine.publishing.tiktok import CHUNK_BYTES, INBOX_INIT_URL, STATUS_URL, TikTokClient, chunk_plan
from clip_engine.publishing.youtube import TOKEN_URL, UPLOAD_URL, YouTubeClient, rfc3339

MB = 1024 * 1024
SESSION = "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=abc"

def signed_in(tmp_path, platform, expires_in=3600):
    store = TokenStore(platform, tmp_path)
    store.save({"access_token": "old", "refresh_token": "r1", "expires_at": time.time() + expires_in})
    return store

def make_video(tmp_path, size):
    path = tmp_path / "clip.mp4"
    path.write_bytes(bytes(range(256)) * (size // 256) + b"x" * (size % 256))
    return path

def test_pkce_formats():
    verifier, challenge = oauth.pkce_pair()
    digest = hashlib.sha256(verifier.encode()).digest()
    assert 43 <= len(verifier) <= 128
    assert challenge == base64.urlsafe_b64encode(digest).rstrip(b"=").decode()
    verifier, challenge = oauth.pkce_pair(hex_challenge=True)
    assert challenge == hashlib.sha256(verifier.encode()).hexdigest()

def sign_in_via_redirect(params):
    """Run receive_code with a fake browser that follows the redirect with `params` (state filled in)."""
    def auth_url(redirect_uri, state):
        query = {k: (state if v == "STATE" else v) for k, v in params.items()}
        threading.Timer(0.2, lambda: httpx.get(redirect_uri, params=query)).start()
        return "https://example.test/consent"
    return oauth.receive_code(auth_url, open_browser=False, timeout_s=10)

def test_receive_code_loopback():
    code, redirect_uri = sign_in_via_redirect({"code": "abc", "state": "STATE"})
    assert code == "abc" and redirect_uri.startswith("http://127.0.0.1:") and redirect_uri.endswith("/callback/")
    with pytest.raises(oauth.OAuthError, match="state mismatch"):
        sign_in_via_redirect({"code": "abc", "state": "forged"})
    with pytest.raises(oauth.OAuthError, match="denied"):
        sign_in_via_redirect({"error": "access_denied", "error_description": "denied", "state": "STATE"})

def test_require_host():
    assert require_host("https://open-upload.tiktokapis.com/x", "tiktokapis.com")
    for bad in ("http://open.tiktokapis.com/x", "https://tiktokapis.com.evil.io/x", "https://evil.io/x", ""):
        with pytest.raises(PublishError):
            require_host(bad, "tiktokapis.com")

def test_chunk_plan():
    assert chunk_plan(5 * MB) == (5 * MB, 1)
    assert chunk_plan(64 * MB) == (64 * MB, 1)
    assert chunk_plan(65 * MB) == (CHUNK_BYTES, 6)
    with pytest.raises(PublishError):
        chunk_plan(0)

def test_rfc3339_converts_to_utc():
    myt = timezone(timedelta(hours=8))
    assert rfc3339(datetime(2026, 10, 27, 8, 30, tzinfo=myt)) == "2026-10-27T00:30:00Z"
    with pytest.raises(ValueError):
        rfc3339(datetime(2026, 10, 27, 8, 30))

def test_youtube_scheduled_upload(tmp_path):
    video = make_video(tmp_path, 3000)
    seen = {}

    def handler(request):
        if request.url.path == "/upload/youtube/v3/videos" and request.method == "POST":
            seen["body"] = json.loads(request.content)
            seen["params"] = dict(request.url.params)
            assert request.headers["Authorization"] == "Bearer old"
            return httpx.Response(200, headers={"Location": SESSION})
        if request.method == "PUT":
            seen["put"] = len(request.read())
            assert request.headers["Content-Range"] == "bytes 0-2999/3000"
            return httpx.Response(200, json={"id": "vid1", "status": {"privacyStatus": "private"}})
        raise AssertionError(request.url)

    client = YouTubeClient("id", "secret", store=signed_in(tmp_path, "youtube"),
                           http=httpx.Client(transport=httpx.MockTransport(handler)))
    when = datetime(2030, 1, 1, 8, 0, tzinfo=timezone(timedelta(hours=8)))
    assert client.upload(str(video), "A" * 150, "desc", ["clips"], when)["id"] == "vid1"
    assert seen["params"] == {"uploadType": "resumable", "part": "snippet,status"}
    assert seen["body"]["snippet"]["title"] == "A" * 100
    assert seen["body"]["status"] == {"selfDeclaredMadeForKids": False, "privacyStatus": "private",
                                      "publishAt": "2030-01-01T00:00:00Z"}
    assert seen["put"] == 3000

def test_youtube_resumes_after_interruption(tmp_path):
    video = make_video(tmp_path, 5000)
    puts = []

    def handler(request):
        if request.method == "POST":
            return httpx.Response(200, headers={"Location": SESSION})
        puts.append(request.headers["Content-Range"])
        if len(puts) == 1:
            raise httpx.ReadError("connection reset")
        if request.headers["Content-Range"] == "bytes */5000":
            return httpx.Response(308, headers={"Range": "bytes=0-1999"})
        assert len(request.read()) == 3000
        return httpx.Response(201, json={"id": "vid2"})

    client = YouTubeClient("id", "secret", store=signed_in(tmp_path, "youtube"),
                           http=httpx.Client(transport=httpx.MockTransport(handler)))
    assert client.upload(str(video), "t")["id"] == "vid2"
    assert puts == ["bytes 0-4999/5000", "bytes */5000", "bytes 2000-4999/5000"]

def test_youtube_refreshes_expired_token(tmp_path):
    store = signed_in(tmp_path, "youtube", expires_in=-10)

    def handler(request):
        if str(request.url) == TOKEN_URL:
            form = dict(httpx.QueryParams(request.content.decode()))
            assert form["grant_type"] == "refresh_token" and form["refresh_token"] == "r1"
            return httpx.Response(200, json={"access_token": "new", "expires_in": 3599})
        assert request.headers["Authorization"] == "Bearer new"
        if request.method == "POST":
            return httpx.Response(200, headers={"Location": SESSION})
        return httpx.Response(200, json={"id": "vid3"})

    client = YouTubeClient("id", "secret", store=store, http=httpx.Client(transport=httpx.MockTransport(handler)))
    client.upload(str(make_video(tmp_path, 100)), "t")
    saved = store.load()
    assert saved["access_token"] == "new" and saved["refresh_token"] == "r1"

def test_youtube_quota_error_is_final(tmp_path):
    def handler(request):
        return httpx.Response(403, json={"error": {"message": "quotaExceeded"}})

    client = YouTubeClient("id", "secret", store=signed_in(tmp_path, "youtube"),
                           http=httpx.Client(transport=httpx.MockTransport(handler)))
    with pytest.raises(PublishError) as error:
        client.upload(str(make_video(tmp_path, 100)), "t")
    assert not error.value.retryable and "quotaExceeded" in str(error.value)

def test_youtube_rejects_foreign_upload_url(tmp_path):
    def handler(request):
        return httpx.Response(200, headers={"Location": "https://evil.example/upload"})

    client = YouTubeClient("id", "secret", store=signed_in(tmp_path, "youtube"),
                           http=httpx.Client(transport=httpx.MockTransport(handler)))
    with pytest.raises(PublishError, match="Unexpected upload URL"):
        client.upload(str(make_video(tmp_path, 100)), "t")

def tiktok_client(tmp_path, handler):
    return TikTokClient("key", "secret", store=signed_in(tmp_path, "tiktok"),
                        http=httpx.Client(transport=httpx.MockTransport(handler)))

def test_tiktok_draft_in_chunks(tmp_path, monkeypatch):
    monkeypatch.setattr("clip_engine.publishing.tiktok.SINGLE_CHUNK_MAX", 1000)
    monkeypatch.setattr("clip_engine.publishing.tiktok.CHUNK_BYTES", 400)
    video = make_video(tmp_path, 1100)
    ranges = []

    def handler(request):
        if str(request.url) == INBOX_INIT_URL:
            body = json.loads(request.content)
            assert body["source_info"] == {"source": "FILE_UPLOAD", "video_size": 1100,
                                           "chunk_size": 400, "total_chunk_count": 2}
            return httpx.Response(200, json={"data": {"publish_id": "p1",
                                                      "upload_url": "https://open-upload.tiktokapis.com/u/1"},
                                             "error": {"code": "ok"}})
        ranges.append(request.headers["Content-Range"])
        return httpx.Response(206 if len(ranges) == 1 else 201)

    assert tiktok_client(tmp_path, handler).send_draft(str(video)) == "p1"
    assert ranges == ["bytes 0-399/1100", "bytes 400-1099/1100"]

def test_tiktok_error_envelope(tmp_path):
    def handler(request):
        return httpx.Response(200, json={"data": {}, "error": {
            "code": "spam_risk_too_many_pending_share", "message": "too many pending"}})

    with pytest.raises(PublishError) as error:
        tiktok_client(tmp_path, handler).send_draft(str(make_video(tmp_path, 100)))
    assert error.value.code == "spam_risk_too_many_pending_share" and error.value.retryable

    def banned(request):
        return httpx.Response(403, json={"error": {"code": "spam_risk_user_banned_from_posting"}})

    with pytest.raises(PublishError) as error:
        tiktok_client(tmp_path, banned).send_draft(str(make_video(tmp_path, 100)))
    assert not error.value.retryable

def test_tiktok_status(tmp_path):
    def handler(request):
        assert str(request.url) == STATUS_URL and json.loads(request.content) == {"publish_id": "p1"}
        return httpx.Response(200, json={"data": {"status": "SEND_TO_USER_INBOX"}, "error": {"code": "ok"}})

    assert tiktok_client(tmp_path, handler).status("p1")["status"] == "SEND_TO_USER_INBOX"

def test_not_signed_in(tmp_path):
    client = TikTokClient("key", "secret", store=TokenStore("tiktok", tmp_path))
    with pytest.raises(PublishError, match="Not signed in"):
        client.access_token()

class FakeYouTube:
    def __init__(self):
        self.calls = []

    def upload(self, path, title, description="", tags=None, publish_at=None):
        self.calls.append((title, publish_at))
        return {"id": f"v{len(self.calls)}"}

class FakeTikTok:
    def __init__(self, error=None, status="SEND_TO_USER_INBOX"):
        self.sent, self.error, self.state = [], error, status

    def send_draft(self, path):
        if self.error:
            raise self.error
        self.sent.append(path)
        return f"p{len(self.sent)}"

    def status(self, publish_id):
        return {"status": self.state}

NOW = datetime(2026, 10, 26, 12, 0, tzinfo=timezone.utc)

def make_queue(tmp_path, yt_at, tt_at):
    (tmp_path / "a.mp4").write_bytes(b"video")
    return {"posts": [{"file": "a.mp4", "title": "Clip A", "caption": "cap #fyp", "tags": ["x"],
                       "youtube": {"publish_at": yt_at.isoformat()}, "tiktok": {"send_at": tt_at.isoformat()}}]}

def test_queue_schedules_youtube_ahead_and_waits_for_tiktok(tmp_path):
    queue = make_queue(tmp_path, NOW + timedelta(days=2), NOW + timedelta(days=2))
    youtube, tiktok = FakeYouTube(), FakeTikTok()
    log = posting_queue.run_due(queue, str(tmp_path), NOW, youtube, tiktok)
    post = queue["posts"][0]
    assert youtube.calls == [("Clip A", NOW + timedelta(days=2))]
    assert post["youtube"]["state"] == "scheduled" and post["youtube"]["video_id"] == "v1"
    assert tiktok.sent == [] and "state" not in post["tiktok"]
    assert len(log) == 1
    assert posting_queue.run_due(queue, str(tmp_path), NOW, youtube, tiktok) == []

def test_queue_publishes_now_when_slot_passed(tmp_path):
    queue = make_queue(tmp_path, NOW - timedelta(hours=1), NOW + timedelta(days=1))
    youtube = FakeYouTube()
    posting_queue.run_due(queue, str(tmp_path), NOW, youtube, None)
    assert youtube.calls == [("Clip A", None)] and queue["posts"][0]["youtube"]["state"] == "published"

def test_queue_leaves_far_future_youtube_alone(tmp_path):
    queue = make_queue(tmp_path, NOW + timedelta(days=30), NOW + timedelta(days=30))
    youtube = FakeYouTube()
    assert posting_queue.run_due(queue, str(tmp_path), NOW, youtube, None) == []
    assert youtube.calls == []

def test_queue_sends_tiktok_draft_then_tracks_status(tmp_path):
    queue = make_queue(tmp_path, NOW + timedelta(days=30), NOW - timedelta(minutes=1))
    tiktok, saves = FakeTikTok(), []
    posting_queue.run_due(queue, str(tmp_path), NOW, None, tiktok, save=lambda: saves.append(1))
    entry = queue["posts"][0]["tiktok"]
    assert entry["state"] == "sent" and entry["publish_id"] == "p1" and saves
    posting_queue.run_due(queue, str(tmp_path), NOW, None, tiktok)
    assert entry["state"] == "in_inbox"
    tiktok.state = "PUBLISH_COMPLETE"
    posting_queue.run_due(queue, str(tmp_path), NOW, None, tiktok)
    assert entry["state"] == "posted" and len(tiktok.sent) == 1

def test_queue_retries_then_gives_up(tmp_path):
    queue = make_queue(tmp_path, NOW + timedelta(days=30), NOW - timedelta(minutes=1))
    entry = queue["posts"][0]["tiktok"]
    busy = FakeTikTok(error=PublishError("TikTok spam_risk_too_many_pending_share", retryable=True))
    for attempt in range(1, posting_queue.MAX_ATTEMPTS):
        posting_queue.run_due(queue, str(tmp_path), NOW, None, busy)
        assert entry.get("state", "pending") == "pending" and entry["attempts"] == attempt
    posting_queue.run_due(queue, str(tmp_path), NOW, None, busy)
    assert entry["state"] == "failed"

    queue = make_queue(tmp_path, NOW + timedelta(days=30), NOW - timedelta(minutes=1))
    banned = FakeTikTok(error=PublishError("banned", retryable=False))
    posting_queue.run_due(queue, str(tmp_path), NOW, None, banned)
    assert queue["posts"][0]["tiktok"]["state"] == "failed"

def test_queue_dry_run_and_missing_file(tmp_path):
    queue = make_queue(tmp_path, NOW + timedelta(days=1), NOW - timedelta(minutes=1))
    youtube, tiktok = FakeYouTube(), FakeTikTok()
    log = posting_queue.run_due(queue, str(tmp_path), NOW, youtube, tiktok, dry_run=True)
    assert len(log) == 2 and youtube.calls == [] and tiktok.sent == []

    (tmp_path / "a.mp4").unlink()
    posting_queue.run_due(queue, str(tmp_path), NOW, youtube, tiktok)
    assert queue["posts"][0]["youtube"]["state"] == "failed"
    assert queue["posts"][0]["tiktok"]["state"] == "failed"

def test_queue_file_round_trip(tmp_path):
    path = tmp_path / "queue.json"
    posting_queue.save_queue(str(path), {"posts": []})
    assert posting_queue.load_queue(str(path)) == {"posts": []}
    path.write_text("[]")
    with pytest.raises(PublishError):
        posting_queue.load_queue(str(path))

def instagram_client(tmp_path, handler):
    from clip_engine.publishing.instagram import InstagramClient
    store = TokenStore("instagram", tmp_path)
    store.save({"access_token": "page-token", "expires_at": 4102444800, "ig_user_id": "1784"})
    return InstagramClient("app", "secret", store=store, http=httpx.Client(transport=httpx.MockTransport(handler)))

def test_instagram_reel_upload_and_publish(tmp_path, monkeypatch):
    monkeypatch.setattr("clip_engine.publishing.instagram.POLL_S", 0)
    video = make_video(tmp_path, 4000)
    calls, statuses = [], iter(["IN_PROGRESS", "FINISHED"])

    def handler(request):
        assert request.headers["Authorization"] == "OAuth page-token"
        calls.append((request.method, request.url.host, request.url.path))
        if request.url.path.endswith("/1784/media"):
            assert request.url.params["upload_type"] == "resumable"
            form = dict(httpx.QueryParams(request.content.decode()))
            assert form == {"media_type": "REELS", "caption": "cap #fyp"}
            return httpx.Response(200, json={"id": "c1", "uri": "https://rupload.facebook.com/ig-api-upload/v25.0/c1"})
        if request.url.host == "rupload.facebook.com":
            assert request.headers["offset"] == "0" and request.headers["file_size"] == "4000"
            assert len(request.read()) == 4000
            return httpx.Response(200, json={"success": True, "message": "Upload successful."})
        if request.url.path.endswith("/c1"):
            return httpx.Response(200, json={"status_code": next(statuses)})
        if request.url.path.endswith("/1784/media_publish"):
            assert dict(httpx.QueryParams(request.content.decode())) == {"creation_id": "c1"}
            return httpx.Response(200, json={"id": "m1"})
        raise AssertionError(request.url)

    result = instagram_client(tmp_path, handler).publish_reel(str(video), "cap #fyp")
    assert result == {"container_id": "c1", "media_id": "m1"}
    assert [c[2].rsplit("/", 1)[-1] for c in calls] == ["media", "c1", "c1", "c1", "media_publish"]

def test_instagram_still_processing_and_errors(tmp_path):
    def processing(request):
        return httpx.Response(200, json={"status_code": "IN_PROGRESS"})

    assert instagram_client(tmp_path, processing).finish("c1", wait_s=0) == {}

    def failed(request):
        return httpx.Response(200, json={"status_code": "ERROR", "status": "Unsupported video"})

    with pytest.raises(PublishError, match="processing error") as error:
        instagram_client(tmp_path, failed).finish("c1", wait_s=0)
    assert not error.value.retryable

    def rate_limited(request):
        return httpx.Response(400, json={"error": {"code": 4, "message": "Application request limit reached"}})

    with pytest.raises(PublishError) as error:
        instagram_client(tmp_path, rate_limited).publish_reel(str(make_video(tmp_path, 10)))
    assert error.value.retryable

    def foreign(request):
        return httpx.Response(200, json={"id": "c1", "uri": "https://evil.example/upload"})

    with pytest.raises(PublishError, match="Unexpected upload URL"):
        instagram_client(tmp_path, foreign).publish_reel(str(make_video(tmp_path, 10)))

class FakeInstagram:
    def __init__(self, ready=True):
        self.ready, self.posted = ready, []

    def publish_reel(self, path, caption=""):
        self.posted.append(caption)
        return {"container_id": "c1", **({"media_id": "m1"} if self.ready else {})}

    def finish(self, container_id, wait_s=0):
        return {"media_id": "m1"} if self.ready else {}

    def permalink(self, media_id):
        return f"https://www.instagram.com/reel/{media_id}/"

def test_queue_instagram_posts_at_slot_and_finishes_later(tmp_path):
    queue = make_queue(tmp_path, NOW + timedelta(days=30), NOW + timedelta(days=30))
    queue["posts"][0]["instagram"] = {"publish_at": (NOW + timedelta(hours=1)).isoformat()}
    instagram = FakeInstagram(ready=False)
    assert posting_queue.run_due(queue, str(tmp_path), NOW, instagram=instagram) == []
    later = NOW + timedelta(hours=2)
    posting_queue.run_due(queue, str(tmp_path), later, instagram=instagram)
    entry = queue["posts"][0]["instagram"]
    assert entry["state"] == "processing" and instagram.posted == ["cap #fyp"]
    instagram.ready = True
    posting_queue.run_due(queue, str(tmp_path), later, instagram=instagram)
    assert entry["state"] == "posted" and entry["media_id"] == "m1" and len(instagram.posted) == 1
    assert entry["url"] == "https://www.instagram.com/reel/m1/"
