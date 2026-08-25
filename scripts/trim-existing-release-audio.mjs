#!/usr/bin/env node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalog = JSON.parse(await readFile(path.join(root, "discography.json"), "utf8"));
const workDir = await mkdtemp(path.join(tmpdir(), "nfc-existing-trim-"));

function runNode(script, args) {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", script), ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.status !== 0) throw new Error(`${script} exited with status ${result.status}`);
  return result.stdout;
}

async function download(url, filePath) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  await writeFile(filePath, Buffer.from(await response.arrayBuffer()));
}

try {
  for (const release of catalog) {
    const configPath = path.join(root, "releases", release.slug, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8"));
    const audioUrls = config.tracks?.length ? config.tracks.map((track) => track.audio) : [config.audio];
    if (audioUrls.some((url) => !url)) throw new Error(`${release.slug} has a missing audio URL`);
    console.error(`\nPreparing ${release.title} (${audioUrls.length} track${audioUrls.length === 1 ? "" : "s"})...`);
    const localPaths = [];
    for (const [index, url] of audioUrls.entries()) {
      const extension = path.extname(new URL(url).pathname).toLowerCase();
      if (extension !== ".wav") {
        console.error(`Skipping ${release.slug}: existing ${extension || "unknown"} audio cannot be trimmed without ffmpeg.`);
        localPaths.length = 0;
        break;
      }
      const localPath = path.join(workDir, `${release.slug}-${index + 1}.wav`);
      console.error(`Downloading track ${index + 1}...`);
      await download(url, localPath);
      localPaths.push(localPath);
    }
    if (!localPaths.length) continue;

    const resultPath = path.join(workDir, `${release.slug}-upload.json`);
    const uploadArgs = [
      "--slug", release.slug,
      ...localPaths.flatMap((filePath) => ["--audio", filePath]),
      "--result-file", resultPath,
    ];
    runNode("upload-release-assets.mjs", uploadArgs);
    const uploaded = JSON.parse(await readFile(resultPath, "utf8"));
    const uploadedAudios = uploaded.audios || [uploaded.audio];
    if (uploadedAudios.length !== audioUrls.length) throw new Error(`Upload count mismatch for ${release.slug}`);
    if (config.tracks?.length) {
      config.tracks.forEach((track, index) => { track.audio = uploadedAudios[index].url; });
    } else {
      config.audio = uploadedAudios[0].url;
    }
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    console.error(`Updated ${path.relative(root, configPath)}.`);
  }
  runNode("generate-release-pages.mjs", []);
  console.error("\nExisting release audio trimming complete.");
} finally {
  await rm(workDir, { recursive: true, force: true });
}
