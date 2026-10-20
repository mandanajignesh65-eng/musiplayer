"""Reads song lists from YouTube, YouTube Music and Spotify links, and downloads songs from YouTube."""
import json
import re
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import imageio_ffmpeg
import requests
import yt_dlp
from mutagen.mp4 import MP4
from ytmusicapi import YTMusic

YDL_BASE = {"quiet": True, "no_warnings": True, "js_runtimes": {"node": {}}}
_ytmusic = None


def _yt_music():
    global _ytmusic
    if _ytmusic is None:
        _ytmusic = YTMusic()
    return _ytmusic


def cover_for(video_id):
    return f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"


def list_link(url):
    """Returns (name, items). name is None for a link to one song.

    Each item is a dict with "key" and either "video_id" (YouTube) or Spotify details to search for.
    """
    host = urlparse(url).netloc.lower()
    if "spotify.com" in host:
        return _list_spotify(url)
    if "youtube.com" in host or "youtu.be" in host:
        return _list_youtube(url)
    raise ValueError("Not a YouTube, YouTube Music or Spotify link")


def _list_youtube(url):
    # A link to one video already holds its id, so it needs no call to YouTube. This keeps big syncs fast.
    parsed = urlparse(url)
    query = parse_qs(parsed.query)
    if "list" not in query:
        video_id = query.get("v", [None])[0] or (parsed.path.strip("/") if "youtu.be" in parsed.netloc else None)
        if video_id and re.fullmatch(r"[\w-]{11}", video_id):
            return None, [{"key": f"yt:{video_id}", "video_id": video_id}]
    with yt_dlp.YoutubeDL({**YDL_BASE, "extract_flat": "in_playlist"}) as ydl:
        info = ydl.extract_info(url, download=False)
    if info.get("_type") == "playlist":
        items = [{"key": f"yt:{e['id']}", "video_id": e["id"]} for e in info.get("entries") or [] if e and e.get("id")]
        return info.get("title") or "YouTube playlist", items
    return None, [{"key": f"yt:{info['id']}", "video_id": info["id"]}]


def _spotify_entity(kind, sid):
    # The public embed page holds the song list as JSON, so no Spotify account or key is needed.
    page = requests.get(f"https://open.spotify.com/embed/{kind}/{sid}",
                        headers={"User-Agent": "Mozilla/5.0"}, timeout=30)
    page.raise_for_status()
    m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', page.text, re.S)
    if not m:
        raise RuntimeError("Could not read the Spotify page. Spotify may have changed it.")
    return json.loads(m.group(1))["props"]["pageProps"]["state"]["data"]["entity"]


def _list_spotify(url):
    m = re.search(r"/(playlist|album|track)/([A-Za-z0-9]+)", urlparse(url).path)
    if not m:
        raise ValueError("Use a Spotify playlist, album or song link")
    kind, sid = m.groups()
    ent = _spotify_entity(kind, sid)
    if kind == "track":
        artists = [a["name"] for a in ent.get("artists") or []]
        return None, [_spotify_item(sid, ent.get("name") or ent.get("title"), artists, ent.get("duration"))]
    items = []
    for t in ent.get("trackList") or []:
        tid = t.get("uri", "").rsplit(":", 1)[-1]
        artists = [a.strip() for a in (t.get("subtitle") or "").replace(" ", " ").split(",") if a.strip()]
        items.append(_spotify_item(tid, t.get("title"), artists, t.get("duration")))
    return ent.get("name") or ent.get("title") or "Spotify playlist", items


def _spotify_item(tid, title, artists, duration_ms):
    return {"key": f"sp:{tid}", "spotify_id": tid, "title": title or "", "artists": artists,
            "duration": round((duration_ms or 0) / 1000)}


def find_on_youtube(item):
    """Finds the YouTube Music song that best matches a Spotify song. Returns its video id and cover."""
    query = f"{', '.join(item['artists'])} {item['title']}"
    results = [r for r in _yt_music().search(query, filter="songs", limit=5) if r.get("videoId")][:5]
    if not results:
        raise RuntimeError(f"No match on YouTube Music for: {query}")
    want = item["duration"]
    best = min(results, key=lambda r: abs((r.get("duration_seconds") or 0) - want)) if want else results[0]
    if want and abs((best.get("duration_seconds") or 0) - want) > 15:
        best = results[0]
    cover = best["thumbnails"][-1]["url"] if best.get("thumbnails") else cover_for(best["videoId"])
    cover = re.sub(r"=w\d+-h\d+", "=w544-h544", cover)
    album = (best.get("album") or {}).get("name") or ""
    return best["videoId"], cover, album


def download(video_id, out_dir):
    """Downloads one song as an .m4a file with its cover picture inside. Returns (path, details)."""
    opts = {
        **YDL_BASE,
        "format": "bestaudio[ext=m4a]/bestaudio",
        "outtmpl": str(Path(out_dir) / "%(id)s.%(ext)s"),
        "ffmpeg_location": imageio_ffmpeg.get_ffmpeg_exe(),
        "writethumbnail": True,
        "noplaylist": True,
        # Pauses between songs, so YouTube does not mistake a big sync for a bot.
        "sleep_interval": 4,
        "max_sleep_interval": 10,
        "sleep_interval_requests": 1,
        "postprocessors": [
            {"key": "FFmpegExtractAudio", "preferredcodec": "m4a"},
            {"key": "FFmpegThumbnailsConvertor", "format": "jpg"},
            {"key": "EmbedThumbnail"},
        ],
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=True)
    path = Path(info["requested_downloads"][0]["filepath"])
    title, artist = info.get("track"), ", ".join(info.get("artists") or [])
    if not title:
        # A plain YouTube video: its title is often "Artist - Song (Official Video)".
        title = re.sub(r"\s*[(\[][^)\]]*(official|video|audio|lyric|remaster|visuali[sz]er|\bhd\b|\b4k\b)[^)\]]*[)\]]",
                       "", info.get("title") or video_id, flags=re.I).strip()
        if " - " in title:
            artist, title = (part.strip() for part in title.split(" - ", 1))
    if not artist:
        artist = re.sub(r" - Topic$", "", info.get("uploader") or info.get("channel") or "")
    details = {
        "title": title,
        "artist": artist,
        "album": info.get("album") or "",
        "duration": round(info.get("duration") or 0),
    }
    return path, details


def write_tags(path, title, artist, album):
    tags = MP4(str(path))
    tags["\xa9nam"] = title
    tags["\xa9ART"] = artist
    if album:
        tags["\xa9alb"] = album
    tags.save()
