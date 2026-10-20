"""One sync: read the saved links, download songs that are not in Drive yet, upload them, update the song list."""
import re
import tempfile
import traceback
from datetime import datetime, timezone

import sources

SINGLES = "Singles"


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def safe_name(text):
    text = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", text).strip(" .")
    return text[:150] or "Untitled"


def run_sync(drive, on_progress=lambda status: None, log=print):
    links = drive.read_json("sources.json", [])
    lib = drive.read_json("library.json", None) or {"tracks": {}, "spotify": {}, "playlists": []}
    tracks, spotify = lib["tracks"], lib["spotify"]
    status = {"state": "running", "startedAt": now(), "finishedAt": None, "total": 0, "done": 0,
              "added": 0, "current": "Reading your links", "errors": []}
    on_progress(status)

    def fail(link, song, err):
        log(f"FAILED {song or link}: {err}")
        status["errors"].append({"link": link, "song": song, "error": str(err)[:300]})

    plans = []
    for link in links:
        try:
            name, items = sources.list_link(link["url"])
            plans.append((link, name, items))
        except Exception as err:
            fail(link["url"], None, err)

    def is_new(item):
        key = spotify.get(item["key"], item["key"])
        return key not in tracks

    status["total"] = len({i["key"] for _, _, items in plans for i in items if is_new(i)})
    on_progress(status)

    with tempfile.TemporaryDirectory(prefix="musicsync-") as tmp:
        for link, name, items in plans:
            # A link to one song goes in the group named in the app ("# Focus" above it), or in Singles.
            playlist_name = name or link.get("group") or SINGLES
            folder_id = drive.folder(safe_name(playlist_name), drive.root())
            keys = []
            for item in items:
                label = item.get("title") or item.get("video_id")
                try:
                    added = status["added"]
                    key = _ensure_track(drive, item, folder_id, tmp, tracks, spotify, status, on_progress)
                    if key not in keys:
                        keys.append(key)
                    if status["added"] > added:
                        # Saved after every new song, so the app shows it right away and a crash loses nothing.
                        lib["updatedAt"] = now()
                        drive.write_json("library.json", lib)
                except Exception as err:
                    log(traceback.format_exc())
                    if "not a bot" in str(err):
                        # YouTube is blocking this PC for a while. Going on would only make the block longer.
                        raise RuntimeError("YouTube asked to confirm you're not a bot, so the sync stopped. "
                                           "Songs done so far are saved. Press Sync again in a few hours.") from err
                    fail(link["url"], label, err)
                    status["done"] += 1
                    on_progress(status)
            entry = {"sourceId": link["id"], "url": link["url"], "name": playlist_name,
                     "single": name is None, "tracks": keys}
            lib["playlists"] = [p for p in lib["playlists"] if p["sourceId"] != link["id"]] + [entry]
            lib["updatedAt"] = now()
            drive.write_json("library.json", lib)

    # A removed link's playlist goes away. Its songs stay in Drive and in "All songs".
    link_ids = {link["id"] for link in links}
    lib["playlists"] = [p for p in lib["playlists"] if p["sourceId"] in link_ids]
    lib["updatedAt"] = now()
    drive.write_json("library.json", lib)

    status.update(state="done", finishedAt=now(), current=None)
    on_progress(status)
    return status


def _ensure_track(drive, item, folder_id, tmp, tracks, spotify, status, on_progress):
    """Makes sure one song is in Drive and in the song list. Returns its key, like "yt:VIDEO_ID"."""
    key = item["key"]
    if key.startswith("sp:"):
        if spotify.get(key) in tracks:
            return spotify[key]
        status["current"] = f"{', '.join(item['artists'])} - {item['title']}"
        on_progress(status)
        video_id, cover, album = sources.find_on_youtube(item)
        yt_key = f"yt:{video_id}"
        spotify[key] = yt_key
        if yt_key in tracks:
            status["done"] += 1
            return yt_key
        path, details = sources.download(video_id, tmp)
        title, artist = item["title"], ", ".join(item["artists"])
        album = album or details["album"]
    else:
        video_id, yt_key = item["video_id"], key
        if yt_key in tracks:
            return yt_key
        status["current"] = video_id
        on_progress(status)
        path, details = sources.download(video_id, tmp)
        title, artist, album = details["title"], details["artist"], details["album"]
        cover = sources.cover_for(video_id)

    status["current"] = f"{artist} - {title}"
    on_progress(status)
    sources.write_tags(path, title, artist, album)
    file_id = drive.upload(path, safe_name(f"{artist} - {title}") + ".m4a", folder_id)
    path.unlink(missing_ok=True)
    tracks[yt_key] = {"id": yt_key, "fileId": file_id, "title": title, "artist": artist, "album": album,
                      "duration": details["duration"], "cover": cover, "addedAt": now()}
    status["done"] += 1
    status["added"] += 1
    on_progress(status)
    return yt_key
