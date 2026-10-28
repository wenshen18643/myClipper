"""Instagram Reels through the Instagram API with Facebook Login (Graph API).

Needs an Instagram professional (Creator or Business) account linked to a
Facebook Page, and a Meta app the account owner has a role on (Standard
Access, no App Review for your own account). Videos go up with Meta's
resumable upload, then the container is published once it has processed.

Sign-in keeps a Page access token, which does not expire while the Page
role and app permissions stay in place.
"""

import logging
import os
import time
from typing import Optional
from urllib.parse import urlencode

import httpx

from clip_engine.publishing import oauth
from clip_engine.publishing.client import OAuthClient, PublishError, require_host

logger = logging.getLogger(__name__)

API_VERSION = "v25.0"
DIALOG_URL = f"https://www.facebook.com/{API_VERSION}/dialog/oauth"
GRAPH = f"https://graph.facebook.com/{API_VERSION}"
SCOPES = "instagram_basic,instagram_content_publish,pages_show_list,pages_read_engagement,business_management"
REDIRECT_PORT = 8766
PROCESS_WAIT_S = 180
POLL_S = 10

class InstagramClient(OAuthClient):
    platform = "instagram"

    def __init__(self, app_id: str, app_secret: str, config_id: str = "", **kwargs):
        super().__init__(**kwargs)
        self.app_id = app_id
        self.app_secret = app_secret
        self.config_id = config_id

    def authorize(self, open_browser: bool = True) -> None:
        def auth_url(redirect_uri: str, state: str) -> str:
            params = {"client_id": self.app_id, "redirect_uri": redirect_uri, "state": state, "response_type": "code"}
            params.update({"config_id": self.config_id} if self.config_id else {"scope": SCOPES})
            return DIALOG_URL + "?" + urlencode(params)

        code, redirect_uri = oauth.receive_code(auth_url, port=REDIRECT_PORT, open_browser=open_browser,
                                                host="localhost")
        short = self._graph("GET", "/oauth/access_token", params={
            "client_id": self.app_id, "client_secret": self.app_secret,
            "redirect_uri": redirect_uri, "code": code,
        }, token=None)
        long = self._graph("GET", "/oauth/access_token", params={
            "grant_type": "fb_exchange_token", "client_id": self.app_id, "client_secret": self.app_secret,
            "fb_exchange_token": short["access_token"],
        }, token=None)
        pages = self._graph("GET", "/me/accounts", params={
            "fields": "name,access_token,instagram_business_account{id,username}"}, token=long["access_token"])
        linked = [p for p in pages.get("data", []) if p.get("instagram_business_account")]
        if not linked:
            raise PublishError("No Facebook Page with a linked Instagram professional account was shared "
                               "during sign-in", retryable=False)
        page = linked[0]
        account = page["instagram_business_account"]
        self.store.save({"access_token": page["access_token"], "expires_at": 4102444800,
                         "ig_user_id": account["id"], "username": account.get("username"), "page": page.get("name")})
        print(f"Instagram account: @{account.get('username')} (Page: {page.get('name')})")

    def _refresh(self, token: dict) -> dict:
        raise PublishError("Instagram sign-in expired; run: auth instagram", retryable=False)

    def _graph(self, method: str, path: str, params: Optional[dict] = None, data: Optional[dict] = None,
               token: Optional[str] = "") -> dict:
        headers = {}
        if token is not None:
            headers["Authorization"] = f"OAuth {token or self.access_token()}"
        response = self.http.request(method, GRAPH + path, params=params, data=data, headers=headers)
        return self._json(response)

    @staticmethod
    def _json(response: httpx.Response) -> dict:
        try:
            data = response.json()
        except ValueError:
            data = {}
        error = data.get("error") if isinstance(data, dict) else None
        if response.status_code >= 400 or error:
            error = error or {}
            retryable = response.status_code >= 500 or error.get("code") in (1, 2, 4, 17, 32, 613, 9007) \
                or bool(error.get("is_transient"))
            message = error.get("error_user_msg") or error.get("message") or response.status_code
            raise PublishError(f"Instagram: {message}", code=str(error.get("code", response.status_code)),
                               retryable=retryable)
        return data

    def publish_reel(self, path: str, caption: str = "", wait_s: float = PROCESS_WAIT_S) -> dict:
        """Upload `path` as a Reel and publish it.

        Returns {"container_id", "media_id"}; media_id is missing when Instagram was
        still processing after `wait_s`, in which case call `finish(container_id)` later.
        """
        token = self.store.load()
        ig_user = token.get("ig_user_id")
        if not ig_user:
            raise PublishError("Not signed in to instagram; run: auth instagram", retryable=False)
        container = self._graph("POST", f"/{ig_user}/media", params={"upload_type": "resumable"},
                                data={"media_type": "REELS", "caption": caption[:2200]})
        upload_uri = require_host(container.get("uri", ""), "facebook.com")
        size = os.path.getsize(path)
        with open(path, "rb") as f:
            response = self.http.post(upload_uri, content=f.read(), headers={
                "Authorization": f"OAuth {self.access_token()}", "offset": "0", "file_size": str(size),
            })
        if not self._json(response).get("success"):
            raise PublishError("Instagram upload was not accepted")
        result = {"container_id": container["id"]}
        result.update(self.finish(container["id"], wait_s))
        return result

    def finish(self, container_id: str, wait_s: float = PROCESS_WAIT_S) -> dict:
        """Publish the container once processed: {"media_id"}, {} if still processing."""
        deadline = time.monotonic() + wait_s
        while True:
            status = self._graph("GET", f"/{container_id}", params={"fields": "status_code,status"})
            code = status.get("status_code")
            if code == "FINISHED":
                break
            if code in ("ERROR", "EXPIRED"):
                raise PublishError(f"Instagram processing {code.lower()}: {status.get('status', '')}",
                                   retryable=False)
            if code == "PUBLISHED" or time.monotonic() >= deadline:
                return {}
            time.sleep(POLL_S)
        ig_user = self.store.load()["ig_user_id"]
        published = self._graph("POST", f"/{ig_user}/media_publish", data={"creation_id": container_id})
        return {"media_id": published["id"]}

    def permalink(self, media_id: str) -> str:
        return self._graph("GET", f"/{media_id}", params={"fields": "permalink"}).get("permalink", "")
