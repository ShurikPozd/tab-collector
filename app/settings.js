// Окно «Настройки»: тема, адрес и секрет бота, проверка связи, резервная копия списка.

import { load, loadSettings, saveSettings, exportData, importData } from "../core/store.js";
import { botSettings, ping } from "../core/bot.js";
import { linksWord } from "../core/format.js";
import { DEFAULTS } from "../config.js";
import { clearShots, countShots } from "../core/shots.js";
import { forgetShots } from "./peek.js";
import { confirmDlg } from "./ui.js";

const $ = (id) => document.getElementById(id);
let bound = false;
let onChange = () => {};

const PANEL = new URLSearchParams(location.search).has("panel");
const SCALE_KEY = PANEL ? "scalePanel" : "scaleTab";

/** Масштаб интерфейса: свой для панели и для вкладки. */
export function applyScale(z) {
  z = Number(z) || 1;
  document.documentElement.style.setProperty("--ui-scale", String(z));
  try {
    localStorage.setItem(PANEL ? "tc:scale:panel" : "tc:scale:tab", String(z));
  } catch (e) {
    /* не критично */
  }
  document.querySelectorAll("[data-scale]").forEach((b) => b.setAttribute("aria-checked", String(Number(b.dataset.scale) === z)));
  window.dispatchEvent(new Event("resize")); // подсказка в поиске и раскладка — под новый размер
}

export function scaleOf(settings) {
  return Number(settings[SCALE_KEY]) || 1;
}

function applyAutoSleep(h) {
  document.querySelectorAll("[data-autosleep]").forEach((b) => b.setAttribute("aria-checked", String(Number(b.dataset.autosleep) === h)));
}

async function backupStatus(text, ok) {
  const s = await loadSettings();
  $("set-autobackup").checked = s.autoBackup !== false;
  const b = s.backup || {};
  const el = $("backup-status");
  el.className = `field-hint${ok === false ? " err" : ok ? " ok" : ""}`;
  if (text) return (el.textContent = text);
  if (b.lastAt) {
    const d = new Date(b.lastAt);
    el.textContent = `Последняя копия в Telegram: ${d.toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}${b.lastLinks != null ? ` · ${linksWord(b.lastLinks)}` : ""}.${b.lastError ? ` Последняя попытка не удалась: ${b.lastError}.` : ""}`;
  } else el.textContent = b.lastError ? `Копия ещё не отправлялась: ${b.lastError}.` : "Копия в Telegram ещё не отправлялась.";
}

function applyOpens(v) {
  document.querySelectorAll("[data-opens]").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.opens === v)));
}

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
  dlg.querySelectorAll("[data-scale]").forEach((b) =>
    b.addEventListener("click", async () => {
      applyScale(b.dataset.scale);
      await saveSettings({ [SCALE_KEY]: Number(b.dataset.scale) });
    })
  );
  dlg.querySelectorAll("[data-opens]").forEach((b) =>
    b.addEventListener("click", async () => {
      applyOpens(b.dataset.opens);
      await saveSettings({ iconOpens: b.dataset.opens });
      chrome.runtime.sendMessage({ type: "icon-behavior" }).catch(() => {}); // фон переключит поведение значка
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
    await saveSettings({ baseUrl: url === DEFAULTS.baseUrl ? "" : url, token: $("set-token").value.trim() });
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
  dlg.querySelectorAll("[data-autosleep]").forEach((b) =>
    b.addEventListener("click", async () => {
      applyAutoSleep(Number(b.dataset.autosleep));
      await saveSettings({ autoSleepHours: Number(b.dataset.autosleep) });
      chrome.runtime.sendMessage({ type: "schedule" }).catch(() => {});
    })
  );
  $("set-autobackup").addEventListener("change", async (e) => {
    await saveSettings({ autoBackup: e.target.checked });
    chrome.runtime.sendMessage({ type: "schedule" }).catch(() => {});
    await backupStatus();
  });
  $("backup-send").addEventListener("click", async () => {
    const b = $("backup-send");
    b.disabled = true;
    b.classList.add("spin");
    $("backup-status").textContent = "Отправляю копию…";
    const r = await chrome.runtime.sendMessage({ type: "backup-now" }).catch(() => null);
    b.disabled = false;
    b.classList.remove("spin");
    await backupStatus(r && r.text, r && r.ok);
  });
  $("backup-load").addEventListener("click", () => $("backup-file").click());
  $("backup-file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try {
      // копия из Telegram — сжатая (.json.gz): распаковываем
      const head = new Uint8Array(await f.slice(0, 2).arrayBuffer());
      const text = head[0] === 0x1f && head[1] === 0x8b ? await new Response(f.stream().pipeThrough(new DecompressionStream("gzip"))).text() : await f.text();
      const n = await importData(JSON.parse(text));
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
  applyScale(scaleOf(settings));
  applyOpens(settings.iconOpens || "panel");
  $("scale-hint").textContent = PANEL
    ? "Для боковой панели. Во вкладке масштаб настраивается отдельно."
    : "Для страницы во вкладке. В боковой панели масштаб настраивается отдельно.";
  $("set-shots").checked = settings.shots !== false;
  applyAutoSleep(Number(settings.autoSleepHours) || 0);
  await backupStatus();
  await shotsCount();
  hint("");
  $("settings-dlg").showModal();
  // без рамки фокуса на «×» при открытии: фокус — на само окно
  $("settings-dlg").querySelector(".dlg-body").focus({ focusVisible: false });
}
