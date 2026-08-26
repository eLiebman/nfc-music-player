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
const videoDrawer = document.querySelector("[data-video-drawer]");
const video = document.querySelector("[data-video]");
const videoStatus = document.querySelector("[data-video-status]");
const videoPeek = document.querySelector("[data-video-peek]");
const videoShell = document.querySelector("[data-video-shell]");
const drawerTabs = [...document.querySelectorAll("[data-drawer-tab]")];
const drawerPanels = [...document.querySelectorAll("[data-drawer-panel]")];
const discographyToggle = document.querySelector("[data-discography-toggle]");
const discographyOverlay = document.querySelector("[data-discography]");
const discographyClose = document.querySelector("[data-discography-close]");
const discographyList = document.querySelector("[data-discography-list]");
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
let suppressDrawerTabClick = false;
let activeDrawerTab = "lyrics";
let contentSwipeStart = null;
let discographyNavigating = false;
let controlsRevealTimer = null;
let videoEdgeGesture = null;
let videoPointerGesture = null;
let videoSwipeGesture = null;
let videoPointerSwipeGesture = null;
let videoSyncTimer = null;
let audioWasPlayingBeforeVideo = false;
let suppressVideoClick = false;
let suppressVideoPeekClick = false;
let videoEnteredFullscreen = false;

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
      return { ...track, artist: track.artist || release.artist, video: track.video || (index === 0 ? release.video : "") };
    });
  }
  if (!release.audio) throw new Error("Release requires audio or a non-empty tracks array");
  return [{
    title: release.title,
    artist: release.artist,
    audio: release.audio,
    lyrics: release.lyrics || "",
    about: release.about || "",
    video: release.video || "",
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

function syncVideoToAudio() {
  if (!video || !Number.isFinite(audio.currentTime)) return;
  const duration = Number.isFinite(video.duration) ? video.duration : Infinity;
  try { video.currentTime = Math.min(Math.max(0, audio.currentTime), duration); } catch {}
}

function updateVideoFit() {
  if (!videoShell || !video.videoWidth || !video.videoHeight) return;
  videoShell.dataset.videoOrientation = video.videoWidth < video.videoHeight ? "portrait" : "landscape";
}

async function requestVideoFullscreenOnce() {
  if (!firstPlayAttempt) return;
  firstPlayAttempt = false;
  if (document.fullscreenElement || !videoDrawer?.requestFullscreen) return;
  try {
    await videoDrawer.requestFullscreen({ navigationUI: "hide" });
    videoEnteredFullscreen = true;
  } catch {}
}

async function setVideoOpen(open, { startIfIdle = false } = {}) {
  const videoPath = currentTrack()?.video;
  if (!videoPath || !videoDrawer || !video) return;
  if (open) {
    suppressVideoClick = false;
    audioWasPlayingBeforeVideo = !audio.paused && !audio.ended;
    setDrawerOpen(false);
    if (video.src !== resolveAsset(videoPath)) {
      video.src = resolveAsset(videoPath);
      video.load();
    }
    videoDrawer.setAttribute("aria-hidden", "false");
    // Paint the drawer off-screen first so opening has a visible slide-in frame.
    void videoDrawer.offsetWidth;
    player.dataset.videoOpen = "true";
    videoPeek?.setAttribute("aria-expanded", "true");
    video.muted = true;
    video.setAttribute("muted", "");
    video.addEventListener("loadedmetadata", syncVideoToAudio, { once: true });
    video.addEventListener("loadedmetadata", updateVideoFit, { once: true });
    updateVideoFit();
    syncVideoToAudio();
    const shouldStart = (!audio.paused && !audio.ended) || (startIfIdle && !hasStartedPlayback);
    const fullscreen = shouldStart ? requestVideoFullscreenOnce() : Promise.resolve();
    const playback = shouldStart ? video.play() : Promise.resolve();
    if (shouldStart && audio.paused && !hasStartedPlayback) resumeAudioForVideo();
    videoSyncTimer = window.setInterval(() => {
      if (player.dataset.videoOpen !== "true" || video.paused || audio.paused) return;
      if (Math.abs(video.currentTime - audio.currentTime) > 0.08) syncVideoToAudio();
    }, 250);
    try { await fullscreen; } catch {}
    try { await playback; } catch {}
  } else {
    if (videoSyncTimer) {
      clearInterval(videoSyncTimer);
      videoSyncTimer = null;
    }
    video.pause();
    player.dataset.videoOpen = "false";
    videoPeek?.setAttribute("aria-expanded", "false");
    await Promise.all(videoDrawer.getAnimations().map((animation) => animation.finished.catch(() => {})));
    videoDrawer.setAttribute("aria-hidden", "true");
    if (videoEnteredFullscreen && document.fullscreenElement === videoDrawer) {
      try { await document.exitFullscreen(); } catch {}
      videoEnteredFullscreen = false;
    }
    audioWasPlayingBeforeVideo = false;
  }
}

function toggleVideoPlayback() {
  video.muted = true;
  if (video.paused) {
    requestVideoFullscreenOnce();
    video.play().catch(() => {});
    if (audio.paused) resumeAudioForVideo();
  } else {
    video.pause();
    if (!audio.paused) audio.pause();
  }
}

async function resumeAudioForVideo() {
  endLanding = null;
  pendingMotorPause = false;
  motorTransition = null;
  motorRunning = true;
  visualSpeed = 1 / SECONDS_PER_TURN;
  audio.playbackRate = 1;
  audio.volume = 1;
  try {
    await audio.play();
    setState("playing");
  } catch {
    setState("paused", "Playback was blocked. Tap once more to retry.");
  }
}

function handleVideoClick(event) {
  if (suppressVideoClick) {
    suppressVideoClick = false;
    return;
  }
  event?.stopPropagation();
  toggleVideoPlayback();
}

function pauseVideoWithDisc() {
  if (player.dataset.videoOpen === "true" && video && !video.paused) video.pause();
}

function updateVideoSource() {
  const videoPath = currentTrack()?.video;
  player.dataset.hasVideo = String(Boolean(videoPath));
  if (!video) return;
  video.pause();
  video.muted = true;
  if (videoPath) {
    video.src = resolveAsset(videoPath);
    video.load();
  } else {
    video.removeAttribute("src");
    video.load();
  }
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
    const currentReleaseArtwork = discographyList.querySelector('.discography-release[aria-current="page"] img');
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
    discographyList.replaceChildren();
    for (const release of releases) {
      const link = document.createElement("a");
      link.className = "discography-release";
      const destination = new URL(release.url, location.origin);
      destination.searchParams.set("autoplay", "1");
      if (new URLSearchParams(location.search).has("test-muted")) destination.searchParams.set("test-muted", "1");
      link.href = destination.href;
      if (new URL(link.href).pathname === currentPath) link.setAttribute("aria-current", "page");

      const image = document.createElement("img");
      image.src = release.artwork;
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";

      const name = document.createElement("strong");
      name.textContent = release.title;
      link.append(image, name);
      discographyList.append(link);
    }
  } catch (error) {
    console.error(error);
    discographyList.replaceChildren();
    const message = document.createElement("p");
    message.textContent = "Discography could not be loaded.";
    discographyList.append(message);
  }
}

async function prepareDiscographyNavigation(event) {
  const link = event.target.closest(".discography-release");
  if (!link || discographyNavigating) return;
  const selectedArtwork = link.querySelector("img");
  if (!selectedArtwork) return;
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
    updateVideoSource();

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
  if (player.dataset.videoOpen === "true") await setVideoOpen(false);
  currentTrackIndex = index;
  updateTrackUi();
  updateVideoSource();

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
  if (state === "playing" && motorRunning) {
    pauseVideoWithDisc();
    beginMotorStop();
  }
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
drawerPeek.addEventListener("pointerdown", (event) => {
  if (!event.isPrimary || event.pointerType === "touch") return;
  if (player.dataset.discographyOpen === "true") return;
  const direction = player.dataset.drawerOpen === "true" ? "close" : "open";
  beginDrawerVerticalGesture(event.clientX, event.clientY, direction);
  drawerPeek.setPointerCapture?.(event.pointerId);
});
drawerPeek.addEventListener("pointermove", (event) => {
  if (updateDrawerVerticalDrag(event.clientX, event.clientY)) event.preventDefault();
}, { passive: false });
drawerPeek.addEventListener("pointerup", (event) => {
  if (!event.isPrimary || drawerVerticalGesture?.active) return;
  suppressDrawerToggleClick = true;
  setDrawerOpen(player.dataset.drawerOpen !== "true");
});
drawerPeek.addEventListener("click", () => {
  if (suppressDrawerToggleClick) {
    suppressDrawerToggleClick = false;
    return;
  }
  setDrawerOpen(player.dataset.drawerOpen !== "true");
});
discographyToggle.addEventListener("click", () => setDiscographyOpen(player.dataset.discographyOpen !== "true"));
discographyClose.addEventListener("click", () => setDiscographyOpen(false));
discographyList.addEventListener("click", prepareDiscographyNavigation);
videoPeek?.addEventListener("pointerdown", (event) => {
  if (event.pointerType === "touch") return;
  if (player.dataset.drawerOpen === "true" || player.dataset.discographyOpen === "true" || player.dataset.videoOpen === "true") return;
  videoPointerGesture = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
  videoPeek.setPointerCapture?.(event.pointerId);
});
videoPeek?.addEventListener("pointermove", (event) => {
  const gesture = videoPointerGesture;
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  const deltaX = event.clientX - gesture.x;
  const deltaY = event.clientY - gesture.y;
  if (deltaX > 8 && deltaX > Math.abs(deltaY)) {
    if (!videoEdgeGesture) beginVideoDrag(gesture.x, gesture.y);
    videoEdgeGesture.active = true;
    updateVideoDrag(deltaX);
    event.preventDefault();
  }
}, { passive: false });
videoPeek?.addEventListener("pointerup", (event) => {
  if (videoEdgeGesture?.active) {
    suppressVideoPeekClick = true;
    finishVideoDrag(event.clientX, event.clientY);
    videoPointerGesture = null;
    return;
  }
  suppressVideoPeekClick = true;
  setVideoOpen(player.dataset.videoOpen !== "true", { startIfIdle: true });
});
videoPeek?.addEventListener("click", () => {
  if (suppressVideoPeekClick) {
    suppressVideoPeekClick = false;
    return;
  }
  setVideoOpen(player.dataset.videoOpen !== "true", { startIfIdle: true });
});
videoDrawer?.addEventListener("click", handleVideoClick);
video?.addEventListener("loadedmetadata", updateVideoFit);
video?.addEventListener("play", () => {});
video?.addEventListener("pause", () => {});
player.addEventListener("click", (event) => {
  if (state !== "playing") return;
  if (event.target.closest("button, a, .lyrics-drawer, .video-drawer, .discography-overlay, .track-dock")) return;
  setControlsVisible(player.dataset.controlsVisible !== "true");
});
window.addEventListener("pageshow", () => {
  artwork.style.removeProperty("view-transition-name");
  for (const image of discographyList.querySelectorAll("img")) image.style.removeProperty("view-transition-name");
});
for (const tab of drawerTabs) {
  tab.addEventListener("pointerdown", (event) => {
    event.stopPropagation();
    if (event.pointerType !== "touch") setActiveDrawerTab(tab.dataset.drawerTab);
  });
  tab.addEventListener("pointerup", (event) => {
    if (event.pointerType === "touch") return;
    event.stopPropagation();
    suppressDrawerTabClick = true;
    setActiveDrawerTab(tab.dataset.drawerTab);
  });
  tab.addEventListener("click", () => {
    if (suppressDrawerTabClick) {
      suppressDrawerTabClick = false;
      return;
    }
    setActiveDrawerTab(tab.dataset.drawerTab);
  });
}

async function finishContentSwipe(endX, endY) {
  const swipe = contentSwipeStart;
  if (!swipe) return;
  contentSwipeStart = null;
  if (drawerContent.hasPointerCapture?.(swipe.pointerId)) {
    try { drawerContent.releasePointerCapture(swipe.pointerId); } catch {}
  }
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
  const wasOpen = player.dataset.drawerOpen === "true";
  const currentTransform = drawerPeek.style.transform;
  const currentTransition = drawerPeek.style.transition;
  player.dataset.drawerOpen = "false";
  drawerPeek.style.removeProperty("transform");
  const matrixValues = getComputedStyle(drawerPeek).transform.match(/^matrix\(([^)]+)\)$/)?.[1]
    .split(",")
    .map(Number);
  const closedPeekOffset = Number.isFinite(matrixValues?.[5]) ? matrixValues[5] : 0;
  const closedDrawerY = lyricsDrawer.getBoundingClientRect().top;
  const closedPeekY = drawerPeek.getBoundingClientRect().top;
  player.dataset.drawerOpen = "true";
  const openDrawerY = lyricsDrawer.getBoundingClientRect().top;
  const openPeekY = drawerPeek.getBoundingClientRect().top;
  if (!wasOpen) player.dataset.drawerOpen = "false";
  if (currentTransform) drawerPeek.style.transform = currentTransform;
  if (currentTransition) drawerPeek.style.transition = currentTransition;
  drawerPeek.style.removeProperty("top");
  drawerPeek.style.removeProperty("bottom");
  drawerPeek.style.removeProperty("transform");
  const drawerBaseY = wasOpen ? openDrawerY : closedDrawerY;
  const peekBaseY = wasOpen ? openPeekY : closedPeekY;
  drawerVerticalGesture = {
    x,
    y,
    direction,
    closedPeekOffset,
    peekBaseY,
    closedDrawerY,
    openDrawerY,
    closedPeekGap: closedPeekY - closedDrawerY,
    openPeekGap: openPeekY - openDrawerY,
    closedPeekY,
    peekHeight: drawerPeek.offsetHeight,
    dragPeekGap: -(drawerPeek.offsetHeight / 2),
  };
}

function finishDrawerVerticalGesture(x, y) {
  const gesture = drawerVerticalGesture;
  drawerVerticalGesture = null;
  if (!gesture) return;
  const deltaX = x - gesture.x;
  const deltaY = y - gesture.y;
  if (gesture.active) {
    const vertical = Math.abs(deltaY) > Math.abs(deltaX) * 1.15;
    const shouldOpen = gesture.direction === "open"
      ? deltaY < -60 && vertical
      : !(deltaY > 60 && vertical);
    const peekRect = drawerPeek.getBoundingClientRect();
    const peekCenterY = peekRect.top + peekRect.height / 2;
    drawerPeek.style.transition = "none";
    lyricsDrawer.style.removeProperty("transition");
    lyricsDrawer.style.removeProperty("transform");
    setDrawerOpen(shouldOpen);
    drawerPeek.style.removeProperty("top");
    drawerPeek.style.removeProperty("bottom");
    drawerPeek.style.removeProperty("transform");
    const finalPeekRect = drawerPeek.getBoundingClientRect();
    drawerPeek.style.transform = `translateY(${peekCenterY - (finalPeekRect.top + finalPeekRect.height / 2)}px)`;
    void drawerPeek.offsetWidth;
    drawerPeek.style.removeProperty("transition");
    drawerPeek.style.removeProperty("transform");
    if (shouldOpen !== (gesture.direction === "close")) suppressDrawerToggleClick = true;
    return;
  }
  if (Math.abs(deltaY) <= 42 || Math.abs(deltaY) <= Math.abs(deltaX) * 1.15) return;
  if (gesture.direction === "open" && deltaY < 0) setDrawerOpen(true);
  else if (gesture.direction === "close" && deltaY > 0) setDrawerOpen(false);
}

function updateDrawerVerticalDrag(x, y) {
  const gesture = drawerVerticalGesture;
  if (!gesture) return false;
  const deltaX = x - gesture.x;
  const deltaY = y - gesture.y;
  if (Math.abs(deltaY) <= 8 || Math.abs(deltaY) <= Math.abs(deltaX) * 1.15) return false;
  const height = lyricsDrawer.clientHeight || innerHeight;
  const closedY = height * 1.02;
  const offset = gesture.direction === "open"
    ? Math.max(0, Math.min(closedY, closedY + deltaY))
    : Math.max(0, Math.min(closedY, deltaY));
  gesture.active = true;
  lyricsDrawer.style.transition = "none";
  lyricsDrawer.style.transform = `translateY(${offset}px)`;
  drawerPeek.style.transition = "none";
  const drawerY = lyricsDrawer.getBoundingClientRect().top;
  if (gesture.direction === "open" && drawerY > gesture.closedPeekY + gesture.peekHeight) {
    drawerPeek.style.removeProperty("top");
    drawerPeek.style.removeProperty("bottom");
    drawerPeek.style.removeProperty("transform");
    return true;
  }
  drawerPeek.style.top = `${drawerY + gesture.dragPeekGap}px`;
  drawerPeek.style.bottom = "auto";
  drawerPeek.style.transform = "translateY(-50%)";
  lyricsDrawer.setAttribute("aria-hidden", "false");
  return true;
}

function updateVideoDrag(deltaX) {
  if (!videoDrawer) return;
  const width = videoDrawer.clientWidth || innerWidth;
  const closedX = -width * 1.04;
  const x = Math.max(closedX, Math.min(0, closedX + deltaX));
  videoDrawer.style.transition = "none";
  videoDrawer.style.transform = `translateX(${x}px) scale(${0.94 + 0.06 * (1 - Math.abs(x / closedX))})`;
}

function beginVideoDrag(x, y) {
  videoDrawer?.setAttribute("aria-hidden", "false");
  videoEdgeGesture = { x, y, active: false };
}

function finishVideoDrag(x, y) {
  const gesture = videoEdgeGesture;
  videoEdgeGesture = null;
  if (!gesture || !gesture.active) return false;
  suppressVideoClick = true;
  const deltaX = x - gesture.x;
  const deltaY = y - gesture.y;
  const shouldOpen = deltaX > 60
    && Math.abs(deltaX) > Math.abs(deltaY) * 1.15;
  videoDrawer.style.removeProperty("transition");
  videoDrawer.style.removeProperty("transform");
  setVideoOpen(shouldOpen, { startIfIdle: shouldOpen });
  return true;
}

function updateVideoCloseDrag(deltaX) {
  if (!videoDrawer) return;
  const x = Math.min(0, Math.max(-videoDrawer.clientWidth, deltaX));
  videoDrawer.style.transition = "none";
  videoDrawer.style.transform = `translateX(${x}px) scale(${1 - Math.abs(x) / Math.max(1, videoDrawer.clientWidth) * 0.06})`;
}

function finishVideoCloseDrag(x, y) {
  const gesture = videoSwipeGesture;
  videoSwipeGesture = null;
  if (!gesture || !gesture.active) return false;
  const deltaX = x - gesture.x;
  const deltaY = y - gesture.y;
  const shouldClose = deltaX < -60
    && Math.abs(deltaX) > Math.abs(deltaY) * 1.15;
  videoDrawer.style.removeProperty("transition");
  videoDrawer.style.removeProperty("transform");
  setVideoOpen(!shouldClose);
  return true;
}

player.addEventListener("pointerdown", (event) => {
  if (!event.isPrimary || event.pointerType === "touch" || player.dataset.drawerOpen === "true" || player.dataset.videoOpen === "true") return;
  if (player.dataset.discographyOpen === "true" || event.target.closest(".track-controls, .discography-toggle")) return;
  if (event.clientY >= innerHeight * 0.55 && !event.target.closest(".drawer-peek")) {
    beginDrawerVerticalGesture(event.clientX, event.clientY, "open");
    player.setPointerCapture?.(event.pointerId);
  }
});
player.addEventListener("pointerup", (event) => {
  if (event.pointerType !== "touch") finishDrawerVerticalGesture(event.clientX, event.clientY);
});

player.addEventListener("touchstart", (event) => {
  if (player.dataset.drawerOpen === "true" || player.dataset.discographyOpen === "true" || player.dataset.videoOpen === "true") return;
  if (event.target.closest(".track-controls, .discography-toggle")) return;
  const touch = event.touches[0];
  if (touch && player.dataset.hasVideo === "true" && touch.clientX <= 32) {
    beginVideoDrag(touch.clientX, touch.clientY);
    return;
  }
  if (touch && touch.clientY >= innerHeight * 0.55) beginDrawerVerticalGesture(touch.clientX, touch.clientY, "open");
}, { passive: true });
player.addEventListener("pointerdown", (event) => {
  if (!event.isPrimary || event.pointerType === "touch") return;
  if (player.dataset.drawerOpen === "true" || player.dataset.discographyOpen === "true" || player.dataset.videoOpen === "true") return;
  if (event.target.closest(".track-controls, .discography-toggle, .video-peek") || player.dataset.hasVideo !== "true" || event.clientX > 40) return;
  videoPointerGesture = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
  player.setPointerCapture?.(event.pointerId);
});
player.addEventListener("pointerup", (event) => {
  if (videoEdgeGesture?.active) {
    finishVideoDrag(event.clientX, event.clientY);
    videoPointerGesture = null;
    return;
  }
  const gesture = videoPointerGesture;
  videoPointerGesture = null;
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  const deltaX = event.clientX - gesture.x;
  const deltaY = event.clientY - gesture.y;
  if (deltaX > 60 && Math.abs(deltaX) > Math.abs(deltaY) * 1.15) {
    videoDrawer.style.removeProperty("transition");
    videoDrawer.style.removeProperty("transform");
    setVideoOpen(true, { startIfIdle: true });
  }
});
player.addEventListener("pointercancel", (event) => {
  if (videoPointerGesture?.pointerId === event.pointerId) videoPointerGesture = null;
});
player.addEventListener("touchmove", (event) => {
  if (drawerVerticalGesture && updateDrawerVerticalDrag(event.touches[0]?.clientX, event.touches[0]?.clientY)) {
    event.preventDefault();
    return;
  }
  if (!videoEdgeGesture) return;
  const touch = event.touches[0];
  if (!touch) return;
  const deltaX = touch.clientX - videoEdgeGesture.x;
  const deltaY = touch.clientY - videoEdgeGesture.y;
  if (deltaX > 8 && deltaX > Math.abs(deltaY)) {
    videoEdgeGesture.active = true;
    updateVideoDrag(deltaX);
    event.preventDefault();
  }
}, { passive: false });
player.addEventListener("touchend", (event) => {
  const touch = event.changedTouches[0];
  if (videoEdgeGesture) {
    if (touch && finishVideoDrag(touch.clientX, touch.clientY)) return;
    videoDrawer?.setAttribute("aria-hidden", "true");
    return;
  }
  if (player.dataset.drawerOpen === "true" || drawerVerticalGesture?.direction !== "open") return;
  if (touch) finishDrawerVerticalGesture(touch.clientX, touch.clientY);
}, { passive: true });
window.addEventListener("pointermove", (event) => {
  if (drawerVerticalGesture && updateDrawerVerticalDrag(event.clientX, event.clientY)) {
    event.preventDefault();
    return;
  }
  const gesture = videoPointerGesture;
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  const deltaX = event.clientX - gesture.x;
  const deltaY = event.clientY - gesture.y;
  if (deltaX > 8 && deltaX > Math.abs(deltaY)) {
    if (!videoEdgeGesture) beginVideoDrag(gesture.x, gesture.y);
    videoEdgeGesture.active = true;
    updateVideoDrag(deltaX);
    event.preventDefault();
  }
}, { passive: false });
window.addEventListener("pointermove", (event) => {
  if (drawerVerticalGesture && updateDrawerVerticalDrag(event.clientX, event.clientY)) {
    event.preventDefault();
  }
  const gesture = videoPointerGesture;
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  const deltaX = event.clientX - gesture.x;
  const deltaY = event.clientY - gesture.y;
  if (deltaX > 8 && deltaX > Math.abs(deltaY)) {
    if (!videoEdgeGesture) beginVideoDrag(gesture.x, gesture.y);
    videoEdgeGesture.active = true;
    updateVideoDrag(deltaX);
    event.preventDefault();
  }
}, { capture: true, passive: false });

lyricsDrawer.addEventListener("pointerdown", (event) => {
  if (!event.isPrimary || event.pointerType === "touch" || player.dataset.drawerOpen !== "true") return;
  const startsInScrollableContent = Boolean(event.target.closest("[data-drawer-content]"));
  const startsInDrawerTab = Boolean(event.target.closest("[data-drawer-tab]"));
  if (startsInScrollableContent || startsInDrawerTab) return;
  beginDrawerVerticalGesture(event.clientX, event.clientY, "close");
  lyricsDrawer.setPointerCapture?.(event.pointerId);
});
lyricsDrawer.addEventListener("pointermove", (event) => {
  if (updateDrawerVerticalDrag(event.clientX, event.clientY)) event.preventDefault();
}, { passive: false });
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
videoDrawer?.addEventListener("touchstart", (event) => {
  const touch = event.touches[0];
  if (touch) videoSwipeGesture = { x: touch.clientX, y: touch.clientY, active: false };
}, { passive: true });
videoDrawer?.addEventListener("touchmove", (event) => {
  const gesture = videoSwipeGesture;
  const touch = event.touches[0];
  if (!gesture || !touch) return;
  const deltaX = touch.clientX - gesture.x;
  const deltaY = touch.clientY - gesture.y;
  if (deltaX < -8 && Math.abs(deltaX) > Math.abs(deltaY)) {
    gesture.active = true;
    updateVideoCloseDrag(deltaX);
    event.preventDefault();
  }
}, { passive: false });
videoDrawer?.addEventListener("touchend", (event) => {
  const touch = event.changedTouches[0];
  if (touch && finishVideoCloseDrag(touch.clientX, touch.clientY)) event.preventDefault();
}, { passive: false });
videoDrawer?.addEventListener("touchcancel", () => { videoSwipeGesture = null; }, { passive: true });
videoDrawer?.addEventListener("pointerdown", (event) => {
  if (!event.isPrimary || event.pointerType === "touch") return;
  videoPointerSwipeGesture = { x: event.clientX, y: event.clientY, pointerId: event.pointerId, active: false };
  videoDrawer.setPointerCapture?.(event.pointerId);
});
videoDrawer?.addEventListener("pointermove", (event) => {
  const gesture = videoPointerSwipeGesture;
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  const deltaX = event.clientX - gesture.x;
  const deltaY = event.clientY - gesture.y;
  if (deltaX < -8 && Math.abs(deltaX) > Math.abs(deltaY)) {
    gesture.active = true;
    updateVideoCloseDrag(deltaX);
    event.preventDefault();
  }
});
videoDrawer?.addEventListener("pointerup", (event) => {
  const gesture = videoPointerSwipeGesture;
  videoPointerSwipeGesture = null;
  if (!gesture || event.pointerId !== gesture.pointerId) return;
  if (gesture.active) {
    suppressVideoClick = true;
    videoSwipeGesture = gesture;
    finishVideoCloseDrag(event.clientX, event.clientY);
    return;
  }
  const deltaX = event.clientX - gesture.x;
  const deltaY = event.clientY - gesture.y;
  if (deltaX < -60 && Math.abs(deltaX) > Math.abs(deltaY) * 1.15) setVideoOpen(false);
});
videoDrawer?.addEventListener("pointercancel", (event) => {
  if (videoPointerSwipeGesture?.pointerId === event.pointerId) videoPointerSwipeGesture = null;
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && player.dataset.videoOpen === "true") {
    setVideoOpen(false);
    return;
  }
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
  if (player.dataset.videoOpen === "true" && video?.paused) {
    syncVideoToAudio();
    video.play().catch(() => {});
  }
});
audio.addEventListener("pause", () => {
  if (switchingTrack) return;
  motorRunning = false;
  motorTransition = null;
  visualSpeed = 0;
  pendingMotorPause = false;
  delete player.dataset.firstPlayback;
  if (!audio.ended) setState("paused");
  if (player.dataset.videoOpen === "true" && video) {
    syncVideoToAudio();
    if (!video.paused) video.pause();
  }
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
