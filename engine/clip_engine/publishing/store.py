"""Where publishing settings and tokens are kept: outside the repo, per user.

Default: %APPDATA%\\myClipper\\publishing (or ~/.myclipper/publishing);
MYCLIPPER_PUBLISHING_DIR overrides it.
"""

import json
import os
import tempfile
from pathlib import Path
from typing import Any


def publishing_dir() -> Path:
    override = os.environ.get("MYCLIPPER_PUBLISHING_DIR")
    if override:
        base = Path(override)
    elif os.environ.get("APPDATA"):
        base = Path(os.environ["APPDATA"]) / "myClipper" / "publishing"
    else:
        base = Path.home() / ".myclipper" / "publishing"
    base.mkdir(parents=True, exist_ok=True)
    return base


def read_json(path: Path, default: Any = None) -> Any:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def write_json(path: Path, data: Any) -> None:
    """Atomic write, so a crash never leaves a half-written token or queue."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


class TokenStore:
    """One platform's tokens as JSON in the publishing directory."""

    def __init__(self, platform: str, directory: Path | None = None):
        self.path = (directory or publishing_dir()) / f"{platform}-token.json"

    def load(self) -> dict:
        return read_json(self.path, {}) or {}

    def save(self, token: dict) -> None:
        write_json(self.path, token)


def load_config() -> dict:
    return read_json(publishing_dir() / "config.json", {}) or {}


def save_config(config: dict) -> None:
    write_json(publishing_dir() / "config.json", config)
