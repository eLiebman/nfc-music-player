import { renderDiscographyLists } from "./discography-list.js";

const audioList = document.querySelector("[data-discography-audio-list]");
const videoList = document.querySelector("[data-discography-video-list]");

try {
  const response = await fetch(new URL(document.body.dataset.discography, document.baseURI));
  if (!response.ok) throw new Error(`Discography returned ${response.status}`);
  const releases = await response.json();
  renderDiscographyLists({ catalog: releases, audioList, videoList });
} catch (error) {
  console.error(error);
  const message = document.createElement("p");
  message.textContent = "Discography could not be loaded.";
  audioList.replaceChildren(message);
}
