#!/usr/bin/env node

import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

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

function findFfmpeg() {
  return process.env.FFMPEG || [
    "ffmpeg",
    "/opt/homebrew/bin/ffmpeg",
    "/usr/local/bin/ffmpeg",
  ].find((candidate) => candidate === "ffmpeg" || existsSync(candidate));
}

function runFfmpeg(ffmpeg, input, output, { mobile, maxWidth, maxHeight }) {
  const scale = `scale=w=${maxWidth}:h=${maxHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2`;
  const videoOptions = mobile
    ? ["-crf", "28", "-maxrate", "1.8M", "-bufsize", "3.6M", "-profile:v", "main", "-level", "3.2", "-b:a", "96k"]
    : ["-crf", "23", "-maxrate", "5M", "-bufsize", "10M", "-profile:v", "high", "-level", "4.2", "-b:a", "128k"];
  const ffmpegArgs = [
    "-hide_banner", "-y", "-i", input,
    "-map", "0:v:0", "-map", "0:a?", "-vf", scale,
    "-c:v", "libx264", "-preset", "slow", ...videoOptions,
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000",
    "-movflags", "+faststart", "-map_metadata", "0", output,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ffmpegArgs, { stdio: "inherit" });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with status ${code}`));
    });
  });
}

const args = parseArgs(process.argv.slice(2));
if (!args.input || !args["mobile-output"] || !args["desktop-output"]) {
  throw new Error("Usage: node scripts/transcode-video.mjs --input <file> --mobile-output <file> --desktop-output <file>");
}

const input = path.resolve(String(args.input));
const mobileOutput = path.resolve(String(args["mobile-output"]));
const desktopOutput = path.resolve(String(args["desktop-output"]));
await access(input);

const ffmpeg = await findFfmpeg();
if (!ffmpeg) throw new Error("ffmpeg is required; install it or set FFMPEG to its executable path");

console.error(`Transcoding mobile video to ${mobileOutput}`);
await runFfmpeg(ffmpeg, input, mobileOutput, { mobile: true, maxWidth: 540, maxHeight: 960 });
console.error(`Transcoding desktop video to ${desktopOutput}`);
await runFfmpeg(ffmpeg, input, desktopOutput, { mobile: false, maxWidth: 1920, maxHeight: 1920 });
