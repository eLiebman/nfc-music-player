const list = document.querySelector("[data-discography-list]");

try {
  const response = await fetch(new URL(document.body.dataset.discography, document.baseURI));
  if (!response.ok) throw new Error(`Discography returned ${response.status}`);
  const releases = await response.json();
  list.replaceChildren();
  for (const release of releases) {
    const link = document.createElement("a");
    link.className = "discography-release";
    const destination = new URL(release.url, location.origin);
    destination.searchParams.set("autoplay", "1");
    link.href = destination.href;

    const image = document.createElement("img");
    image.src = release.artwork;
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";

    const name = document.createElement("strong");
    name.textContent = release.title;
    link.append(image, name);
    list.append(link);
  }
} catch (error) {
  console.error(error);
  const message = document.createElement("p");
  message.textContent = "Discography could not be loaded.";
  list.replaceChildren(message);
}
