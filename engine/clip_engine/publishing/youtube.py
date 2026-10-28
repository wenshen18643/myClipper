"""YouTube uploads through the Data API v3 (videos.insert, resumable).

Uploads from a Google Cloud project that hasn't passed YouTube's API audit
are locked to private; the audit lifts that. Scheduled videos are uploaded
private with `publishAt`, and YouTube publishes them at that time.
"""

import json
import logging
import os
from datetime import datetime, timezone
from typing import Iterator, Optional
from urllib.parse import urlencode

import httpx

from clip_engine.publishing import oauth
from clip_engine.publishing.client import OAuthClient, PublishError, require_host

logger = logging.getLogger(__name__)

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos"
SCOPE = "https://www.googleapis.com/auth/youtube.upload"
DEFAULT_CATEGORY = "24"
CHUNK_BYTES = 8 * 1024 * 1024
MAX_ATTEMPTS = 5

def load_client_secret(path: str) -> tuple[str, str]:
    """client_id and client_secret from the JSON Google gives for a Desktop OAuth client."""
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    info = data.get("installed") or data.get("web") or {}
    if not info.get("client_id") or not info.get("client_secret"):
        raise PublishError("The client secret file has no client_id/client_secret", retryable=False)
    return info["client_id"], info["client_secret"]

def rfc3339(moment: datetime) -> str:
    if moment.tzinfo is None:
        raise ValueError("publish time needs a time zone")
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

class YouTubeClient(OAuthClient):
    platform = "youtube"

    def __init__(self, client_id: str, client_secret: str, **kwargs):
        super().__init__(**kwargs)
        self.client_id = client_id
        self.client_secret = client_secret

    def authorize(self, open_browser: bool = True) -> None:
        verifier, challenge = oauth.pkce_pair()

        def auth_url(redirect_uri: str, state: str) -> str:
            return AUTH_URL + "?" + urlencode({
                "client_id": self.client_id, "redirect_uri": redirect_uri, "response_type": "code",
                "scope": SCOPE, "access_type": "offline", "prompt": "consent", "state": state,
                "code_challenge": challenge, "code_challenge_method": "S256",
            })

        code, redirect_uri = oauth.receive_code(auth_url, open_browser=open_browser)
        response = self.http.post(TOKEN_URL, data={
            "code": code, "client_id": self.client_id, "client_secret": self.client_secret,
            "redirect_uri": redirect_uri, "grant_type": "authorization_code", "code_verifier": verifier,
        })
        self._remember(self._json(response, "sign-in"))

    def _refresh(self, token: dict) -> dict:
        response = self.http.post(TOKEN_URL, data={
            "client_id": self.client_id, "client_secret": self.client_secret,
            "refresh_token": token["refresh_token"], "grant_type": "refresh_token",
        })
        return self._remember(self._json(response, "token refresh"), token)

    @staticmethod
    def _json(response: httpx.Response, what: str) -> dict:
        try:
            data = response.json()
        except ValueError:
            data = {}
        if response.status_code >= 400:
            error = data.get("error")
            reason = error.get("message") if isinstance(error, dict) else (data.get("error_description") or error)
            retryable = response.status_code >= 500 or response.status_code == 429
            raise PublishError(f"YouTube {what} failed ({response.status_code}): {reason}",
                               code=str(response.status_code), retryable=retryable)
        return data

    def upload(
        self,
        path: str,
        title: str,
        description: str = "",
        tags: Optional[list[str]] = None,
        publish_at: Optional[datetime] = None,
        category_id: str = DEFAULT_CATEGORY,
        private: bool = False,
    ) -> dict:
        """Upload `path`; returns the video resource. Scheduled when `publish_at` is set."""
        size = os.path.getsize(path)
        status = {"selfDeclaredMadeForKids": False}
        if publish_at and not private:
            status.update(privacyStatus="private", publishAt=rfc3339(publish_at))
        else:
            status["privacyStatus"] = "private" if private else "public"
        body = {
            "snippet": {"title": title[:100], "description": description[:5000],
                        "tags": tags or [], "categoryId": category_id},
            "status": status,
        }
        headers = {
            "Authorization": f"Bearer {self.access_token()}",
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Length": str(size),
            "X-Upload-Content-Type": "video/mp4",
        }
        response = self.http.post(UPLOAD_URL, params={"uploadType": "resumable", "part": "snippet,status"},
                                  headers=headers, json=body)
        self._json(response, "upload start")
        session = require_host(response.headers.get("Location", ""), "googleapis.com")
        return self._send(session, path, size)

    def _send(self, session: str, path: str, size: int) -> dict:
        """PUT the file to the resumable session, resuming from YouTube's offset after errors."""
        offset = 0
        for _ in range(MAX_ATTEMPTS):
            try:
                response = self.http.put(session, content=_read_from(path, offset), headers={
                    "Authorization": f"Bearer {self.access_token()}",
                    "Content-Length": str(size - offset),
                    "Content-Range": f"bytes {offset}-{size - 1}/{size}",
                    "Content-Type": "video/mp4",
                })
                if response.status_code in (200, 201):
                    return response.json()
                if response.status_code < 500 and response.status_code != 308:
                    self._json(response, "upload")
            except httpx.TransportError as e:
                logger.warning(f"YouTube upload interrupted ({e}); resuming")
            offset, video = self._progress(session, size)
            if video is not None:
                return video
        raise PublishError("YouTube upload did not complete after retries")

    def _progress(self, session: str, size: int) -> tuple[int, Optional[dict]]:
        """(bytes YouTube has, the video resource if the upload already completed)."""
        response = self.http.put(session, headers={
            "Authorization": f"Bearer {self.access_token()}", "Content-Length": "0",
            "Content-Range": f"bytes */{size}",
        })
        if response.status_code in (200, 201):
            return size, response.json()
        if response.status_code != 308:
            self._json(response, "upload status")
        received = response.headers.get("Range", "")
        return (int(received.rsplit("-", 1)[1]) + 1 if "-" in received else 0), None

def _read_from(path: str, offset: int) -> Iterator[bytes]:
    with open(path, "rb") as f:
        f.seek(offset)
        while chunk := f.read(CHUNK_BYTES):
            yield chunk
