import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = JSON.parse(await readFile(path.join(root, "release-target.json"), "utf8"));
const args = Object.fromEntries(process.argv.slice(2).map((arg, index, all) => {
  if (!arg.startsWith("--")) return [];
  return [arg.slice(2), all[index + 1]?.startsWith("--") ? true : all[index + 1] ?? true];
}).filter((entry) => entry.length));

const slug = String(args.slug || "");
const audioPath = path.resolve(String(args.audio || ""));
const artworkPath = path.resolve(String(args.artwork || ""));
const dryRun = args["dry-run"] === true;

if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) throw new Error("--slug must be lowercase kebab-case");
if (!args.audio || !args.artwork) throw new Error("Usage: upload-release-assets.mjs --slug <slug> --audio <path> --artwork <path> [--dry-run]");
await Promise.all([access(audioPath), access(artworkPath)]);

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

const [audio, artwork] = await Promise.all([asset(audioPath, "audio"), asset(artworkPath, "artwork")]);

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

  for (const item of [audio, artwork]) {
    const kind = item === audio ? "audio" : "artwork";
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

const result = `${JSON.stringify({ dryRun, audio, artwork }, null, 2)}\n`;
if (args["result-file"] && args["result-file"] !== true) {
  await writeFile(path.resolve(String(args["result-file"])), result);
} else {
  process.stdout.write(result);
}
