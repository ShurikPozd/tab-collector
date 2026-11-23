// Сбор вкладок: прочитать со страниц название/описание/прокрутку, сохранить в список,
// закрыть. «Усыпить» — выгрузить из памяти (chrome.tabs.discard), вкладка остаётся.
// Используется и страницей расширения, и фоном (пункт меню значка).

import { makeItem, addItems } from "./store.js";
import { collectable } from "./url.js";

// выполняется ВНУТРИ вкладки — только то, что есть на самой странице
function readPage() {
  const pick = (...sels) => {
    for (const s of sels) {
      const el = document.querySelector(s);
      const v = el && (el.getAttribute("content") || "").trim();
      if (v) return v;
    }
    return "";
  };
  return {
    title: pick('meta[property="og:title"]') || document.title,
    description: pick('meta[property="og:description"]', 'meta[name="description"]'),
    image: pick('meta[property="og:image"]'),
    siteName: pick('meta[property="og:site_name"]'),
    ogType: pick('meta[property="og:type"]'),
    url: location.href,
    scrollY: window.scrollY,
  };
}

async function grab(tab, timeout = 1500) {
  // выгруженная или ещё не загруженная вкладка скрипт не выполнит — хватит адреса и заголовка
  if (tab.discarded || tab.status === "unloaded" || !/^https?:/.test(tab.url)) return {};
  try {
    const run = chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPage });
    const res = await Promise.race([run, new Promise((r) => setTimeout(() => r(null), timeout))]);
    return (res && res[0] && res[0].result) || {};
  } catch (e) {
    return {};
  }
}

/** Вкладки, которые нельзя трогать: закреплённые, сама страница расширения, служебные. */
export function untouchable(tab, extOrigin) {
  if (tab.pinned) return "pinned";
  if (tab.incognito) return "system";
  if (!tab.url || tab.url.startsWith(extOrigin)) return "self";
  if (!collectable(tab.url)) return "system";
  return "";
}

/** Собрать вкладки в список и закрыть их. onProgress(done, total). */
export async function collectTabs(tabs, { close = true, onProgress } = {}) {
  const items = [];
  let done = 0;
  const queue = tabs.slice();
  const worker = async () => {
    while (queue.length) {
      const tab = queue.shift();
      const g = await grab(tab);
      // вкладка могла перейти на другую страницу, пока шёл сбор: адрес и название — с одной страницы
      const t = g.url && /^https?:/.test(g.url) ? { ...tab, url: g.url } : tab;
      items.push({ order: tabs.indexOf(tab), item: makeItem(t, g) });
      done++;
      onProgress && onProgress(done, tabs.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, tabs.length) }, worker));
  items.sort((a, b) => a.order - b.order);
  const res = await addItems(items.map((x) => x.item));
  // закрываем только после того, как список записан: ничего не теряется
  if (close) {
    const ids = tabs.map((t) => t.id);
    for (let i = 0; i < ids.length; i += 50) {
      try {
        await chrome.tabs.remove(ids.slice(i, i + 50));
      } catch (e) {
        /* часть вкладок уже закрыли руками */
      }
    }
  }
  return res;
}

// выполняется ВНУТРИ вкладки: есть ли недописанный текст (поле изменено, но не отправлено)
function hasDraft() {
  const fields = document.querySelectorAll("textarea, input:not([type]), input[type=text], input[type=search], input[type=email], input[type=url], input[type=number], input[type=tel]");
  for (const f of fields) if (f.value && f.value !== f.defaultValue && f.offsetParent !== null) return true;
  const ed = document.activeElement;
  return !!(ed && ed.isContentEditable && ed.textContent.trim());
}

async function draftIn(tab) {
  if (tab.status === "unloaded" || !/^https?:/.test(tab.url)) return false;
  try {
    const run = chrome.scripting.executeScript({ target: { tabId: tab.id }, func: hasDraft });
    const res = await Promise.race([run, new Promise((r) => setTimeout(() => r(null), 1000))]);
    return !!(res && res[0] && res[0].result);
  } catch (e) {
    return false;
  }
}

/**
 * Выгрузить из памяти. Пропускаем активные (Chrome не даст), со звуком (музыка, звонок)
 * и с недописанным текстом — Chrome при выгрузке его не сохранит.
 * Возвращает { n, audible, drafts }.
 */
export async function sleepTabs(tabs) {
  const out = { n: 0, audible: 0, drafts: 0 };
  for (const t of tabs) {
    if (t.active || t.discarded) continue;
    if (t.audible) {
      out.audible++;
      continue;
    }
    if (await draftIn(t)) {
      out.drafts++;
      continue;
    }
    try {
      if (await chrome.tabs.discard(t.id)) out.n++;
    } catch (e) {
      /* вкладку закрыли или её нельзя выгрузить */
    }
  }
  return out;
}
