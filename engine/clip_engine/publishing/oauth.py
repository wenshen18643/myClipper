"""OAuth 2.0 authorization code flow with PKCE and a loopback redirect (desktop sign-in)."""

import base64
import hashlib
import html
import http.server
import secrets
import time
import urllib.parse
import webbrowser
from typing import Callable, Optional

CALLBACK_PATH = "/callback/"

class OAuthError(RuntimeError):
    pass

def pkce_pair(hex_challenge: bool = False) -> tuple[str, str]:
    """(code_verifier, code_challenge) for S256.

    RFC 7636 encodes the challenge as base64url (Google). TikTok's desktop flow
    documents a hex-encoded SHA-256 instead, hence `hex_challenge`.
    """
    verifier = secrets.token_urlsafe(72)[:96]
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = digest.hex() if hex_challenge else base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return verifier, challenge

def receive_code(
    build_auth_url: Callable[[str, str], str],
    port: int = 0,
    timeout_s: float = 300,
    open_browser: bool = True,
    host: str = "127.0.0.1",
) -> tuple[str, str]:
    """Sign the user in through their browser and return (code, redirect_uri).

    `build_auth_url(redirect_uri, state)` returns the consent page URL. A
    one-shot server on 127.0.0.1 receives the redirect; the state must match.
    """
    state = secrets.token_urlsafe(24)
    result: dict[str, Optional[str]] = {}

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 - http.server API
            parsed = urllib.parse.urlsplit(self.path)
            if parsed.path.rstrip("/") != CALLBACK_PATH.rstrip("/"):
                self.send_error(404)
                return
            query = urllib.parse.parse_qs(parsed.query)
            if query.get("state", [None])[0] != state:
                result["error"] = "state mismatch"
            elif "error" in query:
                result["error"] = query.get("error_description", query["error"])[0]
            else:
                result["code"] = query.get("code", [None])[0]
            message = "Signed in. You can close this tab." if result.get("code") else \
                f"Sign-in failed: {html.escape(str(result.get('error')))}"
            body = f"<html><body style='font-family:sans-serif'><p>{message}</p></body></html>".encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_):
            pass

    server = http.server.HTTPServer(("127.0.0.1", port), Handler)
    server.timeout = 1
    try:
        redirect_uri = f"http://{host}:{server.server_address[1]}{CALLBACK_PATH}"
        url = build_auth_url(redirect_uri, state)
        print(f"Open this page to sign in (it should open automatically):\n{url}", flush=True)
        if open_browser:
            webbrowser.open(url)
        deadline = time.monotonic() + timeout_s
        while not result and time.monotonic() < deadline:
            server.handle_request()
    finally:
        server.server_close()
    if result.get("code"):
        return result["code"], redirect_uri
    raise OAuthError(result.get("error") or "Timed out waiting for sign-in")
