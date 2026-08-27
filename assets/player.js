import { renderDiscographyLists } from "./discography-list.js";

const REQUIRED_FIELDS = ["title", "artist", "artwork"];
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
const releaseMeta = document.querySelector(".release-meta");
const releaseFooter = document.querySelector(".release-footer");
const button = document.querySelector("[data-disc-button]");
const artwork = document.querySelector("[data-artwork]");
const title = document.querySelector("[data-title]");
const artist = document.querySelector("[data-artist]");
const edition = document.querySelector("[data-edition]");
const status = document.querySelector("[data-status]");
const trackDock = document.querySelector("[data-track-dock]");
const trackTitle = document.querySelector("[data-track-title]");
const trackPosition = document.querySelector("[data-track-position]");
const previousTrackButton = document.querySelector("[data-previous-track]");
const nextTrackButton = document.querySelector("[data-next-track]");
const drawerToggle = document.querySelector("[data-drawer-toggle]");
const drawerPeek = document.querySelector("[data-drawer-peek]");
const drawerClose = document.querySelector("[data-drawer-close]");
const lyricsDrawer = document.querySelector("[data-lyrics-drawer]");
const drawerTitle = document.querySelector("[data-drawer-title]");
const drawerArtist = document.querySelector("[data-drawer-artist]");
const lyrics = document.querySelector("[data-lyrics]");
const about = document.querySelector("[data-about]");
const credits = document.querySelector("[data-credits]");
const drawerContent = document.querySelector("[data-drawer-content]");
const drawerTabs = [...document.querySelectorAll("[data-drawer-tab]")];
const drawerPanels = [...document.querySelectorAll("[data-drawer-panel]")];
const discographyToggle = document.querySelector("[data-discography-toggle]");
const discographyOverlay = document.querySelector("[data-discography]");
const discographyClose = document.querySelector("[data-discography-close]");
const discographyAudioList = document.querySelector("[data-discography-audio-list]");
const discographyVideoList = document.querySelector("[data-discography-video-list]");
const videoViewer = document.querySelector("[data-video-viewer]");
const videoPlayer = document.querySelector("[data-video-player]");
const videoClose = document.querySelector("[data-video-close]");
if (new URLSearchParams(location.search).has("video")) {
  document.documentElement.classList.add("video-entry");
}
const audio = document.querySelector("audio");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
const RELEASE_TRANSITION_DURATION_MS = 760;

let incomingReleaseTransition = null;
try {
  const savedTransition = JSON.parse(sessionStorage.getItem("release-transition") || "null");
  sessionStorage.removeItem("release-transition");
  if (savedTransition?.path === location.pathname
    && Date.now() - savedTransition.startedAt < 5000) {
    incomingReleaseTransition = savedTransition;
    player.dataset.releaseArriving = "true";
  }
} catch {}

// Keeps automated interaction checks silent without changing normal playback.
if (new URLSearchParams(location.search).has("test-muted")) audio.muted = true;

let config;
let configBaseUrl;
let bufferedAudioUrl;
let tracks = [];
let currentTrackIndex = 0;
let state = "loading";
let firstPlayAttempt = true;
let hasStartedPlayback = false;
let visualTurns = 0;
let visualSpeed = 0;
let previousFrameTime;
let motorRunning = false;
let pendingMotorPause = false;
let motorTransition = null;
let endLanding = null;
let switchingTrack = false;
let drawerVerticalGesture = null;
let suppressDrawerToggleClick = false;
let activeDrawerTab = "lyrics";
let contentSwipeStart = null;
let discographyNavigating = false;
let controlsRevealTimer = null;

function resolveAsset(path) {
  return new URL(path, configBaseUrl).href;
}

function currentTrack() {
  return tracks[currentTrackIndex];
}

function setControlsVisible(visible) {
  clearTimeout(controlsRevealTimer);
  controlsRevealTimer = null;
  player.dataset.controlsVisible = String(visible);
  if (visible) {
    delete player.dataset.firstPlayback;
    controlsRevealTimer = setTimeout(() => {
      player.dataset.controlsVisible = "false";
      controlsRevealTimer = null;
    }, 4000);
  }
}

