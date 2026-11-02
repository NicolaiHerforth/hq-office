// MENU › THEME before the first paint: the shell loads this classic script in its head, so a page set to DARK (or
// LIGHT) never flashes the other one before menu/index.js runs. The key is menu/index.js's THEME_KEY.
try {
  const t = localStorage.getItem("hq-theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch {}
