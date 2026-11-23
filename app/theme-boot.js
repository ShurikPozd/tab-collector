// Тема до загрузки настроек — без вспышки (chrome.storage отвечает асинхронно).
try {
  const t = localStorage.getItem("tc:theme");
  if (t === "dark" || t === "light") document.documentElement.dataset.theme = t;
} catch (e) {
  /* не критично */
}