function normalizeTracks(release) {
  if (Array.isArray(release.tracks) && release.tracks.length) {
    return release.tracks.map((track, index) => {
      if (!track?.title || !track?.audio) {
        throw new Error(`Track ${index + 1} requires title and audio`);
      }
      return { ...track, artist: track.artist || release.artist };
    });
  }
  if (!release.audio) throw new Error("Release requires audio or a non-empty tracks array");
  return [{
    title: release.title,
    artist: release.artist,
    audio: release.audio,
    lyrics: release.lyrics || "",
    about: release.about || "",
  }];
}

function availableDrawerTabs() {
  return drawerTabs.filter((tab) => !tab.hidden).map((tab) => tab.dataset.drawerTab);
}

function renderMarkdown(container, markdown) {
  container.replaceChildren();
  const linkPattern = /\[([^\]\n]+)\]\(([^\s)]+)\)/g;
  let cursor = 0;
  let match;

  while ((match = linkPattern.exec(markdown))) {
    container.append(document.createTextNode(markdown.slice(cursor, match.index)));

    let url;
    try {
      url = new URL(match[2], document.baseURI);
    } catch {
      url = null;
    }
    if (!url || !["http:", "https:", "mailto:"].includes(url.protocol)) {
      container.append(document.createTextNode(match[0]));
    } else {
      const link = document.createElement("a");
      link.href = url.href;
      link.textContent = match[1];
      if (["http:", "https:"].includes(url.protocol)) {
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
      container.append(link);
    }
    cursor = match.index + match[0].length;
  }

  container.append(document.createTextNode(markdown.slice(cursor)));
}

function setActiveDrawerTab(name) {
  const available = availableDrawerTabs();
  if (!available.includes(name)) name = available[0] || "lyrics";
  activeDrawerTab = name;
  drawerContent.scrollTop = 0;
  for (const tab of drawerTabs) {
    const selected = tab.dataset.drawerTab === name && !tab.hidden;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const panel of drawerPanels) {
    panel.style.removeProperty("transform");
    panel.style.removeProperty("opacity");
    panel.hidden = panel.dataset.drawerPanel !== name || !available.includes(name);
  }
}

function updateTrackUi() {
  const track = currentTrack();
  artwork.style.setProperty("--track-angle", `${currentTrackIndex * (360 / tracks.length)}deg`);
  trackTitle.textContent = track.title;
  trackPosition.textContent = tracks.length > 1
    ? `Track ${currentTrackIndex + 1} of ${tracks.length}`
    : "Now playing";
  drawerTitle.textContent = track.title;
  drawerArtist.textContent = track.artist;
  const lyricsText = track.lyrics?.trim() || "";
  const aboutText = track.about?.trim() || "";
  const creditsText = config?.credits?.trim() || "";
  const hasDrawerContent = Boolean(lyricsText || aboutText || creditsText);
  player.dataset.hasDrawerContent = String(hasDrawerContent);
  drawerToggle.disabled = !hasDrawerContent;
  if (!hasDrawerContent && player.dataset.drawerOpen === "true") setDrawerOpen(false);
  lyrics.textContent = lyricsText;
  renderMarkdown(about, aboutText);
  renderMarkdown(credits, creditsText);
  drawerTabs.find((tab) => tab.dataset.drawerTab === "lyrics").hidden = !lyricsText;
  drawerTabs.find((tab) => tab.dataset.drawerTab === "about").hidden = !aboutText;
  drawerTabs.find((tab) => tab.dataset.drawerTab === "credits").hidden = !creditsText;
  setActiveDrawerTab(lyricsText ? "lyrics" : aboutText ? "about" : "credits");
  const hasPreviousTrack = currentTrackIndex > 0;
  const hasNextTrack = currentTrackIndex < tracks.length - 1;
  previousTrackButton.disabled = !hasPreviousTrack;
  nextTrackButton.disabled = !hasNextTrack;
  previousTrackButton.setAttribute("aria-label", hasPreviousTrack
    ? `Previous track: ${tracks[currentTrackIndex - 1].title}`
    : "Previous track");
  nextTrackButton.setAttribute("aria-label", hasNextTrack
    ? `Next track: ${tracks[currentTrackIndex + 1].title}`
    : "Next track");
}

