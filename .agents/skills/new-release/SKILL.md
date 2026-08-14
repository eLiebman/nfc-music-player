---
name: new-release
description: Creates, uploads, and validates a new NFC music-player release from artwork and audio assets. Use when the user asks to add, create, scaffold, or publish a release, track, single, or album in this repository.
---

# New release

Create a release without duplicating player code, committing media binaries, or hand-authoring share metadata.

## Collect inputs

Ask the user for any missing required inputs before editing:

- artwork file
- audio file
- release title
- artist credit

Also ask for optional edition/footer text when it cannot be inferred. Accept local paths or attached files. Do not invent credits or edition text.

Derive a lowercase kebab-case slug from the title and confirm it only when ambiguous or when `releases/<slug>` already exists. Never overwrite an existing release without explicit approval.

## Create the release

1. Create `releases/<slug>/`.
2. Confirm `release-target.json` exists and contains the non-secret AWS profile, region, bucket, and media origin. Never request, read, print, or commit AWS secret keys. The uploader checks the profile and launches `aws login --profile <awsProfile>` when authentication is missing or expired. Tell the user when the skill launches browser authentication, wait for them to complete it, and then let the uploader resume automatically.
3. Preview the immutable, content-hashed S3 keys without uploading:

```sh
node scripts/upload-release-assets.mjs --slug <slug> --audio <audio-path> --artwork <artwork-path> --dry-run
```

4. Upload both assets with the same command minus `--dry-run`. The script must refuse root credentials, preserve the source files, set MIME/cache metadata, and verify the uploaded objects. Do not copy media into the repository.
5. Create `releases/<slug>/config.json` from the script's `audio.url` and `artwork.url`:

```json
{
  "title": "Release title",
  "artist": "Artist credit",
  "audio": "https://media.elliotwavs.com/releases/slug/audio-hash.ext",
  "artwork": "https://media.elliotwavs.com/releases/slug/artwork-hash.ext",
  "edition": "Optional footer text"
}
```

Omit `edition` when none is supplied. Do not add an accent color; the player derives it from the artwork.

6. Run:

```sh
node scripts/generate-release-pages.mjs
```

This generates `/<slug>/index.html` with static title, Open Graph, Twitter, canonical, and artwork metadata while reusing `assets/player.js` and `assets/app.css`.

## Validate

- Confirm `config.json` parses and its four required fields are present.
- Confirm the CloudFront audio and artwork URLs return `200` or byte-range `206`, with the expected content types and `Access-Control-Allow-Origin`.
- Confirm `/<slug>/index.html` contains the correct title, artist, canonical URL, encoded artwork URL, and `data-config` path.
- Serve the repository locally and test `http://127.0.0.1:8080/<slug>/?test-muted=1` at a mobile viewport.
- Keep all automated playback muted.
- Confirm artwork and audio load, the tab title matches the release title, and the disc is centered.
- Do not add `.no-share`; that marker is reserved for private QA fixtures.
- Never upload a placeholder or permission-test object to production S3.

## Handoff

Report:

- files created
- local URL: `http://127.0.0.1:8080/<slug>/`
- production URL after deployment: `https://play.elliotwavs.com/<slug>/`
- validation performed
- S3 keys and CloudFront URLs uploaded

Commit, push, or deploy only when the user requests publishing or the current task explicitly includes it.
