export const MOBILE_VIDEO_QUERY = "(max-width: 767px)";

export function selectVideoSource(video, isMobile = matchMedia(MOBILE_VIDEO_QUERY).matches) {
  if (typeof video === "string") return video;
  if (!video || typeof video !== "object") return "";
  return isMobile
    ? video.mobile || video.desktop || ""
    : video.desktop || video.mobile || "";
}
