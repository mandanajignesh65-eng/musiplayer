"""Music Player Sync: waits quietly in the Windows tray and downloads songs when you press Sync.

    pythonw musicsync.py           run in the tray (this is what starts with Windows)
    python  musicsync.py --login   sign in to Google
    python  musicsync.py --once    run one sync now and print what happens
"""
import json
import logging
import socket
import sys
import threading
import time
import webbrowser
from pathlib import Path

from drive import APP_DIR, Drive, credentials
from sync import now, run_sync

POLL_SECONDS = 30
HEARTBEAT_SECONDS = 300
SETTINGS_FILE = Path(__file__).with_name("settings.json")

APP_DIR.mkdir(parents=True, exist_ok=True)
LOG_FILE = APP_DIR / "sync.log"
logging.basicConfig(filename=LOG_FILE, level=logging.INFO, format="%(asctime)s %(message)s", encoding="utf-8")
log = logging.getLogger("musicsync")


def settings():
    return json.loads(SETTINGS_FILE.read_text(encoding="utf-8")) if SETTINGS_FILE.exists() else {}


class Worker:
    """Does all Drive work on one background thread, so the tray menu never freezes."""

    def __init__(self, on_change):
        self.on_change = on_change
        self.wake = threading.Event()
        self.manual = False
        self.state = "Starting"
        self.drive = None
        self.last_status = {}

    def request_sync(self):
        self.manual = True
        self.wake.set()

    def set_state(self, text):
        self.state = text
        self.on_change(text)

    def loop(self):
        last_beat = 0
        while True:
            try:
                if self.drive is None:
                    self.drive = Drive(credentials())
                    self.last_status = self.drive.read_json("sync-status.json", {})
                request = self.drive.read_json("sync-request.json", {}).get("requestedAt")
                asked_from_app = request and request != self.last_status.get("handledRequest")
                if self.manual or asked_from_app:
                    self.manual = False
                    self.sync(request)
                    last_beat = time.time()
                elif time.time() - last_beat > HEARTBEAT_SECONDS:
                    # Lets the app show "PC last seen at ..." so you know whether Sync will start soon.
                    self.last_status["pcSeenAt"] = now()
                    self.drive.write_json("sync-status.json", self.last_status)
                    last_beat = time.time()
                    if self.state.startswith(("Starting", "Problem")):
                        self.set_state("Waiting for Sync")
            except Exception as err:
                log.exception("loop error")
                self.drive = None
                self.set_state(f"Problem: {str(err)[:80]}")
            self.wake.wait(POLL_SECONDS)
            self.wake.clear()

    def sync(self, request):
        log.info("sync started")

        def progress(status):
            status["handledRequest"] = request
            status["pcSeenAt"] = now()
            self.last_status = status
            self.drive.write_json("sync-status.json", status)
            self.set_state(f"Syncing {status['done']}/{status['total']}")

        try:
            status = run_sync(self.drive, progress, log.info)
            text = f"Sync done: {status['added']} new songs"
            if status["errors"]:
                text += f", {len(status['errors'])} failed"
        except Exception as err:
            log.exception("sync failed")
            self.last_status.update(state="failed", finishedAt=now(), current=None,
                                    handledRequest=request, message=str(err)[:300])
            self.drive.write_json("sync-status.json", self.last_status)
            text = f"Sync failed: {str(err)[:80]}"
        log.info(text)
        self.set_state(text)
        return text


def tray():
    import pystray
    from PIL import Image, ImageDraw

    # Only one copy may run. A second copy finds the port taken and exits.
    lock = socket.socket()
    try:
        lock.bind(("127.0.0.1", 47811))
    except OSError:
        return

    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((2, 2, 62, 62), 14, fill=(232, 93, 63))
    d.ellipse((14, 38, 32, 54), fill="white")
    d.rectangle((28, 12, 33, 46), fill="white")
    d.polygon([(28, 12), (50, 18), (50, 26), (33, 21)], fill="white")

    icon = pystray.Icon("MusicPlayerSync", img, "Music Player Sync")

    def changed(text):
        icon.title = f"Music Player Sync - {text}"
        if text.startswith("Sync "):
            icon.notify(text, "Music Player Sync")

    worker = Worker(changed)
    app_url = settings().get("app_url")
    icon.menu = pystray.Menu(
        pystray.MenuItem(lambda _: worker.state, None, enabled=False),
        pystray.MenuItem("Sync now", lambda: worker.request_sync()),
        pystray.MenuItem("Open player", lambda: webbrowser.open(app_url), visible=bool(app_url)),
        pystray.MenuItem("Open log", lambda: webbrowser.open(LOG_FILE.as_uri())),
        pystray.MenuItem("Quit", lambda: icon.stop()),
    )
    threading.Thread(target=worker.loop, daemon=True).start()
    icon.run()


def main():
    args = sys.argv[1:]
    if "--login" in args:
        credentials(interactive=True)
        print("Signed in. The downloader can reach your Google Drive now.")
    elif "--once" in args:
        drive = Drive(credentials())
        result = run_sync(drive, lambda s: print(f"{s['done']}/{s['total']} {s.get('current') or ''}"), print)
        drive.write_json("sync-status.json", {**result, "pcSeenAt": now(),
                                              "handledRequest": drive.read_json("sync-request.json", {}).get("requestedAt")})
        print(json.dumps(result, indent=1, ensure_ascii=False))
    else:
        tray()


if __name__ == "__main__":
    main()
