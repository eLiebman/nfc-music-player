const REQUIRED_FIELDS = ["title", "artist", "audio", "artwork"];
const SECONDS_PER_TURN = 8;
const MOTOR_ACCEL_DURATION_MS = 800;
const MOTOR_DECEL_DURATION_MS = 800;
const MOTOR_REWIND_TRIM_SECONDS = 0.15;
// Set `enabled` to false to restore immediate, normal-pitch <audio> playback.
const VINYL_PITCH_MOTOR = Object.freeze({
  enabled: true,
  minimumPlaybackRate: 0.25,
  cruiseSnapRatio: 0.995,
});

const player = document.querySelector("[data-player]");
const button = document.querySelector("[data-disc-button]");
const artwork = document.querySelector("[data-artwork]");
const title = document.querySelector("[data-title]");
const artist = document.querySelector("[data-artist]");
const edition = document.querySelector("[data-edition]");
const status = document.querySelector("[data-status]");
const audio = document.querySelector("audio");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

// Keeps automated interaction checks silent without changing normal playback.
if (new URLSearchParams(location.search).has("test-muted")) audio.muted = true;

let config;
let configBaseUrl;
let bufferedAudioUrl;
let state = "loading";
let firstPlayAttempt = true;
let hasStartedPlayback = false;
let visualTurns = 0;
let visualSpeed = 0;
let previousFrameTime;
let motorRunning = false;
let pendingMotorPause = false;
let motorTransition = null;

function resolveAsset(path) {
  return new URL(path, configBaseUrl).href;
}

async function setAudioSource(sourceUrl) {
  const isLocalPreview = ["localhost", "127.0.0.1"].includes(location.hostname);
  if (!isLocalPreview) {
    audio.src = sourceUrl;
    return;
  }

  // Basic local static servers often omit byte-range support, which makes
  // media seeking jump to 0:00. A buffered Blob stays seekable for local QA.
  const response = await fetch(sourceUrl);
  if (!response.ok) throw new Error(`Audio returned ${response.status}`);
  const blob = await response.blob();
  if (bufferedAudioUrl) URL.revokeObjectURL(bufferedAudioUrl);
  bufferedAudioUrl = URL.createObjectURL(blob);
  audio.src = bufferedAudioUrl;
}

function getConfigUrl() {
  if (document.body.dataset.config) {
    return new URL(document.body.dataset.config, document.baseURI);
  }

  const release = new URLSearchParams(location.search).get("release");
  if (!release || !/^[a-z0-9][a-z0-9-]*$/i.test(release)) {
    throw new Error("Add ?release=your-release-slug to the player URL.");
  }

  return new URL(`./releases/${release}/config.json`, document.baseURI);
}

function setState(next, message = "") {
  state = next;
  player.dataset.state = next;
  button.disabled = next === "loading";

  const action = {
    loading: "Loading",
    ready: "Play",
    playing: "Pause",
    stopping: "Resume",
    paused: "Resume",
    ended: "Replay",
    error: "Retry",
  }[next];
  button.setAttribute("aria-label", config ? `${action} ${config.title} by ${config.artist}` : action);
  status.textContent = message;
  status.hidden = !message;
}

function rgbToHsl(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 510;
  const saturation = max === min ? 0 : (max - min) / (255 - Math.abs(max + min - 255));
  return { saturation, lightness };
}

function extractAccent(image) {
  const canvas = document.createElement("canvas");
  const size = 40;
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(image, 0, 0, size, size);
  const pixels = context.getImageData(0, 0, size, size).data;
  const buckets = new Map();

  for (let index = 0; index < pixels.length; index += 4) {
    const [r, g, b, alpha] = pixels.slice(index, index + 4);
    if (alpha < 220) continue;
    const { saturation, lightness } = rgbToHsl(r, g, b);
    if (lightness < 0.1 || lightness > 0.9 || saturation < 0.16) continue;

    const key = `${Math.round(r / 24)},${Math.round(g / 24)},${Math.round(b / 24)}`;
    const bucket = buckets.get(key) || { count: 0, r: 0, g: 0, b: 0, saturation: 0 };
    bucket.count += 1;
    bucket.r += r;
    bucket.g += g;
    bucket.b += b;
    bucket.saturation += saturation;
    buckets.set(key, bucket);
  }

  const candidates = [...buckets.values()];
  if (!candidates.length) throw new Error("No suitable accent pixels found");
  candidates.sort((a, b) => {
    const scoreA = a.count * (0.65 + a.saturation / a.count);
    const scoreB = b.count * (0.65 + b.saturation / b.count);
    return scoreB - scoreA;
  });

  const winner = candidates[0];
  const channel = (value) => Math.round(value / winner.count).toString(16).padStart(2, "0");
  return `#${channel(winner.r)}${channel(winner.g)}${channel(winner.b)}`;
}

