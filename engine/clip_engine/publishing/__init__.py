"""Publish finished clips through the platforms' official APIs.

YouTube: resumable upload with scheduled publishing (videos.insert).
TikTok: upload to the creator's inbox as a draft (Content Posting API, video.upload);
the creator finishes the post in the TikTok app. TikTok's guidelines do not allow
direct-posting tools for accounts you manage, so drafts are the supported path.

Credentials and tokens live in the publishing directory (see store.py), never in the repo.
"""
