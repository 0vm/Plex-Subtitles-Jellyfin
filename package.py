"""Build the plugin zip and keep manifest.json up to date.

Usage:
  python package.py build <version>
      Builds the plugin and writes dist/plex-subtitles-jellyfin_<version>.zip

  python package.py manifest <version> <download_base_url> [changelog]
      Adds (or replaces) <version> in manifest.json, pointing at
      <download_base_url>/plex-subtitles-jellyfin_<version>.zip, with the zip's checksum.

  python package.py all <version> <download_base_url> [changelog]
      Both of the above.

<version> has four parts, for example 1.0.1.0.
"""
import datetime
import hashlib
import json
import os
import shutil
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.join(ROOT, "src", "Jellyfin.Plugin.SubtitleCustomiser")
DIST = os.path.join(ROOT, "dist")
MANIFEST = os.path.join(ROOT, "manifest.json")

GUID = "3c1f6a5e-8d2b-4f7a-9b61-5c2e7d9a4f18"
NAME = "Plex Subtitles Jellyfin"
OWNER = "0vm"
REPO = "plex-subtitles-jellyfin"
CATEGORY = "General"
TARGET_ABI = "12.0.0.0"
IMAGE_URL = f"https://raw.githubusercontent.com/{OWNER}/{REPO}/refs/heads/main/logo.png"
DESCRIPTION = (
    "🎬 Plex style subtitle settings for the Jellyfin web player. Click the CC button during playback "
    "and change everything live from a Plex-like panel. "
    "★ Tracks: pick the subtitle track and an optional secondary track. "
    "★ Look: colour (9 choices), size (Tiny to Huge), position (Bottom, Raised, Middle, Top) and style "
    "(Drop Shadow, Outline, Box, Plain). "
    "★ Timing: subtitle offset in 100 ms and 1 s steps, positive means later, like Plex. "
    "★ Controls aware: bottom subtitles rise above the control bar while it is showing. "
    "★ Per user: each user's choices are saved in their browser, with server-wide defaults on the settings page. "
    "★ Self-contained: no File Transformation or JavaScript Injector needed, and nothing on disk is changed, "
    "so it works with read-only web folders (Docker, TrueNAS). "
    "⚠ Note: styles apply to text subtitles (SRT, VTT). ASS/SSA and image subtitles (PGS, VobSub) keep their own look, "
    "and burned-in subtitles cannot be restyled."
)
OVERVIEW = "Plex style subtitle panel for the Jellyfin web player: track, colour, size, position, style and offset from the CC button"
DEFAULT_CHANGELOG = f"See https://github.com/{OWNER}/{REPO}/releases"


def find_dotnet():
    candidates = [
        os.environ.get("DOTNET"),
        shutil.which("dotnet"),
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Microsoft", "dotnet", "dotnet.exe"),
    ]
    for candidate in candidates:
        if not candidate or not os.path.exists(candidate):
            continue
        # A dotnet install can be runtime only; use the first one with a .NET 10 SDK.
        result = subprocess.run([candidate, "--list-sdks"], capture_output=True, text=True)
        if any(line.startswith("10.") for line in result.stdout.splitlines()):
            return candidate
    sys.exit("Could not find the .NET 10 SDK (dotnet).")


def zip_path(version):
    return os.path.join(DIST, f"plex-subtitles-jellyfin_{version}.zip")


def build(version):
    short = ".".join(version.split(".")[:3])
    subprocess.run(
        [find_dotnet(), "build", "-c", "Release", "-nologo", "-v", "q",
         f"-p:AssemblyVersion={version}", f"-p:FileVersion={version}", f"-p:Version={short}"],
        cwd=PROJECT, check=True)

    dll = os.path.join(PROJECT, "bin", "Release", "net10.0", "Jellyfin.Plugin.SubtitleCustomiser.dll")
    os.makedirs(DIST, exist_ok=True)
    path = zip_path(version)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.write(dll, "Jellyfin.Plugin.SubtitleCustomiser.dll")
    print(f"built {os.path.relpath(path, ROOT)}")


def update_manifest(version, base_url, changelog):
    path = zip_path(version)
    if not os.path.exists(path):
        sys.exit(f"{os.path.relpath(path, ROOT)} does not exist; run the build step first.")
    with open(path, "rb") as f:
        checksum = hashlib.md5(f.read()).hexdigest()

    versions = []
    if os.path.exists(MANIFEST):
        with open(MANIFEST, encoding="utf-8") as f:
            existing = json.load(f)
        if existing:
            versions = [v for v in existing[0].get("versions", []) if v["version"] != version]

    versions.append({
        "version": version,
        "changelog": (changelog or DEFAULT_CHANGELOG).strip(),
        "targetAbi": TARGET_ABI,
        "sourceUrl": f"{base_url.rstrip('/')}/plex-subtitles-jellyfin_{version}.zip",
        "checksum": checksum,
        "timestamp": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    })
    versions.sort(key=lambda v: [int(p) for p in v["version"].split(".")], reverse=True)

    manifest = [{
        "guid": GUID,
        "name": NAME,
        "description": DESCRIPTION,
        "overview": OVERVIEW,
        "owner": OWNER,
        "category": CATEGORY,
        "imageUrl": IMAGE_URL,
        "versions": versions,
    }]
    with open(MANIFEST, "w", encoding="utf-8", newline="\n") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"manifest.json now lists {', '.join(v['version'] for v in versions)} (md5 {checksum})")


def main():
    if len(sys.argv) < 3 or sys.argv[1] not in ("build", "manifest", "all"):
        sys.exit(__doc__)
    command, version = sys.argv[1], sys.argv[2]
    if len(version.split(".")) != 4:
        sys.exit("Use a four part version, for example 1.0.1.0")
    if command in ("build", "all"):
        build(version)
    if command in ("manifest", "all"):
        if len(sys.argv) < 4:
            sys.exit("The manifest step needs the download base URL.")
        update_manifest(version, sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else "")


if __name__ == "__main__":
    main()