function configureVinylPitchMotor() {
  if (!VINYL_PITCH_MOTOR.enabled) return;
  // `preservesPitch` is standard; the prefixed property supports older Safari.
  audio.preservesPitch = false;
  if ("webkitPreservesPitch" in audio) audio.webkitPreservesPitch = false;
}

function easeInOutSine(progress) {
  return -(Math.cos(Math.PI * progress) - 1) / 2;
}

function easeVolume(progress) {
  return progress * progress * (3 - 2 * progress);
}

function playbackRateForMotorRatio(motorRatio) {
  return motorRatio >= VINYL_PITCH_MOTOR.cruiseSnapRatio
    ? 1
    : VINYL_PITCH_MOTOR.minimumPlaybackRate ** (1 - motorRatio);
}

function getIntegratedRampPlaybackSeconds(running) {
  const steps = 240;
  const duration = running ? MOTOR_ACCEL_DURATION_MS : MOTOR_DECEL_DURATION_MS;
  let playbackRateTotal = 0;

  for (let step = 0; step < steps; step += 1) {
    const progress = (step + 0.5) / steps;
    const naturalProgress = easeInOutSine(progress);
    const perceptualProgress = running
      ? naturalProgress
      : naturalProgress ** 1.25;
    const motorRatio = running ? perceptualProgress : 1 - perceptualProgress;
    playbackRateTotal += playbackRateForMotorRatio(motorRatio);
  }

  return (playbackRateTotal / steps) * (duration / 1000);
}

const MOTOR_REWIND_SECONDS = getIntegratedRampPlaybackSeconds(false)
  + getIntegratedRampPlaybackSeconds(true)
  - MOTOR_REWIND_TRIM_SECONDS;

function seekAudio(timestamp) {
  return new Promise((resolve) => {
    let timeout;
    const finish = () => {
      clearTimeout(timeout);
      audio.removeEventListener("seeked", finish);
      resolve();
    };

    audio.addEventListener("seeked", finish, { once: true });
    timeout = setTimeout(finish, 1200);
    audio.currentTime = timestamp;
  });
}

function startMotorTransition(running) {
  const cruiseSpeed = 1 / SECONDS_PER_TURN;
  const targetSpeed = running ? cruiseSpeed : 0;
  const fullDuration = running ? MOTOR_ACCEL_DURATION_MS : MOTOR_DECEL_DURATION_MS;
  const distanceRatio = Math.abs(targetSpeed - visualSpeed) / cruiseSpeed;

  motorRunning = running;
  motorTransition = {
    running,
    startTime: performance.now(),
    startSpeed: visualSpeed,
    targetSpeed,
    duration: fullDuration * distanceRatio,
  };
  return motorTransition;
}

function setVinylPlaybackRate() {
  if (!VINYL_PITCH_MOTOR.enabled || audio.paused) return;
  const cruiseSpeed = 1 / SECONDS_PER_TURN;
  const motorRatio = Math.min(1, Math.max(0, visualSpeed / cruiseSpeed));
  audio.playbackRate = playbackRateForMotorRatio(motorRatio);
  audio.volume = motorRatio >= VINYL_PITCH_MOTOR.cruiseSnapRatio ? 1 : easeVolume(motorRatio);
}

function beginMotorStop() {
  if (!VINYL_PITCH_MOTOR.enabled) {
    audio.pause();
    return;
  }
  startMotorTransition(false);
  pendingMotorPause = true;
  setState("stopping");
}

function renderDisc(frameTime) {
  if (previousFrameTime === undefined) previousFrameTime = frameTime;
  const elapsed = Math.min((frameTime - previousFrameTime) / 1000, 0.05);
  previousFrameTime = frameTime;

  if (motorTransition) {
    const progress = motorTransition.duration === 0
      ? 1
      : Math.min(1, (frameTime - motorTransition.startTime) / motorTransition.duration);
    const naturalProgress = easeInOutSine(progress);
    // The stop holds near cruise speed a little longer to offset the way a
    // falling pitch is perceived as more abrupt than a rising one.
    const perceptualProgress = motorTransition.running
      ? naturalProgress
      : naturalProgress ** 1.25;
    visualSpeed = motorTransition.startSpeed
      + (motorTransition.targetSpeed - motorTransition.startSpeed) * perceptualProgress;

    if (progress === 1) {
      visualSpeed = motorTransition.targetSpeed;
      motorTransition = null;
    }
  }

  if (!reducedMotion.matches) {
    visualTurns += visualSpeed * elapsed;
    artwork.style.transform = `rotate(${visualTurns * 360}deg)`;
  }

  setVinylPlaybackRate();

  if (pendingMotorPause && !motorTransition && visualSpeed === 0) {
    pendingMotorPause = false;
    audio.volume = 0;
    audio.pause();
    audio.playbackRate = 1;
  }

  requestAnimationFrame(renderDisc);
}

