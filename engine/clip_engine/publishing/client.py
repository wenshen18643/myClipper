"""Shared token handling for the platform clients."""

import time
from typing import Optional
from urllib.parse import urlsplit

import httpx

from clip_engine.publishing.store import TokenStore

EXPIRY_MARGIN_S = 120

class PublishError(RuntimeError):
    """A platform rejected a request. `retryable` is False when retrying cannot help."""

    def __init__(self, message: str, code: str = "", retryable: bool = True):
        super().__init__(message)
        self.code = code
        self.retryable = retryable

def require_host(url: str, *suffixes: str) -> str:
    """Server-supplied upload URLs must be HTTPS on the platform's own domains."""
    parts = urlsplit(url or "")
    host = (parts.hostname or "").lower()
    if parts.scheme != "https" or not any(host == s or host.endswith("." + s) for s in suffixes):
        raise PublishError(f"Unexpected upload URL host: {host or url!r}", retryable=False)
    return url

class OAuthClient:
    """Keeps an access token fresh with the stored refresh token."""

    platform = ""

    def __init__(self, store: Optional[TokenStore] = None, http: Optional[httpx.Client] = None):
        self.store = store or TokenStore(self.platform)
        self.http = http or httpx.Client(timeout=httpx.Timeout(60, read=300), follow_redirects=False)

    def _refresh(self, token: dict) -> dict:
        raise NotImplementedError

    def _remember(self, response: dict, previous: Optional[dict] = None) -> dict:
        token = dict(previous or {})
        token.update({k: v for k, v in response.items() if v is not None})
        token["expires_at"] = time.time() + float(response.get("expires_in", 3600))
        self.store.save(token)
        return token

    def access_token(self) -> str:
        token = self.store.load()
        if not token.get("refresh_token") and not token.get("access_token"):
            raise PublishError(f"Not signed in to {self.platform}; run: auth {self.platform}", retryable=False)
        if time.time() > float(token.get("expires_at", 0)) - EXPIRY_MARGIN_S:
            if not token.get("refresh_token"):
                raise PublishError(f"{self.platform} sign-in expired; run: auth {self.platform}", retryable=False)
            token = self._refresh(token)
        return token["access_token"]
