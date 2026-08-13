---
name: new-release
description: Creates and validates a new NFC music-player release from artwork and audio assets. Use when the user asks to add, create, scaffold, or publish a release, track, single, or album in this repository.
---

# New release

Create a release without duplicating player code or hand-authoring share metadata.

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
2. Copy the supplied artwork and audio into that folder without modifying the originals. Prefer simple filenames such as `artwork.jpg` and `audio.mp3`, preserving the actual extensions.
3. Create `releases/<slug>/config.json`:

```json
{
  "title": "Release title",
  "artist": "Artist credit",
  "audio": "./audio.ext",
  "artwork": "./artwork.ext",
  "edition": "Optional footer text"
}
```

Omit `edition` when none is supplied. Do not add an accent color; the player derives it from the artwork.

4. Run:

```sh
node scripts/generate-release-pages.mjs
```

This generates `/<slug>/index.html` with static title, Open Graph, Twitter, canonical, and artwork metadata while reusing `assets/player.js` and `assets/app.css`.

## Validate

- Confirm `config.json` parses and its four required fields are present.
- Confirm the referenced audio and artwork exist.
- Confirm `/<slug>/index.html` contains the correct title, artist, canonical URL, encoded artwork URL, and `data-config` path.
- Serve the repository locally and test `http://127.0.0.1:8080/<slug>/?test-muted=1` at a mobile viewport.
- Keep all automated playback muted.
- Confirm artwork and audio load, the tab title matches the release title, and the disc is centered.
- Do not add `.no-share`; that marker is reserved for private QA fixtures.

## Handoff

Report:

- files created
- local URL: `http://127.0.0.1:8080/<slug>/`
- production URL after deployment: `https://play.elliotwavs.com/<slug>/`
- validation performed

Commit, push, or deploy only when the user requests publishing or the current task explicitly includes it.
