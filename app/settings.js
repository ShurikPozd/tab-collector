// Окно «Настройки»: тема, адрес и секрет бота, проверка связи, резервная копия списка.

import { load, saveSettings, exportData, importData } from "../core/store.js";
import { botSettings, ping } from "../core/bot.js";
import { DEFAULTS } from "../config.js";
import { clearShots, countShots } from "../core/shots.js";
import { forgetShots } from "./peek.js";
import { confirmDlg } from "./ui.js";

const $ = (id) => document.getElementById(id);
let bound = false;
let onChange = () => {};

export function applyTheme(t) {
  const root = document.documentElement;
  if (t === "light" || t === "dark") root.dataset.theme = t;
  else delete root.dataset.theme;
  try {
    localStorage.setItem("tc:theme", t);
  } catch (e) {
    /* не критично */
  }
  document.querySelectorAll("[data-theme-set]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.themeSet === (t || "auto"))));
}

// секрет уходит в заголовке — только по https (http допустим для бота на своём компьютере)
function okUrl(url) {
  return /^https:\/\/[^\s/]+/.test(url) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(url);
}

function hint(text, kind = "") {
  const el = $("set-status");
  el.textContent = text;
  el.className = `field-hint${kind ? " " + kind : ""}`;
}

function bind() {
  bound = true;
  const dlg = $("settings-dlg");
  dlg.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => dlg.close()));
  dlg.querySelectorAll("[data-theme-set]").forEach((b) =>
    b.addEventListener("click", async () => {
      applyTheme(b.dataset.themeSet);
      await saveSettings({ theme: b.dataset.themeSet });
    })
  );
  $("set-token-eye").addEventListener("click", () => {
    const i = $("set-token");
    i.type = i.type === "password" ? "text" : "password";
  });
  $("set-save").addEventListener("click", async () => {
    const url = $("set-url").value.trim().replace(/\/+$/, "");
    if (url && !okUrl(url)) return hint("Адрес бота должен начинаться с https:// (http — только для localhost)", "err");
    await saveSettings({ baseUrl: url === DEFAULTS.baseUrl ? "" : url, token: $("set-token").value.trim() });
    hint("Сохранено.", "ok");
    onChange();
  });
  $("set-ping").addEventListener("click", async () => {
    const b = $("set-ping");
    b.disabled = true;
    b.classList.add("spin");
    const url = $("set-url").value.trim().replace(/\/+$/, "");
    if (url && !okUrl(url)) {
      b.disabled = false;
      b.classList.remove("spin");
      return hint("Адрес бота должен начинаться с https:// (http — только для localhost)", "err");
    }
    hint("Проверяю… если бот спал, он просыпается до минуты.");
    await saveSettings({ baseUrl: $("set-url").value.trim().replace(/\/+$/, "") === DEFAULTS.baseUrl ? "" : $("set-url").value.trim(), token: $("set-token").value.trim() });
    const r = await ping();
    b.disabled = false;
    b.classList.remove("spin");
    hint(r.text, r.ok ? "ok" : "err");
  });
  $("backup-save").addEventListener("click", async () => {
    const data = await exportData();
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `вкладки-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });
  $("set-shots").addEventListener("change", (e) => saveSettings({ shots: e.target.checked }));
  $("shots-clear").addEventListener("click", async () => {
    if (!(await confirmDlg("Удалить все снимки?", "Снимки страниц исчезнут из предпросмотра. Сами ссылки останутся в списке.", "Удалить снимки"))) return;
    await clearShots();
    forgetShots();
    await shotsCount();
    onChange();
  });
  $("backup-load").addEventListener("click", () => $("backup-file").click());
  $("backup-file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try {
      const n = await importData(JSON.parse(await f.text()));
      hint(n ? `Добавлено из копии: ${n}.` : "Всё из копии уже есть в списке.", "ok");
      onChange();
    } catch (err) {
      hint(err.message && /копия/.test(err.message) ? err.message : "Не получилось прочитать файл копии.", "err");
    }
  });
}

async function shotsCount() {
  const n = await countShots().catch(() => 0);
  $("shots-count").textContent = n ? `Сейчас снимков: ${n}` : "Снимков пока нет";
  $("shots-clear").disabled = !n;
}

export async function openSettings(changed) {
  if (!bound) bind();
  onChange = changed || (() => {});
  const { settings } = await load();
  const s = await botSettings();
  $("set-url").value = s.baseUrl;
  $("set-token").value = settings.token || "";
  $("set-token").type = "password";
  $("set-token-hint").textContent = s.tokenFromFile
    ? "Сейчас используется секрет из файла local-config.js. Впишите сюда, чтобы заменить."
    : "Тот же секрет, что у «Сводки комментариев YouTube». Хранится только в этом браузере.";
  applyTheme(settings.theme || "auto");
  $("set-shots").checked = settings.shots !== false;
  await shotsCount();
  hint("");
  $("settings-dlg").showModal();
  // без рамки фокуса на «×» при открытии: фокус — на само окно
  $("settings-dlg").querySelector(".dlg-body").focus({ focusVisible: false });
}
