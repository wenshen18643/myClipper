"""Command line for publishing.

  python -m clip_engine.publishing setup-youtube <client_secret.json>
  python -m clip_engine.publishing setup-tiktok --client-key KEY      (asks for the secret)
  python -m clip_engine.publishing setup-instagram --app-id ID [--config-id CFG]   (asks for the secret)
  python -m clip_engine.publishing auth youtube|tiktok|instagram [--no-browser]
  python -m clip_engine.publishing run <queue.json> [--dry-run] [--only youtube|tiktok|instagram]
  python -m clip_engine.publishing status <queue.json>
  python -m clip_engine.publishing upload-youtube <file> --title T [--description D] [--publish-at ISO]
  python -m clip_engine.publishing draft-tiktok <file>
  python -m clip_engine.publishing post-instagram <file> [--caption C]
"""

import argparse
import getpass
import os
import shutil
import sys
from datetime import datetime, timezone

from clip_engine.publishing import queue as posting_queue
from clip_engine.publishing.client import PublishError
from clip_engine.publishing.instagram import InstagramClient
from clip_engine.publishing.store import load_config, publishing_dir, save_config
from clip_engine.publishing.tiktok import TikTokClient
from clip_engine.publishing.youtube import YouTubeClient, load_client_secret

def youtube_client() -> YouTubeClient:
    path = load_config().get("youtube", {}).get("client_secret_file")
    if not path:
        raise PublishError("YouTube isn't set up; run: setup-youtube <client_secret.json>", retryable=False)
    return YouTubeClient(*load_client_secret(path))

def tiktok_client() -> TikTokClient:
    cfg = load_config().get("tiktok", {})
    secret = os.environ.get("TIKTOK_CLIENT_SECRET") or cfg.get("client_secret")
    if not (cfg.get("client_key") and secret):
        raise PublishError("TikTok isn't set up; run: setup-tiktok --client-key KEY", retryable=False)
    return TikTokClient(cfg["client_key"], secret, redirect_port=int(cfg.get("redirect_port", 0)),
                        pkce_hex=cfg.get("pkce", "hex") == "hex")

def instagram_client() -> InstagramClient:
    cfg = load_config().get("instagram", {})
    secret = os.environ.get("INSTAGRAM_APP_SECRET") or cfg.get("app_secret")
    if not (cfg.get("app_id") and secret):
        raise PublishError("Instagram isn't set up; run: setup-instagram --app-id ID", retryable=False)
    return InstagramClient(cfg["app_id"], secret, config_id=cfg.get("config_id", ""))

CLIENTS = {"youtube": youtube_client, "tiktok": tiktok_client, "instagram": instagram_client}

def main(argv=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m clip_engine.publishing", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("setup-youtube"); p.add_argument("client_secret")
    p = sub.add_parser("setup-tiktok"); p.add_argument("--client-key", required=True)
    p.add_argument("--port", type=int, default=0, help="fixed callback port (default: any, register 127.0.0.1:*)")
    p.add_argument("--pkce", choices=("hex", "base64"), default="hex")
    p = sub.add_parser("setup-instagram"); p.add_argument("--app-id", required=True)
    p.add_argument("--config-id", default="", help="Facebook Login for Business configuration ID, if the app uses one")
    p = sub.add_parser("auth"); p.add_argument("platform", choices=tuple(CLIENTS))
    p.add_argument("--no-browser", action="store_true", help="only print the sign-in link")
    p = sub.add_parser("run"); p.add_argument("queue"); p.add_argument("--dry-run", action="store_true")
    p.add_argument("--only", choices=tuple(CLIENTS))
    p = sub.add_parser("status"); p.add_argument("queue")
    p = sub.add_parser("upload-youtube"); p.add_argument("file"); p.add_argument("--title", required=True)
    p.add_argument("--description", default=""); p.add_argument("--publish-at")
    p.add_argument("--private", action="store_true", help="keep it private (for tests)")
    p = sub.add_parser("draft-tiktok"); p.add_argument("file")
    p = sub.add_parser("post-instagram"); p.add_argument("file"); p.add_argument("--caption", default="")
    args = parser.parse_args(argv)

    try:
        if args.command == "setup-youtube":
            load_client_secret(args.client_secret)
            target = publishing_dir() / "youtube-client-secret.json"
            shutil.copyfile(args.client_secret, target)
            config = load_config(); config["youtube"] = {"client_secret_file": str(target)}; save_config(config)
            print(f"Saved. Next: auth youtube   (settings in {publishing_dir()})")
        elif args.command == "setup-tiktok":
            secret = getpass.getpass("TikTok client secret (input hidden): ").strip()
            config = load_config()
            config["tiktok"] = {"client_key": args.client_key, "client_secret": secret,
                                "redirect_port": args.port, "pkce": args.pkce}
            save_config(config)
            print(f"Saved. Next: auth tiktok   (settings in {publishing_dir()})")
        elif args.command == "setup-instagram":
            secret = getpass.getpass("Meta app secret (input hidden): ").strip()
            config = load_config()
            config["instagram"] = {"app_id": args.app_id, "app_secret": secret, "config_id": args.config_id}
            save_config(config)
            print(f"Saved. Next: auth instagram   (settings in {publishing_dir()})")
        elif args.command == "auth":
            client = CLIENTS[args.platform]()
            client.authorize(open_browser=not args.no_browser)
            print(f"Signed in to {args.platform}.")
        elif args.command in ("run", "status"):
            queue = posting_queue.load_queue(args.queue)
            if args.command == "status":
                print("\n".join(posting_queue.summary(queue)))
                return 0
            clients = {}
            for name, make in CLIENTS.items():
                if args.only in (None, name):
                    try:
                        clients[name] = make()
                    except PublishError:
                        if args.only:
                            raise
            if not clients:
                raise PublishError("No platform is set up yet", retryable=False)
            log = posting_queue.run_due(
                queue, os.path.dirname(os.path.abspath(args.queue)), datetime.now(timezone.utc),
                youtube=clients.get("youtube"), tiktok=clients.get("tiktok"), instagram=clients.get("instagram"),
                save=lambda: posting_queue.save_queue(args.queue, queue), dry_run=args.dry_run,
            )
            stamp = datetime.now().strftime("%Y-%m-%d %H:%M")
            print("\n".join(f"{stamp}  {line}" for line in log) or f"{stamp}  nothing due")
        elif args.command == "upload-youtube":
            when = posting_queue.parse_time(args.publish_at) if args.publish_at else None
            video = youtube_client().upload(args.file, args.title, args.description, publish_at=when,
                                            private=args.private)
            print(f"Uploaded: https://youtube.com/shorts/{video.get('id')}  status: {video.get('status')}")
        elif args.command == "draft-tiktok":
            print(f"Sent to your TikTok inbox (publish_id {tiktok_client().send_draft(args.file)}).")
        elif args.command == "post-instagram":
            client = instagram_client()
            result = client.publish_reel(args.file, args.caption)
            if result.get("media_id"):
                print(f"Posted: {client.permalink(result['media_id']) or result['media_id']}")
            else:
                print(f"Uploaded; Instagram is still processing container {result['container_id']}.")
    except PublishError as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1
    return 0

if __name__ == "__main__":
    sys.exit(main())
