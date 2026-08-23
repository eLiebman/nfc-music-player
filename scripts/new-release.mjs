#!/usr/bin/env node

import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const releasesRoot = path.join(root, "releases");
const requiredConfigFields = ["title", "artist", "audio", "artwork"];

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    const next = argv[index + 1];
    args[name] = next && !next.startsWith("--") ? argv[++index] : true;
  }
  return args;
}

function slugify(value) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeFileInput(value) {
  let input = String(value || "").trim();

  // Dragging a file into a terminal commonly adds matching quotes or escapes
  // spaces with backslashes. Readline receives those characters literally,
  // unlike a shell command line, so normalize them before resolving the path.
  const quote = input[0];
  if ((quote === '"' || quote === "'") && input.at(-1) === quote) {
    input = input.slice(1, -1);
  }
  input = input.replace(/\\(.)/gs, "$1");

  if (input.startsWith("file://")) return fileURLToPath(input);
  if (input === "~") return process.env.HOME || input;
  if (input.startsWith("~/")) return path.join(process.env.HOME || "~", input.slice(2));
  return input;
}

function runNode(script, args = [], { inheritOutput = false } = {}) {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", script), ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: inheritOutput ? "inherit" : ["inherit", "pipe", "inherit"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} exited with status ${result.status}`);
  return result.stdout || "";
}

function parseUploadResult(output) {
  const jsonStart = output.lastIndexOf('{\n  "dryRun"');
  if (jsonStart === -1) throw new Error("Uploader did not return its JSON result");
  return JSON.parse(output.slice(jsonStart));
}

