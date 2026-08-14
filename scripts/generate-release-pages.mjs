import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releasesRoot = path.join(root, "releases");
const siteOrigin = "https://play.elliotwavs.com";
const includePrivate = process.argv.includes("--include-private");

const escapeHtml = (value) => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll('"', "&quot;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;");

const isRemoteUrl = (value) => /^https?:\/\//i.test(value);

function pageHtml(slug, config) {
  const title = escapeHtml(config.title);
  const artist = escapeHtml(config.artist);
  const description = escapeHtml(`${config.title} by ${config.artist}`);
  const artworkUrl = isRemoteUrl(config.artwork)
    ? config.artwork
    : new URL(config.artwork, `${siteOrigin}/releases/${slug}/`).href;
  const displayArtwork = config.displayArtwork || config.artwork;
  const displayArtworkUrl = isRemoteUrl(displayArtwork)
    ? displayArtwork
    : new URL(displayArtwork, `${siteOrigin}/releases/${slug}/`).href;
  const pageUrl = `${siteOrigin}/${slug}/`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <meta name="theme-color" content="#12131a">
    <title>${title}</title>
    <meta name="description" content="${description}">
    <meta property="og:type" content="music.song">
    <meta property="og:site_name" content="Elliot.wavs">
    <meta property="og:title" content="${title}">
    <meta property="og:description" content="${artist}">
    <meta property="og:url" content="${pageUrl}">
    <meta property="og:image" content="${escapeHtml(artworkUrl)}">
    <meta property="og:image:alt" content="Cover artwork for ${title}">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${title}">
    <meta name="twitter:description" content="${artist}">
    <meta name="twitter:image" content="${escapeHtml(artworkUrl)}">
    <link rel="canonical" href="${pageUrl}">
    <link rel="preload" as="image" href="${escapeHtml(displayArtworkUrl)}" crossorigin="anonymous">
    <link rel="stylesheet" href="../assets/app.css?v=12">
  </head>
  <body data-config="../releases/${slug}/config.json">
    <main class="player" data-player data-state="loading">
      <div class="backdrop" aria-hidden="true"></div>
      <div class="player-shell">
        <header class="release-meta">
          <p class="artist" data-artist>Loading</p>
          <h1 class="title" data-title>Release</h1>
        </header>
        <section class="disc-stage" aria-label="Audio player">
          <button class="disc-button" type="button" data-disc-button disabled aria-label="Loading release">
            <img class="disc-artwork" data-artwork alt="">
          </button>
        </section>
        <footer class="release-footer">
          <p class="edition" data-edition hidden></p>
          <p class="status" data-status role="status" aria-live="polite" hidden></p>
        </footer>
      </div>
      <audio preload="metadata"></audio>
    </main>
    <noscript>This listening experience requires JavaScript.</noscript>
    <script type="module" src="../assets/player.js?v=29"></script>
  </body>
</html>
`;
}

const entries = await readdir(releasesRoot, { withFileTypes: true });
for (const entry of entries) {
  if (!entry.isDirectory()) continue;
  const slug = entry.name;
  const releaseDir = path.join(releasesRoot, slug);

  try {
    await access(path.join(releaseDir, ".no-share"));
    if (!includePrivate) continue;
  } catch {}

  const config = JSON.parse(await readFile(path.join(releaseDir, "config.json"), "utf8"));
  const outputDir = path.join(root, slug);
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(path.join(outputDir, "index.html"), pageHtml(slug, config));
  console.log(`Generated /${slug}/`);
}
