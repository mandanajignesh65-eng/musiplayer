"""Google Drive access for the PC downloader: sign-in, folders, JSON files and song uploads."""
import io
import json
import os
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload, MediaIoBaseUpload

# drive.file only lets this app see files it created itself, not the rest of your Drive.
SCOPES = ["https://www.googleapis.com/auth/drive.file"]
FOLDER = "application/vnd.google-apps.folder"
ROOT_NAME = "Music Player"
APP_DIR = Path(os.environ.get("APPDATA", Path.home())) / "MusicPlayerSync"
TOKEN_FILE = APP_DIR / "token.json"
SECRET_FILE = Path(__file__).with_name("client_secret.json")


def credentials(interactive=False):
    """Load the saved Google sign-in. Opens the browser to sign in only when interactive is True."""
    creds = None
    if TOKEN_FILE.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)
    if creds and creds.valid:
        return creds
    if creds and creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
        except Exception:
            creds = None
    if not (creds and creds.valid):
        if not interactive:
            raise RuntimeError("Not signed in to Google. Run setup.ps1 or 'musicsync.py --login'.")
        if not SECRET_FILE.exists():
            raise RuntimeError(f"Missing {SECRET_FILE.name}. See SETUP.md, step 2.")
        flow = InstalledAppFlow.from_client_secrets_file(str(SECRET_FILE), SCOPES)
        creds = flow.run_local_server(port=0, prompt="consent")
    APP_DIR.mkdir(parents=True, exist_ok=True)
    TOKEN_FILE.write_text(creds.to_json())
    return creds


def _q(text):
    return text.replace("\\", "\\\\").replace("'", "\\'")


class Drive:
    def __init__(self, creds):
        self.api = build("drive", "v3", credentials=creds, cache_discovery=False)
        self._folders = {}

    def find(self, name, parent, folder=False):
        q = f"name = '{_q(name)}' and '{parent}' in parents and trashed = false"
        if folder:
            q += f" and mimeType = '{FOLDER}'"
        res = self.api.files().list(q=q, fields="files(id)", pageSize=1, spaces="drive").execute()
        files = res.get("files", [])
        return files[0]["id"] if files else None

    def folder(self, name, parent="root"):
        key = (name, parent)
        if key not in self._folders:
            fid = self.find(name, parent, folder=True)
            if not fid:
                meta = {"name": name, "mimeType": FOLDER, "parents": [parent]}
                fid = self.api.files().create(body=meta, fields="id").execute()["id"]
            self._folders[key] = fid
        return self._folders[key]

    def root(self):
        return self.folder(ROOT_NAME)

    def app_dir(self):
        return self.folder("_app", self.root())

    def read_json(self, name, default):
        fid = self.find(name, self.app_dir())
        if not fid:
            return default
        data = self.api.files().get_media(fileId=fid).execute()
        return json.loads(data.decode("utf-8"))

    def write_json(self, name, data):
        parent = self.app_dir()
        body = io.BytesIO(json.dumps(data, ensure_ascii=False, indent=1).encode("utf-8"))
        media = MediaIoBaseUpload(body, mimetype="application/json")
        fid = self.find(name, parent)
        if fid:
            self.api.files().update(fileId=fid, media_body=media).execute()
        else:
            meta = {"name": name, "parents": [parent]}
            self.api.files().create(body=meta, media_body=media, fields="id").execute()

    def upload(self, path, name, parent):
        media = MediaFileUpload(str(path), mimetype="audio/mp4", resumable=True)
        meta = {"name": name, "parents": [parent]}
        return self.api.files().create(body=meta, media_body=media, fields="id").execute()["id"]
