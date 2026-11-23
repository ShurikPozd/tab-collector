// Тема и масштаб до загрузки настроек — без вспышки (chrome.storage отвечает асинхронно).
// В боковой панели масштаб свой (там обычно нужно мельче, чем во вкладке).
try {
  const root = document.documentElement;
  const panel = new URLSearchParams(location.search).has("panel");
  if (panel) root.classList.add("in-panel");
  const t = localStorage.getItem("tc:theme");
  if (t === "dark" || t === "light") root.dataset.theme = t;
  const z = Number(localStorage.getItem(panel ? "tc:scale:panel" : "tc:scale:tab"));
  if (z >= 0.7 && z <= 1.6) root.style.setProperty("--ui-scale", String(z));
} catch (e) {
  /* не критично */
}
