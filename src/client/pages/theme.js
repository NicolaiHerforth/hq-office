// A page's frame in the HUD's theme. The theme is the root's data-theme (light or dark, set by the HUD's THEME in
// MENU), or the screen's setting when it is unset. Every page frame asks for it as ?theme=light|dark, and the server
// puts data-theme and a matching color-scheme on the page's <html>: the signal an artifact gets on claude.ai, so
// pages written for artifacts follow it. When the theme changes, the frames on show load in the new one.
const root = document.documentElement;
const darkScreen = matchMedia("(prefers-color-scheme: dark)");
export const theme = () => (root.dataset.theme === "light" || root.dataset.theme === "dark" ? root.dataset.theme : darkScreen.matches ? "dark" : "light");

// A frame's address with the theme it is to show in.
export const themedSrc = (src) => `${src}${src.includes("?") ? "&" : "?"}theme=${theme()}`;

function follow() {
  for (const f of document.querySelectorAll("iframe.pageframe[data-src]")) {
    const src = themedSrc(f.dataset.src);
    if (f.getAttribute("src") !== src) f.setAttribute("src", src);
  }
}
new MutationObserver(follow).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
darkScreen.addEventListener("change", follow);
