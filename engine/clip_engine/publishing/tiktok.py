"""TikTok drafts through the Content Posting API (inbox upload, `video.upload`).

The video lands in the creator's TikTok inbox; they open the notification,
add a sound and caption, and post. Direct posting needs an audited client,
and TikTok's guidelines rule out tools for accounts you or your team manage.
"""

import logging
import os
from typing import Optional
from urllib.parse import urlencode

import httpx

from clip_engine.publishing import oauth
from clip_engine.publishing.client import OAuthClient, PublishError, require_host

logger = logging.getLogger(__name__)

AUTH_URL = "https://www.tiktok.com/v2/auth/authorize/"
API = "https://open.tiktokapis.com/v2"
TOKEN_URL = f"{API}/oauth/token/"
INBOX_INIT_URL = f"{API}/post/publish/inbox/video/init/"
STATUS_URL = f"{API}/post/publish/status/fetch/"
SCOPES = "user.info.basic,video.upload"

MB = 1024 * 1024
SINGLE_CHUNK_MAX = 64 * MB
CHUNK_BYTES = 10 * MB
FINAL_ERRORS = {"spam_risk_user_banned_from_posting", "scope_not_authorized", "access_token_invalid",
                "url_ownership_unverified", "invalid_param", "auth_removed", "spam_risk_text", "spam_risk"}

def chunk_plan(size: int) -> tuple[int, int]:
    """(chunk_size, total_chunk_count) per TikTok's media transfer rules.

    Up to 64 MB goes in one chunk. Larger files use 10 MB chunks with the
    remainder folded into the last one (allowed up to 128 MB).
    """
    if size <= 0:
        raise PublishError("Empty video file", retryable=False)
    if size <= SINGLE_CHUNK_MAX:
        return size, 1
    return CHUNK_BYTES, size // CHUNK_BYTES

class TikTokClient(OAuthClient):
    platform = "tiktok"

    def __init__(self, client_key: str, client_secret: str, redirect_port: int = 0, pkce_hex: bool = True, **kwargs):
        super().__init__(**kwargs)
        self.client_key = client_key
        self.client_secret = client_secret
        self.redirect_port = redirect_port
        self.pkce_hex = pkce_hex

    def authorize(self, open_browser: bool = True) -> None:
        verifier, challenge = oauth.pkce_pair(hex_challenge=self.pkce_hex)

        def auth_url(redirect_uri: str, state: str) -> str:
            return AUTH_URL + "?" + urlencode({
                "client_key": self.client_key, "response_type": "code", "scope": SCOPES,
                "redirect_uri": redirect_uri, "state": state,
                "code_challenge": challenge, "code_challenge_method": "S256",
            })

        code, redirect_uri = oauth.receive_code(auth_url, port=self.redirect_port, open_browser=open_browser)
        response = self.http.post(TOKEN_URL, data={
            "client_key": self.client_key, "client_secret": self.client_secret, "code": code,
            "grant_type": "authorization_code", "redirect_uri": redirect_uri, "code_verifier": verifier,
        })
        self._remember(self._token_json(response))

    def _refresh(self, token: dict) -> dict:
        response = self.http.post(TOKEN_URL, data={
            "client_key": self.client_key, "client_secret": self.client_secret,
            "grant_type": "refresh_token", "refresh_token": token["refresh_token"],
        })
        return self._remember(self._token_json(response), token)

    @staticmethod
    def _token_json(response: httpx.Response) -> dict:
        data = response.json() if response.content else {}
        if response.status_code >= 400 or "access_token" not in data:
            reason = data.get("error_description") or data.get("error") or response.status_code
            raise PublishError(f"TikTok sign-in failed: {reason}", code=str(data.get("error", "")), retryable=False)
        return data

    def _api(self, url: str, body: dict) -> dict:
        response = self.http.post(url, json=body, headers={
            "Authorization": f"Bearer {self.access_token()}",
            "Content-Type": "application/json; charset=UTF-8",
        })
        try:
            data = response.json()
        except ValueError:
            data = {}
        error = data.get("error") or {}
        code = error.get("code", "ok" if response.status_code < 400 else str(response.status_code))
        if code != "ok" or response.status_code >= 400:
            raise PublishError(f"TikTok {code}: {error.get('message', '')}".strip(), code=code,
                               retryable=code not in FINAL_ERRORS)
        return data.get("data") or {}

    def send_draft(self, path: str) -> str:
        """Upload `path` to the creator's TikTok inbox. Returns the publish_id."""
        size = os.path.getsize(path)
        chunk_size, count = chunk_plan(size)
        data = self._api(INBOX_INIT_URL, {"source_info": {
            "source": "FILE_UPLOAD", "video_size": size, "chunk_size": chunk_size, "total_chunk_count": count,
        }})
        upload_url = require_host(data.get("upload_url", ""), "tiktokapis.com")
        with open(path, "rb") as f:
            for index in range(count):
                start = index * chunk_size
                end = size if index == count - 1 else start + chunk_size
                f.seek(start)
                chunk = f.read(end - start)
                response = self.http.put(upload_url, content=chunk, headers={
                    "Content-Type": "video/mp4", "Content-Length": str(len(chunk)),
                    "Content-Range": f"bytes {start}-{end - 1}/{size}",
                })
                expected = 201 if index == count - 1 else 206
                if response.status_code not in (expected, 201):
                    raise PublishError(f"TikTok upload of chunk {index + 1}/{count} failed ({response.status_code})",
                                       code=str(response.status_code), retryable=response.status_code >= 500)
        return data["publish_id"]

    def status(self, publish_id: str) -> dict:
        """{'status': PROCESSING_UPLOAD | SEND_TO_USER_INBOX | PUBLISH_COMPLETE | FAILED, 'fail_reason': ...}"""
        return self._api(STATUS_URL, {"publish_id": publish_id})
