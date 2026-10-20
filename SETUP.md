# Music Player setup

Two parts:
- **app/** is the player. It is a web app you install from Chrome on Windows and Android.
- **downloader/** runs on your Windows PC. When you press Sync, it downloads songs from your saved links and uploads them to the `Music Player` folder in your Google Drive.

## 1. Create a Google Cloud project (once, about 10 minutes)

1. Open https://console.cloud.google.com and sign in with the Google account that has your Drive storage.
2. Create a new project called `Music Player`.
3. Go to **APIs & Services → Library**, search for **Google Drive API** and click **Enable**.
4. Go to **Google Auth Platform → Branding** and fill in the app name (`Music Player`) and your email.
5. Under **Audience**, choose **External**. Then click **Publish app** so the app is "In production".
   The app asks only for the `drive.file` permission, which means access only to files it created itself. Google does not review apps that ask only for this, and your sign-in will not end after 7 days.
6. Under **Data access**, add the scope `.../auth/drive.file`.

## 2. Sign-in key for the PC downloader

1. Go to **Google Auth Platform → Clients → Create client**.
2. Choose **Desktop app** and name it `Music Player PC`.
3. Download the JSON file and save it as `downloader\client_secret.json`.

## 3. Sign-in key for the player app

1. **Create client** again, and this time choose **Web application**. Name it `Music Player app`.
2. Under **Authorized redirect URIs**, add both of these addresses:
   - `http://localhost:5173/`
   - the app's online address, once it is online (step 6)
3. Copy the **Client ID** and **Client secret** into `app\config.js`.

## 4. Set up the downloader

In PowerShell, run this from the `D:\musiplayer` folder:

```
powershell -ExecutionPolicy Bypass -File downloader\setup.ps1
```

The script installs everything and opens the browser so you can sign in to Google. It then starts the downloader and sets it to start with Windows. Look for the orange music icon near the clock.
Run the script again any time songs stop downloading. It updates yt-dlp, the tool that downloads from YouTube, and YouTube changes often.

## 5. Try the app on your PC

```
.venv\Scripts\python.exe -m http.server 5173 -d app
```

Open http://localhost:5173/, sign in, open **Add songs**, paste a playlist link, then press **Sync now**.

## 6. Put the app online and install it on Android

The GitHub repository is private, and free GitHub Pages hosting needs a public repository, so the app will be hosted on a free service that works with private repositories, such as Cloudflare Pages. This step is still to do.

1. Add the app's online address to the web client's **Authorized redirect URIs** (step 3).
2. Copy `downloader\settings.example.json` to `downloader\settings.json` and fill in the app address. The tray menu's "Open player" then opens it.
3. On your Android phone, open the app address in Chrome, then tap **⋮ → Install app** (or **Add to Home screen**).

## Limits to know

- **Spotify:** only the first 100 songs of a Spotify playlist are read. Split bigger playlists, or use a YouTube Music playlist.
- **YouTube Music:** private playlists and "Liked music" cannot be read. Set the playlist to Unlisted or Public.
- **Spotify matches:** each Spotify song is found again on YouTube Music. A match can sometimes be a different version, such as a live or remix version.
- **Errors:** songs that fail are listed under **Sync** in the app. The full log is in `%APPDATA%\MusicPlayerSync\sync.log`.
