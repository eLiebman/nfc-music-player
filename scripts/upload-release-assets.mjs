import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { trimWavFile } from "./trim-wav.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = JSON.parse(await readFile(path.join(root, "release-target.json"), "utf8"));
function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`Unexpected argument: ${token}`);
    const name = token.slice(2);
    const next = argv[index + 1];
    const value = next && !next.startsWith("--") ? argv[++index] : true;
    if (["audio", "video", "video-mobile", "video-desktop"].includes(name)) {
      parsed[name] = [...(parsed[name] || []), value];
    } else {
      parsed[name] = value;
    }
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));

const slug = String(args.slug || "");
const audioPaths = (args.audio || []).map((value) => path.resolve(String(value)));
const artworkPath = args.artwork ? path.resolve(String(args.artwork)) : null;
const videoPaths = (args.video || []).map((value) => path.resolve(String(value)));
const mobileVideoPaths = (args["video-mobile"] || []).map((value) => path.resolve(String(value)));
const desktopVideoPaths = (args["video-desktop"] || []).map((value) => path.resolve(String(value)));
const dryRun = args["dry-run"] === true;

if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error("--slug must be lowercase kebab-case");
if (!audioPaths.length && !artworkPath && !videoPaths.length && !mobileVideoPaths.length && !desktopVideoPaths.length) {
  throw new Error("Provide at least one --audio, --artwork, --video, --video-mobile, or --video-desktop file");
}
await Promise.all([
  ...audioPaths.map((audioPath) => access(audioPath)),
  ...(artworkPath ? [access(artworkPath)] : []),
  ...videoPaths.map((videoPath) => access(videoPath)),
  ...mobileVideoPaths.map((videoPath) => access(videoPath)),
  ...desktopVideoPaths.map((videoPath) => access(videoPath)),
]);

const preparedAudioPaths = await Promise.all(audioPaths.map(async (audioPath, index) => {
  if (path.extname(audioPath).toLowerCase() !== ".wav") {
    console.error(`Silence trimming skipped for non-WAV audio: ${path.basename(audioPath)}`);
    return audioPath;
  }
  const outputPath = path.join(tmpdir(), `nfc-trim-${process.pid}-${Date.now()}-${index}.wav`);
  const trimmed = await trimWavFile(audioPath, outputPath);
  if (trimmed.changed) {
    console.error(`Trimmed silence from ${path.basename(audioPath)}: ${trimmed.trimmedStartSeconds.toFixed(3)}s start, ${trimmed.trimmedEndSeconds.toFixed(3)}s end`);
  } else {
    console.error(`No removable edge silence found in ${path.basename(audioPath)}`);
  }
  return outputPath;
}));

function runAws(commandArgs, { allowFailure = false, interactive = false } = {}) {
  const candidates = ["aws", path.join(process.env.HOME || "", ".local/bin/aws")];
  for (const executable of candidates) {
    const result = spawnSync(executable, commandArgs, interactive ? { stdio: "inherit" } : { encoding: "utf8" });
    if (result.error?.code === "ENOENT") continue;
    if (result.status !== 0 && !allowFailure) {
      throw new Error((result.stderr || result.stdout || `AWS CLI exited ${result.status}`).trim());
    }
    return result;
  }
  throw new Error("AWS CLI not found in PATH or ~/.local/bin/aws");
}

function contentType(filePath, kind) {
  const extension = path.extname(filePath).toLowerCase();
  const types = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp",
    ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".flac": "audio/flac",
    ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime",
  };
  if (!types[extension]) throw new Error(`Unsupported ${kind} extension: ${extension || "none"}`);
  return types[extension];
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex").slice(0, 12)));
  });
}

async function asset(filePath, kind) {
  const hash = await hashFile(filePath);
  const extension = path.extname(filePath).toLowerCase();
  const key = `releases/${slug}/${kind}-${hash}${extension}`;
  return {
    filePath,
    key,
    contentType: contentType(filePath, kind),
    url: `${target.mediaOrigin.replace(/\/$/, "")}/${key.split("/").map(encodeURIComponent).join("/")}`,
  };
}

