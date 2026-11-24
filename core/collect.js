// Сбор вкладок: прочитать со страниц название/описание/прокрутку, сохранить в список,
// закрыть. «Усыпить» — выгрузить из памяти (chrome.tabs.discard), вкладка остаётся.
// Используется и страницей расширения, и фоном (пункт меню значка).

import { makeItem, addItems } from "./store.js";
import { collectable } from "./url.js";

// выполняется ВНУТРИ вкладки — только то, что есть на самой странице
function readPage() {
  // недописанный текст в основном кадре: такую вкладку при сборе не закрываем
  const visible = (el) => el.getClientRects().length > 0;
  const isSearch = (f) => f.tagName === "INPUT" && (f.type === "search" || /^(q|query|search|text)$/i.test(f.name || "") || !!f.closest('[role="search"], form[action*="search"]'));
  let draft = false;
  for (const f of document.querySelectorAll("textarea, input:not([type]), input[type=text], input[type=email], input[type=url], input[type=number], input[type=tel]"))
    if (f.value && f.value !== f.defaultValue && !isSearch(f) && visible(f)) draft = true;
  const ed = document.activeElement;
  if (ed && ed.isContentEditable && ed.textContent.trim()) draft = true;
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
    draft,
  };
}

async function grab(tab, timeout = 1500) {
  // выгруженная или ещё не загруженная вкладка скрипт не выполнит — хватит адреса и заголовка
  if (tab.discarded || tab.status === "unloaded" || !/^https?:/.test(tab.url)) return {};
  try {
    const run = chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readPage, injectImmediately: true });
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

/**
 * Собрать вкладки в список и закрыть их. onProgress(done, total).
 * Вкладки с недописанным текстом (или которые не успели проверить) сохраняются в список,
 * но остаются открытыми (kept).
 * Возвращает { added, merged, ids, items (закрытые), kept (оставлены открытыми) }.
 */
export async function collectTabs(tabs, { close = true, onProgress } = {}) {
  const startedAt = Date.now(); // одно время на весь сбор — по нему «Собранные» группируются «по сборам»
  const items = [];
  const drafts = new Set();
  const unchecked = new Set(); // не успели проверить — тоже оставляем открытыми, но причина другая
  let done = 0;
  const queue = tabs.slice();
  const worker = async () => {
    while (queue.length) {
      const tab = queue.shift();
      const g = await grab(tab);
      // недописанный текст: проверка как у «Усыпить» (все кадры, shadow DOM); не успели — не закрываем
      const loaded = !tab.discarded && tab.status !== "unloaded" && /^https?:/.test(tab.url);
      const check = g.draft ? "yes" : loaded ? await draftIn(tab) : "no";
      if (check !== "no") drafts.add(tab.id);
      if (check === "unknown") unchecked.add(tab.id);
      // вкладка могла перейти на другую страницу, пока шёл сбор: адрес и название — с одной страницы
      const t = g.url && /^https?:/.test(g.url) ? { ...tab, url: g.url } : tab;
      items.push({ order: tabs.indexOf(tab), item: makeItem(t, g, startedAt, startedAt), draft: drafts.has(tab.id) });
      done++;
      onProgress && onProgress(done, tabs.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, tabs.length) }, worker));
  items.sort((a, b) => a.order - b.order);
  const res = await addItems(items.map((x) => x.item));
  res.items = items.filter((x) => !x.draft).map((x) => x.item); // только те, что закрываем (для «Вернуть»)
  res.kept = drafts.size - unchecked.size; // с недописанным текстом
  res.unchecked = unchecked.size; // не успели проверить
  // закрываем только после того, как список записан: ничего не теряется
  if (close) {
    const ids = tabs.map((t) => t.id).filter((id) => !drafts.has(id));
    for (let i = 0; i < ids.length; i += 50) {
      const part = ids.slice(i, i + 50);
      try {
        await chrome.tabs.remove(part);
      } catch (e) {
        // одну из вкладок уже закрыли — остальные закрываем по одной
        for (const id of part) await chrome.tabs.remove(id).catch(() => {});
      }
    }
  }
  return res;
}

// выполняется ВНУТРИ вкладки: есть ли недописанный текст (поле изменено, но не отправлено)
function hasDraft() {
  // видно ли поле (в том числе в окне поверх страницы с position: fixed)
  const visible = (el) => el.getClientRects().length > 0;
  // строку поиска страница часто заполняет сама (YouTube, Google) — это не черновик
  // только для однострочных полей: <textarea name="text"> — это комментарий, а не поиск
  const isSearch = (f) => f.tagName === "INPUT" && (f.type === "search" || /^(q|query|search|text)$/i.test(f.name || "") || !!f.closest('[role="search"], form[action*="search"]'));
  const scan = (root) => {
    const fields = root.querySelectorAll("textarea, input:not([type]), input[type=text], input[type=email], input[type=url], input[type=number], input[type=tel]");
    for (const f of fields) if (f.value && f.value !== f.defaultValue && !isSearch(f) && visible(f)) return true;
    for (const el of root.querySelectorAll("*")) if (el.shadowRoot && scan(el.shadowRoot)) return true;
    return false;
  };
  if (scan(document)) return true;
  // редактор поста/письма (contenteditable), в котором вы сейчас пишете
  const ed = document.activeElement;
  return !!(ed && ed.isContentEditable && ed.textContent.trim());
}

/** "yes" | "no" | "unknown": не успели проверить — не усыпляем (лучше оставить, чем потерять текст). */
async function draftIn(tab) {
  if (tab.status === "unloaded" || !/^https?:/.test(tab.url)) return "no";
  try {
    // все кадры страницы (окно комментария бывает во встроенном кадре); не ждём, пока догрузятся
    const run = chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: hasDraft, injectImmediately: true });
    const res = await Promise.race([run, new Promise((r) => setTimeout(() => r(null), 1500))]);
    if (!res) return "unknown";
    return res.some((x) => x && x.result) ? "yes" : "no";
  } catch (e) {
    return "no"; // на страницу нельзя попасть скриптом (магазин расширений, PDF) — там и черновика нашего не найти
  }
}

/**
 * Выгрузить из памяти. Пропускаем активные (Chrome не даст), со звуком (музыка, звонок)
 * и с недописанным текстом — Chrome при выгрузке его не сохранит.
 * Возвращает { n, audible, drafts }.
 */
export async function sleepTabs(tabs, onProgress) {
  const out = { n: 0, audible: 0, drafts: 0, unknown: 0 };
  const queue = tabs.filter((t) => !t.active && !t.discarded);
  const total = queue.length;
  let done = 0;
  // по 8 вкладок одновременно, как при сборе: сотни вкладок — секунды, а не минуты
  const worker = async () => {
    while (queue.length) {
      const t = queue.shift();
      const d = t.audible ? "" : await draftIn(t);
      if (t.audible) out.audible++;
      else if (d === "yes") out.drafts++;
      else if (d === "unknown") out.unknown++;
      else {
        try {
          if (await chrome.tabs.discard(t.id)) out.n++;
        } catch (e) {
          /* вкладку закрыли или её нельзя выгрузить */
        }
      }
      onProgress && onProgress(++done, total);
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, total) }, worker));
  return out;
}
