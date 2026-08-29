import { selectVideoSource } from "./video-source.js";

function createArtwork(release) {
  const image = document.createElement("img");
  image.src = release.artwork;
  image.alt = "";
  image.loading = "lazy";
  image.decoding = "async";
  return image;
}

function createVideoThumbnail(source) {
  const video = document.createElement("video");
  video.className = "discography-video-thumbnail";
  video.src = new URL(selectVideoSource(source), document.baseURI).href;
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.addEventListener("loadedmetadata", () => { video.currentTime = 0; }, { once: true });
  video.addEventListener("loadeddata", () => video.pause(), { once: true });
  return video;
}

export function renderDiscographyLists({ catalog, audioList, videoList, currentPath = "", testMuted = false }) {
  audioList.replaceChildren();
  videoList.replaceChildren();

  for (const release of catalog) {
    const link = document.createElement("a");
    link.className = "discography-release";
    const destination = new URL(release.url, location.origin);
    destination.searchParams.set("autoplay", "1");
    if (testMuted) destination.searchParams.set("test-muted", "1");
    link.href = destination.href;
    if (destination.pathname === currentPath) link.setAttribute("aria-current", "page");

    const name = document.createElement("strong");
    name.textContent = release.title;
    link.append(createArtwork(release), name);
    audioList.append(link);

    for (const video of release.videos || []) {
      const videoLink = document.createElement("a");
      videoLink.className = "discography-release discography-video";
      videoLink.href = video.url || release.videoUrl || `${release.url}?video=1`;
      videoLink.dataset.videoSrc = selectVideoSource(video.video);
      videoLink.dataset.videoTitle = video.title;
      const videoName = document.createElement("strong");
      videoName.textContent = video.title;
      videoLink.append(createVideoThumbnail(video.video), videoName);
      videoList.append(videoLink);
    }
  }

  const videoHeading = videoList.parentElement.querySelector("[data-discography-video-heading]");
  videoList.hidden = !videoList.children.length;
  if (videoHeading) videoHeading.hidden = !videoList.children.length;
}