async function pathExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function normalizeMetadata(value) {
  return String(value || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

function contentHash(value, kind) {
  return String(value || "").match(new RegExp(`${kind}-([a-f0-9]{12})(?:\\.[^/?#]+)?(?:[?#]|$)`, "i"))?.[1]?.toLowerCase();
}

async function findDuplicateRelease({ slug, title, artist, audioKey }) {
  const wantedTitle = normalizeMetadata(title);
  const wantedArtist = normalizeMetadata(artist);
  const wantedAudioHash = contentHash(audioKey, "audio");
  const duplicates = [];

  for (const entry of await readdir(releasesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === slug) continue;
    const configPath = path.join(releasesRoot, entry.name, "config.json");
    if (!(await pathExists(configPath))) continue;

    const existing = JSON.parse(await readFile(configPath, "utf8"));
    const reasons = [];
    if (normalizeMetadata(existing.title) === wantedTitle
      && normalizeMetadata(existing.artist) === wantedArtist) {
      reasons.push("same title and artist");
    }
    const existingAudioHash = contentHash(existing.audio, "audio");
    if (wantedAudioHash && existingAudioHash === wantedAudioHash) {
      reasons.push(`same audio content hash ${wantedAudioHash}`);
    }
    if (reasons.length) duplicates.push(`${entry.name} (${reasons.join(", ")})`);
  }

  return duplicates;
}

async function validateRemoteAsset(url, expectedPrefix) {
  const response = await fetch(url, {
    headers: {
      Origin: "https://play.elliotwavs.com",
      Range: "bytes=0-0",
    },
  });
  if (![200, 206].includes(response.status)) {
    throw new Error(`${url} returned ${response.status}`);
  }
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith(expectedPrefix)) {
    throw new Error(`${url} returned unexpected content type ${contentType || "(missing)"}`);
  }
  const allowOrigin = response.headers.get("access-control-allow-origin");
  if (!["*", "https://play.elliotwavs.com"].includes(allowOrigin)) {
    throw new Error(`${url} did not allow the player origin through CORS`);
  }
}

function printHelp() {
  console.log(`Create and upload a release without AI.

Usage:
  node scripts/new-release.mjs [options]

Options:
  --title <title>
  --artist <artist>
  --audio <path>
  --artwork <path>
  --edition <text>
  --slug <lowercase-kebab-case>
  --yes                     Skip the upload confirmation
  --force                   Reuse an existing slug and allow duplicates
  --help
`);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  printHelp();
  process.exit(0);
}

const rl = createInterface({ input: stdin, output: stdout });
const ask = async (label, supplied = "") => {
  const value = supplied === true ? "" : String(supplied || "").trim();
  if (value) return value;
  return (await rl.question(`${label}: `)).trim();
};

try {
  const title = await ask("Release title", args.title);
  const artist = await ask("Artist credit", args.artist);
  const audioInput = await ask("Audio file", args.audio);
  const artworkInput = await ask("Artwork file", args.artwork);
  const defaultSlug = slugify(title);
  const slugAnswer = args.slug
    ? String(args.slug)
    : (await rl.question(`Slug [${defaultSlug}]: `)).trim() || defaultSlug;
  const slug = slugAnswer.trim();
  const edition = args.edition === true
    ? ""
    : args.edition !== undefined
      ? String(args.edition).trim()
      : (await rl.question("Edition/footer text (optional): ")).trim();

  if (!title || !artist || !audioInput || !artworkInput) {
    throw new Error("Title, artist, audio, and artwork are required");
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error("Slug must be lowercase kebab-case");
  }

  const audioPath = path.resolve(normalizeFileInput(audioInput));
  const artworkPath = path.resolve(normalizeFileInput(artworkInput));
  await Promise.all([access(audioPath), access(artworkPath), access(path.join(root, "release-target.json"))]);

  const releaseDir = path.join(releasesRoot, slug);
  const releaseDirExists = await pathExists(releaseDir);
  if (releaseDirExists && !args.force) {
    console.warn(`\nWarning: releases/${slug} already exists.`);
    const confirmation = (await rl.question("Reuse it and replace its config? [y/N]: ")).trim().toLowerCase();
    if (!["y", "yes"].includes(confirmation)) {
      console.log("Release cancelled. Existing files were not changed.");
      process.exit(0);
    }
  }

  const uploadArgs = ["--slug", slug, "--audio", audioPath, "--artwork", artworkPath];
  const preview = parseUploadResult(runNode("upload-release-assets.mjs", [...uploadArgs, "--dry-run"]));
  const duplicates = await findDuplicateRelease({ slug, title, artist, audioKey: preview.audio.key });
  if (duplicates.length && !args.force) {
    console.warn(`\nWarning: possible duplicate release found: ${duplicates.join("; ")}`);
    const confirmation = (await rl.question("Create this release anyway? [y/N]: ")).trim().toLowerCase();
    if (!["y", "yes"].includes(confirmation)) {
      console.log("Release cancelled. Nothing uploaded or created.");
      process.exit(0);
    }
  }
  console.log("\nUpload preview:");
  console.log(`  ${preview.audio.key}`);
  console.log(`  ${preview.artwork.key}`);

  if (!args.yes) {
    const confirmation = (await rl.question("Upload these assets? [y/N]: ")).trim().toLowerCase();
    if (!["y", "yes"].includes(confirmation)) {
      console.log("Release cancelled. Nothing uploaded or created.");
      process.exit(0);
    }
  }

  console.log("\nUploading and verifying assets...");
  const uploadResultPath = path.join(tmpdir(), `nfc-release-${process.pid}-${Date.now()}.json`);
  let uploaded;
  try {
    runNode("upload-release-assets.mjs", [...uploadArgs, "--result-file", uploadResultPath], { inheritOutput: true });
    uploaded = JSON.parse(await readFile(uploadResultPath, "utf8"));
  } finally {
    await rm(uploadResultPath, { force: true });
  }
  console.log("Checking uploaded assets through CloudFront...");
  await Promise.all([
    validateRemoteAsset(uploaded.audio.url, "audio/"),
    validateRemoteAsset(uploaded.artwork.url, "image/"),
  ]);

  const config = {
    title,
    artist,
    audio: uploaded.audio.url,
    artwork: uploaded.artwork.url,
    ...(edition ? { edition } : {}),
  };
  const missing = requiredConfigFields.filter((field) => !config[field]);
  if (missing.length) throw new Error(`Missing config fields: ${missing.join(", ")}`);

  await mkdir(releaseDir, { recursive: true });
  const configPath = path.join(releaseDir, "config.json");
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  process.stdout.write(runNode("generate-release-pages.mjs"));

  const pagePath = path.join(root, slug, "index.html");
  const page = await readFile(pagePath, "utf8");
  const expectedPageValues = [
    `<title>${title.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</title>`,
    `<link rel="canonical" href="https://play.elliotwavs.com/${slug}/">`,
    `data-config="../releases/${slug}/config.json"`,
  ];
  if (expectedPageValues.some((value) => !page.includes(value))) {
    throw new Error("Generated page failed metadata validation");
  }

  const localUrl = `http://127.0.0.1:8080/${slug}/`;
  const productionUrl = `https://play.elliotwavs.com/${slug}/`;
  console.log("\nRelease ready.");
  console.log("Start local server if it is not already running:");
  console.log("  python3 -m http.server 8080");
  console.log("\nVISUAL QA LINK:");
  console.log(`  ${localUrl}`);
  console.log("\nProduction link after deployment:");
  console.log(`  ${productionUrl}`);
} finally {
  rl.close();
}