function setDrawerOpen(open) {
  if (open && player.dataset.hasDrawerContent !== "true") return;
  player.dataset.drawerOpen = String(open);
  lyricsDrawer.setAttribute("aria-hidden", String(!open));
  drawerToggle.setAttribute("aria-expanded", String(open));
  drawerPeek.setAttribute("aria-expanded", String(open));
  drawerPeek.setAttribute("aria-label", open ? "Close track information" : "Open track information");
  if (open) lyricsDrawer.scrollTop = 0;
}

function setDiscographyOpen(open) {
  if (open) delete player.dataset.discographyAttention;
  player.dataset.discographyOpen = String(open);
  discographyOverlay.setAttribute("aria-hidden", String(!open));
  discographyToggle.setAttribute("aria-expanded", String(open));
  discographyToggle.setAttribute("aria-label", open ? "Close discography" : "Open discography");
  if (open) {
    setDrawerOpen(false);
    discographyOverlay.scrollTop = 0;
    const currentReleaseArtwork = discographyAudioList.querySelector('.discography-release[aria-current="page"] img');
    if (currentReleaseArtwork) {
      const trackAngle = tracks.length ? currentTrackIndex * (360 / tracks.length) : 0;
      currentReleaseArtwork.style.setProperty("--discography-angle", `${trackAngle}deg`);
      currentReleaseArtwork.style.animationDelay = `${-(visualTurns % 1) * SECONDS_PER_TURN}s`;
    }
    discographyClose.focus({ preventScroll: true });
  } else {
    discographyToggle.focus({ preventScroll: true });
  }
}

async function loadDiscography() {
  try {
    const catalogUrl = new URL(document.body.dataset.discography || "../discography.json", document.baseURI);
    const response = await fetch(catalogUrl);
    if (!response.ok) throw new Error(`Discography returned ${response.status}`);
    const releases = await response.json();
    const currentPath = location.pathname.replace(/\/+$/, "") + "/";
    renderDiscographyLists({
      catalog: releases,
      audioList: discographyAudioList,
      videoList: discographyVideoList,
      currentPath,
      testMuted: new URLSearchParams(location.search).has("test-muted"),
    });
  } catch (error) {
    console.error(error);
    discographyAudioList.replaceChildren();
    discographyVideoList.replaceChildren();
    const message = document.createElement("p");
    message.textContent = "Discography could not be loaded.";
    discographyAudioList.append(message);
  }
}

function closeVideoViewer({ restoreHistory = true } = {}) {
  if (videoViewer.getAttribute("aria-hidden") === "true") return;
  videoPlayer.pause();
  videoPlayer.removeAttribute("src");
  videoPlayer.load();
  videoViewer.setAttribute("aria-hidden", "true");
  if (restoreHistory && history.state?.videoViewer) history.back();
  discographyClose.focus({ preventScroll: true });
}

function openVideoViewer(source, title) {
  audio.pause();
  videoPlayer.src = new URL(source, document.baseURI).href;
  videoPlayer.setAttribute("aria-label", title || "Video");
  videoViewer.setAttribute("aria-hidden", "false");
  requestVideoFullscreen();
  history.pushState({ ...history.state, videoViewer: true }, "", `${location.pathname}${location.search}#video`);
  videoPlayer.play().catch(() => {});
}

