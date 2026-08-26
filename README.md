# NFC Music Disc player

A framework-free static music player designed for release URLs encoded on NFC tags.

## Test locally

From this folder, run:

```sh
python3 -m http.server 8080
```

Then open <http://localhost:8080/just-friends/>.

The first click on the disc requests fullscreen where supported and starts playback. Later clicks pause, resume, or replay the release.

## Add a release

Start the local release builder:

```sh
node scripts/release-ui.mjs
```

Open <http://127.0.0.1:4173/>. The builder autosaves field values in the
browser and streams selected files into the ignored `.release-drafts/` folder.
AWS, duplicate, upload, or validation failures leave the complete draft intact
so it can be corrected and retried. It supports single- and multi-track
releases, track ordering, lyrics, About text, artist overrides, and force mode.
It does not use AI or deploy the site.
Release dates are optional (`YYYY-MM-DD`). Dated releases appear newest-first in
the discography; releases without a date remain valid and sort after them.

The terminal workflow remains available:

```sh
node scripts/new-release.mjs
```

The script previews the immutable S3 keys, asks before uploading, writes the
release config, generates the page, validates the uploaded assets and metadata,
then prints the local visual-QA link. It does not use AI or deploy the site.
WAV masters are trimmed conservatively at the end before hashing and upload:
samples below -60 dB are treated as silence and 20 ms of safety padding is
retained. Leading silence is preserved for audio/video synchronization. Non-WAV
files are uploaded unchanged when `ffmpeg` is unavailable.
Choose the number of tracks when prompted. A single track keeps the compact
top-level `audio` config; two or more tracks produce a `tracks` array and prompt
for each title, audio file, optional artist override, lyrics, and About text.
If recovering a failed release that already has scaffolding, pass `--force` to
reuse its slug and bypass duplicate warnings.

For multi-line lyrics or a non-interactive multi-track release, pass a JSON
track manifest. Relative audio paths are resolved from the manifest's folder:

```sh
node scripts/new-release.mjs \
  --title "Release title" \
  --artist "Artist name" \
  --artwork "/full/path/artwork.jpg" \
  --tracks "/full/path/tracks.json"
```

```json
[
  {
    "title": "First song",
    "audio": "audio/first-song.wav",
    "lyrics": "First line\nSecond line",
    "about": "Optional notes"
  },
  {
    "title": "Featured song",
    "artist": "Artist name feat. Guest",
    "audio": "audio/featured-song.wav"
  }
]
```

Generated release pages contain only static link-preview metadata and the shared player shell. Player behavior remains centralized in `assets/player.js`; relative asset paths are resolved from each release's config file location.

Do not double-click `index.html`; browsers restrict `fetch()` when a page is opened as a `file://` URL. Use the local server command above.

## Use S3 assets later

The `audio` and `artwork` values may be absolute HTTPS URLs:

```json
{
  "title": "Release title",
  "artist": "Artist name",
  "audio": "https://assets.example.com/releases/my-release/audio.mp3",
  "artwork": "https://assets.example.com/releases/my-release/artwork.webp",
  "edition": "Edition of 100"
}
```

The player samples the artwork in the browser and derives its accent color automatically. `accentColor` remains an optional fallback or deliberate override if artwork sampling is unavailable. Cross-origin S3 artwork requires CORS permission for the player domain so the browser can inspect its pixels.

Configure the S3 bucket or CDN to permit cross-origin `GET` and `HEAD` requests from the player domain. Serve correct content types and support byte-range requests for audio seeking and efficient playback.

## Release files

- `config.json` — release metadata and asset locations
- artwork — square WebP, AVIF, JPEG, PNG, or SVG
- audio — MP3, M4A/AAC, Ogg, or another format supported by your target browsers

## Multi-track releases and lyrics

Single-track configs continue to use top-level `audio`. For an EP or album,
replace `audio` with a non-empty `tracks` array. A track-level artist is
optional and falls back to the release artist.

```json
{
  "title": "Release title",
  "artist": "Artist name",
  "releaseDate": "2026-08-24",
  "credits": "Produced by Elliot.wavs. More at [Bandcamp](https://bandcamp.com/artist).",
  "artwork": "https://media.example.com/artwork.jpg",
  "tracks": [
    {
      "title": "First song",
      "audio": "https://media.example.com/first-song.wav",
      "video": "https://media.example.com/first-song.mp4",
      "lyrics": "First line\nSecond line",
      "about": "Optional notes, credits, or story behind the song."
    },
    {
      "title": "Featured song",
      "artist": "Artist name feat. Guest",
      "audio": "https://media.example.com/featured-song.wav",
      "lyrics": "Lyrics are optional"
    }
  ]
}
```

The player displays the current song in the footer, provides previous/next
controls, advances automatically, and shows available lyrics or song notes in
the swipe-up drawer. Release-level Credits and track-level Lyrics/About tabs are
hidden automatically when empty. Markdown links in About and Credits open in a
new tab so playback continues uninterrupted; line breaks and other text are
preserved.

If a track has a `video` URL, swipe right from the left edge of the player to
open that track’s full-screen VHS-style video drawer. Tap the video to pause or
resume, and swipe left across the video to close it. MP4, WebM, and MOV files
are supported where the browser supports them. Device orientation remains under
the user’s control while the video is open.

The player has no accounts, analytics, database, secrets, upload UI, scrubber, volume UI, or playlist.