async function loadRelease() {
  try {
    const configUrl = getConfigUrl();
    configBaseUrl = configUrl;
    const response = await fetch(configUrl);
    if (!response.ok) throw new Error(`Config returned ${response.status}`);
    config = await response.json();
    const missing = REQUIRED_FIELDS.filter((field) => !config[field]);
    if (missing.length) throw new Error(`Missing config fields: ${missing.join(", ")}`);

    document.title = config.title;
    document.documentElement.style.setProperty("--accent", config.accentColor || "#e5644e");
    title.textContent = config.title;
    artist.textContent = config.artist;
    edition.textContent = config.edition || "";
    edition.hidden = !config.edition;

    const artworkUrl = resolveAsset(config.artwork);
    // Anonymous CORS is required for pixel sampling when artwork is hosted on S3.
    artwork.crossOrigin = "anonymous";
    artwork.src = artworkUrl;
    artwork.alt = `${config.title} artwork`;
    player.style.setProperty("--artwork-image", `url("${artworkUrl.replaceAll('"', '\\"')}")`);
    await setAudioSource(resolveAsset(config.audio));
    configureVinylPitchMotor();
    audio.load();

    await artwork.decode();
    try {
      document.documentElement.style.setProperty("--accent", extractAccent(artwork));
    } catch (accentError) {
      console.warn("Artwork accent extraction unavailable; using fallback.", accentError);
    }
    setState("ready");
  } catch (error) {
    console.error(error);
    setState("error", error.message || "This release could not be loaded. Check config.json and asset paths.");
  }
}

async function lockPortraitOrientation() {
  if (!screen.orientation?.lock) return;
  try {
    await screen.orientation.lock("portrait");
  } catch {
    // Orientation locking is an enhancement and is unsupported on iOS Safari.
  }
}

function requestFullscreenOnce() {
  if (!firstPlayAttempt) return;
  firstPlayAttempt = false;
  // Fullscreen is an enhancement and must be requested from the same trusted gesture.
  if (document.fullscreenEnabled && player.requestFullscreen) {
    player.requestFullscreen({ navigationUI: "hide" })
      .then(lockPortraitOrientation)
      .catch(() => {});
  }
}

async function play({ requestFullscreen = true } = {}) {
  if (requestFullscreen) requestFullscreenOnce();
  if (state === "ended") audio.currentTime = 0;
  const isFirstStart = !hasStartedPlayback;
  let desiredResumeTimestamp = null;
  let needsMotorStart = false;
  pendingMotorPause = false;
  if (VINYL_PITCH_MOTOR.enabled) {
    if (isFirstStart) {
      motorRunning = true;
      motorTransition = null;
      visualSpeed = 1 / SECONDS_PER_TURN;
      audio.playbackRate = 1;
      audio.volume = 1;
    } else {
      motorRunning = false;
      motorTransition = null;
      needsMotorStart = true;
      const cruiseSpeed = 1 / SECONDS_PER_TURN;
      const motorRatio = Math.min(1, Math.max(0, visualSpeed / cruiseSpeed));
      // Rewind by the audio consumed across both ramps. After the upcoming
      // spin-up, normal-speed playback lands where the prior coast-down began.
      desiredResumeTimestamp = Math.max(0, audio.currentTime - MOTOR_REWIND_SECONDS);
      audio.playbackRate = playbackRateForMotorRatio(motorRatio);
      audio.volume = easeVolume(motorRatio);
    }
  } else {
    motorRunning = true;
  }
  try {
    await audio.play();
    if (desiredResumeTimestamp !== null) await seekAudio(desiredResumeTimestamp);
    if (needsMotorStart) startMotorTransition(true);
    setState("playing");
  } catch (error) {
    motorRunning = false;
    motorTransition = null;
    console.error(error);
    setState("paused", "Playback was blocked. Tap once more to retry.");
  }
}

button.addEventListener("click", () => {
  if (!config || state === "loading") return;
  if (state === "playing" && motorRunning) beginMotorStop();
  else play();
});

audio.addEventListener("playing", () => {
  motorRunning = true;
  if (!hasStartedPlayback) {
    player.dataset.firstPlayback = "true";
    hasStartedPlayback = true;
  } else {
    delete player.dataset.firstPlayback;
  }
  setState("playing");
});
audio.addEventListener("pause", () => {
  motorRunning = false;
  pendingMotorPause = false;
  delete player.dataset.firstPlayback;
  if (!audio.ended) setState("paused");
});
audio.addEventListener("ended", () => {
  pendingMotorPause = false;
  if (VINYL_PITCH_MOTOR.enabled && visualSpeed > 0) startMotorTransition(false);
  else motorRunning = false;
  setState("ended");
});
audio.addEventListener("error", () => setState("error", "Audio could not be loaded. Check the file path or S3 CORS policy."));

requestAnimationFrame(renderDisc);
loadRelease();
