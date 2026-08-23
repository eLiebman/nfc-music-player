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

Run the deterministic release script and follow its prompts:

```sh
node scripts/new-release.mjs
```

The script previews the immutable S3 keys, asks before uploading, writes the
release config, generates the page, validates the uploaded assets and metadata,
then prints the local visual-QA link. It does not use AI or deploy the site.
If recovering a failed release that already has scaffolding, pass `--force` to
reuse its slug and bypass duplicate warnings.

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

The player has no accounts, analytics, database, secrets, upload UI, scrubber, volume UI, or playlist.
