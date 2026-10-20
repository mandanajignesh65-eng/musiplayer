# Sets up the Music Player downloader on this PC. Safe to run again (it also updates yt-dlp).
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$root = Split-Path $here -Parent
$venv = Join-Path $root ".venv"

if (-not (Test-Path $venv)) { python -m venv $venv }
& "$venv\Scripts\python.exe" -m pip install --quiet --upgrade pip
& "$venv\Scripts\python.exe" -m pip install --quiet --upgrade -r "$here\requirements.txt"

# Sign in to Google once. The browser opens.
& "$venv\Scripts\python.exe" "$here\musicsync.py" --login

# Start the downloader with Windows, hidden in the tray.
$startup = [Environment]::GetFolderPath("Startup")
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut("$startup\Music Player Sync.lnk")
$link.TargetPath = "$venv\Scripts\pythonw.exe"
$link.Arguments = "`"$here\musicsync.py`""
$link.WorkingDirectory = $here
$link.Save()

Start-Process "$venv\Scripts\pythonw.exe" -ArgumentList "`"$here\musicsync.py`"" -WorkingDirectory $here
Write-Host "Done. Look for the orange music icon near the clock."