const [audios, artwork] = await Promise.all([
  Promise.all(preparedAudioPaths.map((audioPath) => asset(audioPath, "audio"))),
  artworkPath ? asset(artworkPath, "artwork") : null,
]);
const videos = await Promise.all(videoPaths.map((videoPath) => asset(videoPath, "video")));
const mobileVideos = await Promise.all(mobileVideoPaths.map((videoPath) => asset(videoPath, "video-mobile")));
const desktopVideos = await Promise.all(desktopVideoPaths.map((videoPath) => asset(videoPath, "video-desktop")));

if (!dryRun) {
  console.error("Checking AWS credentials...");
  const identityArgs = ["sts", "get-caller-identity", "--profile", target.awsProfile, "--output", "json"];
  let identityResult = runAws(identityArgs, { allowFailure: true });
  if (identityResult.status !== 0) {
    console.error("AWS login required. Complete login in the browser; upload will resume here.");
    runAws(["login", "--profile", target.awsProfile], { interactive: true });
    console.error("AWS login completed. Verifying credentials...");
    identityResult = runAws(identityArgs);
  }
  const identity = JSON.parse(identityResult.stdout);
  if (identity.Arn?.endsWith(":root")) throw new Error("Refusing to upload with AWS root credentials");

  console.error(`Checking S3 bucket ${target.bucket} in ${target.region}...`);
  const locationResult = runAws([
    "s3api", "get-bucket-location", "--bucket", target.bucket,
    "--profile", target.awsProfile, "--region", target.region, "--output", "json",
  ]);
  const bucketLocation = JSON.parse(locationResult.stdout).LocationConstraint || "us-east-1";
  if (bucketLocation !== target.region) {
    throw new Error(`Bucket ${target.bucket} is in ${bucketLocation}, not configured region ${target.region}`);
  }
  console.error("S3 bucket verified.");

  for (const item of [...audios, ...(artwork ? [artwork] : []), ...videos, ...mobileVideos, ...desktopVideos]) {
    const kind = item === artwork
      ? "artwork"
      : [...mobileVideos, ...desktopVideos].includes(item)
        ? item.key.includes("video-mobile-") ? "video-mobile" : "video-desktop"
        : videos.includes(item) ? "video" : "audio";
    console.error(`Uploading ${kind}: ${path.basename(item.filePath)}`);
    runAws([
      "s3", "cp", item.filePath, `s3://${target.bucket}/${item.key}`,
      "--profile", target.awsProfile,
      "--region", target.region,
      "--content-type", item.contentType,
      "--cache-control", "public,max-age=31536000,immutable",
    ], { interactive: true });
    console.error(`Verifying ${kind} upload...`);
    runAws([
      "s3api", "head-object", "--bucket", target.bucket, "--key", item.key,
      "--profile", target.awsProfile, "--region", target.region,
    ]);
    console.error(`${kind[0].toUpperCase()}${kind.slice(1)} verified.`);
  }
}

const resultPayload = {
  dryRun,
  ...(audios.length === 1 ? { audio: audios[0] } : audios.length ? { audios } : {}),
  ...(artwork ? { artwork } : {}),
  ...(videos.length === 1 ? { video: videos[0] } : videos.length ? { videos } : {}),
  ...(mobileVideos.length === 1 ? { videoMobile: mobileVideos[0] } : mobileVideos.length ? { videoMobiles: mobileVideos } : {}),
  ...(desktopVideos.length === 1 ? { videoDesktop: desktopVideos[0] } : desktopVideos.length ? { videoDesktops: desktopVideos } : {}),
};
const result = `${JSON.stringify(resultPayload, null, 2)}\n`;
if (args["result-file"] && args["result-file"] !== true) {
  await writeFile(path.resolve(String(args["result-file"])), result);
} else {
  process.stdout.write(result);
}
await Promise.all(preparedAudioPaths
  .filter((preparedPath, index) => preparedPath !== audioPaths[index])
  .map((preparedPath) => rm(preparedPath, { force: true })));
