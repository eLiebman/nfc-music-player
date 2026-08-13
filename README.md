# NFC Music Disc player

A framework-free static music player designed for release URLs encoded on NFC tags.

## Test locally

From this folder, run:

```sh
python3 -m http.server 8080
```

Then open <http://localhost:8080/?release=just-friends>.

The first click on the disc requests fullscreen where supported and starts playback. Later clicks pause, resume, or replay the release.

## Add your own release

1. Create `releases/your-release-slug`.
2. Add your artwork, audio, and a copy of `config.json` to that folder.
3. Update `config.json` with the filenames and release metadata.
4. Open `http://localhost:8080/?release=your-release-slug`.

There is only one player HTML file. The `release` URL parameter selects a folder and loads its `config.json`; relative asset paths are resolved from that config file's location.

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

The player has no accounts, analytics, database, secrets, upload UI, scrubber, volume UI, or playlist.