async function prepareDiscographyNavigation(event) {
  const link = event.target.closest(".discography-release");
  if (!link || discographyNavigating) return;
  const selectedArtwork = link.querySelector("img, video");
  if (!selectedArtwork) return;
  if (link.classList.contains("discography-video")) {
    event.preventDefault();
    player.dataset.videoNavigating = "true";
    player.dataset.discographyOpen = "false";
    discographyOverlay.setAttribute("aria-hidden", "true");
    location.assign(link.href);
    return;
  }
  if (link.matches('[aria-current="page"]') && !audio.paused) {
    event.preventDefault();
    setDiscographyOpen(false);
    return;
  }
  if (reducedMotion.matches) return;
  try {
    sessionStorage.setItem("release-transition", JSON.stringify({
      path: new URL(link.href).pathname,
      startedAt: Date.now(),
    }));
  } catch {}
  if ("startViewTransition" in document && CSS.supports("view-transition-name", "release-disc")) {
    artwork.style.viewTransitionName = "none";
    selectedArtwork.style.viewTransitionName = "release-disc";
    return;
  }

  event.preventDefault();
  discographyNavigating = true;
  const source = selectedArtwork.getBoundingClientRect();
  const target = artwork.getBoundingClientRect();
  const clone = selectedArtwork.cloneNode();
  clone.className = "discography-flight";
  Object.assign(clone.style, {
    top: `${source.top}px`,
    left: `${source.left}px`,
    width: `${source.width}px`,
    height: `${source.height}px`,
  });
  document.body.append(clone);
  player.dataset.discographyOpen = "false";
  discographyOverlay.setAttribute("aria-hidden", "true");

  const deltaX = target.left - source.left;
  const deltaY = target.top - source.top;
  const scaleX = target.width / source.width;
  const scaleY = target.height / source.height;
  try {
    await clone.animate([
      { transform: "translate3d(0, 0, 0) scale(1)", boxShadow: "0 1rem 3rem rgba(0, 0, 0, 0.38)" },
      { transform: `translate3d(${deltaX}px, ${deltaY}px, 0) scale(${scaleX}, ${scaleY})`, boxShadow: "0 2rem 6rem rgba(0, 0, 0, 0.5)" },
    ], { duration: 720, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)", fill: "forwards" }).finished;
  } finally {
    location.assign(link.href);
  }
}

async function setAudioSource(sourceUrl) {
  const isLocalPreview = ["localhost", "127.0.0.1"].includes(location.hostname);
  const sourceIsLocal = new URL(sourceUrl).origin === location.origin;
  if (!isLocalPreview || !sourceIsLocal) {
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
  if (next === "ended" && currentTrackIndex === tracks.length - 1) {
    player.dataset.discographyAttention = "true";
  } else {
    delete player.dataset.discographyAttention;
  }
  if (next !== "playing" || player.dataset.controlsVisible !== "true") setControlsVisible(false);
  button.disabled = next === "loading" || next === "ending";

  const action = {
    loading: "Loading",
    ready: "Play",
    playing: "Pause",
    stopping: "Resume",
    ending: "Finishing",
    paused: "Resume",
    ended: "Replay",
    error: "Retry",
  }[next];
  const track = currentTrack();
  button.setAttribute("aria-label", track ? `${action} ${track.title} by ${track.artist}` : action);
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

function beginEndLanding() {
  pendingMotorPause = false;
  motorTransition = null;
  releaseMeta.style.transition = "none";
  releaseFooter.style.transition = "none";
  releaseMeta.style.opacity = "0";
  releaseFooter.style.opacity = "0";

  if (reducedMotion.matches || visualSpeed <= 0) {
    motorRunning = false;
    visualSpeed = 0;
    visualTurns = Math.round(visualTurns);
    artwork.style.transform = `rotate(${visualTurns * 360}deg)`;
    setState("ended");
    releaseMeta.style.removeProperty("transition");
    releaseFooter.style.removeProperty("transition");
    releaseMeta.style.removeProperty("opacity");
    releaseFooter.style.removeProperty("opacity");
    return;
  }

  endLanding = true;
  startMotorTransition(false);
}

function renderDisc(frameTime) {
  if (previousFrameTime === undefined) previousFrameTime = frameTime;
  const elapsed = Math.min((frameTime - previousFrameTime) / 1000, 0.05);
  previousFrameTime = frameTime;

  let completedEndLanding = false;
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
      if (endLanding) {
        // Once the natural drift stops, the resting transition takes the
        // shortest route back to the artwork's upright orientation.
        visualTurns = Math.round(visualTurns);
        endLanding = null;
        completedEndLanding = true;
      }
    }
  }

  if (!reducedMotion.matches) {
    visualTurns += visualSpeed * elapsed;
    artwork.style.transform = `rotate(${visualTurns * 360}deg)`;
  }

  if (completedEndLanding) {
    setState("ended");
    releaseMeta.style.removeProperty("transition");
    releaseFooter.style.removeProperty("transition");
    releaseMeta.style.removeProperty("opacity");
    releaseFooter.style.removeProperty("opacity");
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
    tracks = normalizeTracks(config);
    currentTrackIndex = 0;
    player.dataset.multitrack = String(tracks.length > 1);

    document.title = config.title;
    document.documentElement.style.setProperty("--accent", config.accentColor || "#e5644e");
    title.textContent = config.title;
    artist.textContent = config.artist;
    edition.textContent = config.edition || "";
    edition.hidden = !config.edition;
    updateTrackUi();

    const artworkUrl = resolveAsset(config.displayArtwork || config.artwork);
    artwork.alt = `${config.title} artwork`;
    artwork.crossOrigin = "anonymous";
    artwork.src = artworkUrl;
    player.style.setProperty("--artwork-image", `url("${artworkUrl.replaceAll('"', '\\"')}")`);
    const artworkReady = artwork.decode().then(() => {
      try {
        document.documentElement.style.setProperty("--accent", extractAccent(artwork));
      } catch (accentError) {
        console.warn("Artwork accent extraction unavailable; using fallback.", accentError);
      }
      player.dataset.artworkReady = "true";
    });
    const audioReady = setAudioSource(resolveAsset(currentTrack().audio)).then(() => {
      configureVinylPitchMotor();
      audio.load();
    });

    await Promise.all([artworkReady, audioReady]);
    setState("ready");
    const directVideo = player.dataset.videoUrl || currentTrack()?.video || config.video;
    if (directVideo && new URLSearchParams(location.search).has("video")) {
      openVideoViewer(directVideo, currentTrack()?.title || config.title);
    }
    if (new URLSearchParams(location.search).has("autoplay")) {
      const cleanUrl = new URL(location.href);
      cleanUrl.searchParams.delete("autoplay");
      history.replaceState(history.state, "", cleanUrl);
      firstPlayAttempt = false;
      if (incomingReleaseTransition) {
        const remainingTransition = RELEASE_TRANSITION_DURATION_MS
          - (Date.now() - incomingReleaseTransition.startedAt);
        if (remainingTransition > 0) {
          await new Promise((resolve) => setTimeout(resolve, remainingTransition));
        }
      }
      delete player.dataset.releaseArriving;
      incomingReleaseTransition = null;
      await play({ requestFullscreen: false });
    }
  } catch (error) {
    console.error(error);
    setState("error", error.message || "This release could not be loaded. Check config.json and asset paths.");
  }
}

async function switchTrack(index, { autoplay = !audio.paused } = {}) {
  if (switchingTrack || index < 0 || index >= tracks.length || index === currentTrackIndex) return;
  switchingTrack = true;
  endLanding = null;
  pendingMotorPause = false;
  motorTransition = null;
  setState("loading");
  audio.pause();
  currentTrackIndex = index;
  updateTrackUi();

  try {
    await setAudioSource(resolveAsset(currentTrack().audio));
    configureVinylPitchMotor();
    audio.load();
    if (autoplay) {
      visualSpeed = 1 / SECONDS_PER_TURN;
      motorRunning = true;
      audio.playbackRate = 1;
      audio.volume = 1;
      await audio.play();
      setState("playing");
    } else {
      motorRunning = false;
      setState(hasStartedPlayback ? "paused" : "ready");
    }
  } catch (error) {
    console.error(error);
    setState("error", "This track could not be loaded.");
  } finally {
    switchingTrack = false;
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

function requestVideoFullscreen() {
  screen.orientation?.unlock?.();
  if (document.fullscreenEnabled && videoViewer.requestFullscreen) {
    videoViewer.requestFullscreen({ navigationUI: "hide" }).catch(() => {});
  }
}

async function play({ requestFullscreen = true } = {}) {
  if (requestFullscreen) requestFullscreenOnce();
  const replayingEndedTrack = audio.ended || state === "ending" || state === "ended";
  if (replayingEndedTrack) {
    audio.currentTime = 0;
    releaseMeta.style.removeProperty("transition");
    releaseFooter.style.removeProperty("transition");
    releaseMeta.style.removeProperty("opacity");
    releaseFooter.style.removeProperty("opacity");
  }
  const isFirstStart = !hasStartedPlayback;
  let desiredResumeTimestamp = null;
  let needsMotorStart = false;
  endLanding = null;
  pendingMotorPause = false;
  if (VINYL_PITCH_MOTOR.enabled) {
    if (isFirstStart || replayingEndedTrack) {
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

previousTrackButton.addEventListener("click", () => {
  switchTrack(currentTrackIndex - 1);
});
nextTrackButton.addEventListener("click", () => {
  switchTrack(currentTrackIndex + 1);
});
drawerToggle.addEventListener("click", () => {
  if (suppressDrawerToggleClick) {
    suppressDrawerToggleClick = false;
    return;
  }
  setDrawerOpen(player.dataset.drawerOpen !== "true");
});
drawerClose.addEventListener("click", () => setDrawerOpen(false));
drawerPeek.addEventListener("click", () => setDrawerOpen(player.dataset.drawerOpen !== "true"));
discographyToggle.addEventListener("click", () => setDiscographyOpen(player.dataset.discographyOpen !== "true"));
discographyClose.addEventListener("click", () => setDiscographyOpen(false));
discographyOverlay.addEventListener("click", prepareDiscographyNavigation);
videoClose.addEventListener("click", () => {
  if (videoViewer.getAttribute("aria-hidden") !== "true") location.assign("/");
});
videoPlayer.addEventListener("click", () => {
  if (videoPlayer.paused) videoPlayer.play().catch(() => {});
  else videoPlayer.pause();
});
videoPlayer.addEventListener("ended", () => closeVideoViewer());
window.addEventListener("popstate", () => closeVideoViewer({ restoreHistory: false }));
player.addEventListener("click", (event) => {
  if (state !== "playing") return;
  if (event.target.closest("button, a, .lyrics-drawer, .discography-overlay, .track-dock")) return;
  setControlsVisible(player.dataset.controlsVisible !== "true");
});
window.addEventListener("pageshow", () => {
  artwork.style.removeProperty("view-transition-name");
  for (const image of discographyAudioList.querySelectorAll("img")) image.style.removeProperty("view-transition-name");
});
for (const tab of drawerTabs) {
  tab.addEventListener("click", () => setActiveDrawerTab(tab.dataset.drawerTab));
}

async function finishContentSwipe(endX, endY) {
  const swipe = contentSwipeStart;
  if (!swipe) return;
  contentSwipeStart = null;
  const deltaX = endX - swipe.x;
  const deltaY = endY - swipe.y;
  const available = availableDrawerTabs();
  const index = available.indexOf(activeDrawerTab);
  const nextIndex = deltaX < 0 ? index + 1 : index - 1;
  const nextTab = available[nextIndex];
  if (swipe.axis !== "x") {
    swipe.panel.style.removeProperty("transform");
    swipe.panel.style.removeProperty("opacity");
    return;
  }
  const changesTab = swipe.axis === "x"
    && Math.abs(deltaX) > 42
    && Math.abs(deltaX) > Math.abs(deltaY) * 1.2
    && nextTab;
  const duration = reducedMotion.matches ? 1 : 220;
  const currentTransform = swipe.panel.style.transform || `translate3d(${deltaX}px, 0, 0)`;

  if (!changesTab) {
    await swipe.panel.animate([
      { transform: currentTransform, opacity: swipe.panel.style.opacity || 1 },
      { transform: "translate3d(0, 0, 0)", opacity: 1 },
    ], { duration, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" }).finished;
    swipe.panel.style.removeProperty("transform");
    swipe.panel.style.removeProperty("opacity");
    return;
  }

  const direction = Math.sign(deltaX);
  await swipe.panel.animate([
    { transform: currentTransform, opacity: swipe.panel.style.opacity || 1 },
    { transform: `translate3d(${direction * drawerContent.clientWidth}px, 0, 0)`, opacity: 0 },
  ], { duration, easing: "cubic-bezier(0.4, 0, 1, 1)" }).finished;
  setActiveDrawerTab(nextTab);
  const nextPanel = drawerPanels.find((panel) => panel.dataset.drawerPanel === nextTab);
  await nextPanel.animate([
    { transform: `translate3d(${-direction * Math.min(drawerContent.clientWidth * 0.35, 180)}px, 0, 0)`, opacity: 0 },
    { transform: "translate3d(0, 0, 0)", opacity: 1 },
  ], { duration, easing: "cubic-bezier(0, 0, 0.2, 1)" }).finished;
}

drawerContent.addEventListener("pointerdown", (event) => {
  if (!event.isPrimary) return;
  const panel = drawerPanels.find((candidate) => !candidate.hidden);
  contentSwipeStart = panel
    ? { x: event.clientX, y: event.clientY, pointerId: event.pointerId, axis: null, panel }
    : null;
});
drawerContent.addEventListener("pointermove", (event) => {
  const swipe = contentSwipeStart;
  if (!swipe || event.pointerId !== swipe.pointerId) return;
  const deltaX = event.clientX - swipe.x;
  const deltaY = event.clientY - swipe.y;
  if (!swipe.axis && Math.hypot(deltaX, deltaY) >= 7) {
    swipe.axis = Math.abs(deltaX) > Math.abs(deltaY) ? "x" : "y";
    if (swipe.axis === "x") drawerContent.setPointerCapture(event.pointerId);
  }
  if (swipe.axis !== "x") return;
  event.preventDefault();
  const resistedDelta = deltaX * 0.92;
  swipe.panel.style.transform = `translate3d(${resistedDelta}px, 0, 0)`;
  swipe.panel.style.opacity = String(Math.max(0.55, 1 - Math.abs(deltaX) / drawerContent.clientWidth * 0.45));
});
drawerContent.addEventListener("pointerup", (event) => finishContentSwipe(event.clientX, event.clientY));
drawerContent.addEventListener("pointercancel", (event) => finishContentSwipe(event.clientX, event.clientY));

function beginDrawerVerticalGesture(x, y, direction) {
  drawerVerticalGesture = { x, y, direction };
}

function finishDrawerVerticalGesture(x, y) {
  const gesture = drawerVerticalGesture;
  drawerVerticalGesture = null;
  if (!gesture) return;
  const deltaX = x - gesture.x;
  const deltaY = y - gesture.y;
  if (Math.abs(deltaY) <= 42 || Math.abs(deltaY) <= Math.abs(deltaX) * 1.15) return;
  if (gesture.direction === "open" && deltaY < 0) {
    suppressDrawerToggleClick = true;
    setDrawerOpen(true);
  } else if (gesture.direction === "close" && deltaY > 0) {
    setDrawerOpen(false);
  }
}

player.addEventListener("pointerdown", (event) => {
  if (!event.isPrimary || event.pointerType === "touch" || player.dataset.drawerOpen === "true") return;
  if (player.dataset.discographyOpen === "true" || event.target.closest(".track-controls, .discography-toggle")) return;
  if (event.clientY >= innerHeight * 0.55) beginDrawerVerticalGesture(event.clientX, event.clientY, "open");
});
player.addEventListener("pointerup", (event) => {
  if (event.pointerType !== "touch") finishDrawerVerticalGesture(event.clientX, event.clientY);
});

player.addEventListener("touchstart", (event) => {
  if (player.dataset.drawerOpen === "true" || player.dataset.discographyOpen === "true") return;
  if (event.target.closest(".track-controls, .discography-toggle")) return;
  const touch = event.touches[0];
  if (touch && touch.clientY >= innerHeight * 0.55) beginDrawerVerticalGesture(touch.clientX, touch.clientY, "open");
}, { passive: true });
player.addEventListener("touchend", (event) => {
  if (player.dataset.drawerOpen === "true" || drawerVerticalGesture?.direction !== "open") return;
  const touch = event.changedTouches[0];
  if (touch) finishDrawerVerticalGesture(touch.clientX, touch.clientY);
}, { passive: true });

lyricsDrawer.addEventListener("pointerdown", (event) => {
  if (!event.isPrimary || event.pointerType === "touch" || player.dataset.drawerOpen !== "true") return;
  const startsInScrollableContent = Boolean(event.target.closest("[data-drawer-content]"));
  if (!startsInScrollableContent || drawerContent.scrollTop <= 0) {
    beginDrawerVerticalGesture(event.clientX, event.clientY, "close");
  }
});
lyricsDrawer.addEventListener("pointerup", (event) => {
  if (event.pointerType !== "touch" && drawerVerticalGesture?.direction === "close") {
    finishDrawerVerticalGesture(event.clientX, event.clientY);
  }
});
lyricsDrawer.addEventListener("touchstart", (event) => {
  if (player.dataset.drawerOpen !== "true") return;
  const startsInScrollableContent = Boolean(event.target.closest("[data-drawer-content]"));
  if (startsInScrollableContent && drawerContent.scrollTop > 0) return;
  const touch = event.touches[0];
  if (touch) beginDrawerVerticalGesture(touch.clientX, touch.clientY, "close");
}, { passive: true });
lyricsDrawer.addEventListener("touchmove", (event) => {
  const gesture = drawerVerticalGesture;
  const touch = event.touches[0];
  if (!gesture || gesture.direction !== "close" || !touch) return;
  const deltaX = touch.clientX - gesture.x;
  const deltaY = touch.clientY - gesture.y;
  if (deltaY > 42 && deltaY > Math.abs(deltaX) * 1.15) {
    drawerVerticalGesture = null;
    setDrawerOpen(false);
  }
}, { passive: true });
lyricsDrawer.addEventListener("touchend", (event) => {
  if (drawerVerticalGesture?.direction !== "close") return;
  const touch = event.changedTouches[0];
  if (touch) finishDrawerVerticalGesture(touch.clientX, touch.clientY);
}, { passive: true });
lyricsDrawer.addEventListener("touchcancel", () => { drawerVerticalGesture = null; }, { passive: true });
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && player.dataset.discographyOpen === "true") {
    setDiscographyOpen(false);
    return;
  }
  if (event.key === "Escape" && player.dataset.drawerOpen === "true") setDrawerOpen(false);
  if (event.key === "Tab" && player.dataset.discographyOpen === "true") {
    const focusable = [...discographyOverlay.querySelectorAll("a[href], button:not([disabled])")];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});

audio.addEventListener("playing", () => {
  motorRunning = true;
  player.dataset.hasStarted = "true";
  if (!hasStartedPlayback) {
    player.dataset.firstPlayback = "true";
    hasStartedPlayback = true;
  } else {
    delete player.dataset.firstPlayback;
  }
  setState("playing");
});
audio.addEventListener("pause", () => {
  if (switchingTrack) return;
  motorRunning = false;
  pendingMotorPause = false;
  delete player.dataset.firstPlayback;
  if (!audio.ended) setState("paused");
});
audio.addEventListener("ended", () => {
  if (currentTrackIndex < tracks.length - 1) {
    switchTrack(currentTrackIndex + 1, { autoplay: true });
    return;
  }
  if (VINYL_PITCH_MOTOR.enabled) {
    setState("ending");
    beginEndLanding();
  } else {
    motorRunning = false;
    setState("ended");
  }
});
audio.addEventListener("error", () => setState("error", "Audio could not be loaded. Check the file path or S3 CORS policy."));

requestAnimationFrame(renderDisc);
loadDiscography();
loadRelease();
