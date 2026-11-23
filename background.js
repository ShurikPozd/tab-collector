// Фон: значок открывает страницу сборщика (одну на все окна), меню значка —
// быстрые действия без страницы, восстановление прокрутки у открытых из списка ссылок.

import { collectTabs, sleepTabs, untouchable } from "./core/collect.js";
import { siteOf } from "./core/url.js";

const APP = chrome.runtime.getURL("app/app.html");
const EXT = chrome.runtime.getURL("");

async function openApp(view, fromTab) {
  // вкладка, с которой открыли сборщик, — «текущая»: её не предлагаем собирать
  if (fromTab && fromTab.id != null) await chrome.storage.session.set({ fromTab: fromTab.id });
  const url = APP + (view ? `#${view}` : "");
  const [found] = await chrome.tabs.query({ url: APP + "*" });
  if (found) {
    await chrome.tabs.update(found.id, { active: true, ...(view ? { url } : {}) });
    await chrome.windows.update(found.windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url, index: fromTab ? fromTab.index + 1 : undefined, windowId: fromTab && fromTab.windowId });
}

chrome.action.onClicked.addListener((tab) => openApp("", tab));

function menus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "site", title: "Собрать вкладки этого сайта и закрыть", contexts: ["action"] });
    chrome.contextMenus.create({ id: "sleep", title: "Усыпить все вкладки окна, кроме текущей", contexts: ["action"] });
    chrome.contextMenus.create({ id: "library", title: "Открыть собранные ссылки", contexts: ["action"] });
  });
}
chrome.runtime.onInstalled.addListener(menus);
chrome.runtime.onStartup.addListener(menus);

async function badge(text, tabId) {
  await chrome.action.setBadgeBackgroundColor({ color: "#6d5efc" });
  await chrome.action.setBadgeText({ text, tabId });
  setTimeout(() => chrome.action.setBadgeText({ text: "", tabId }).catch(() => {}), 4000);
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "library") return openApp("library", tab);
  const all = await chrome.tabs.query({ windowId: tab.windowId });
  if (info.menuItemId === "sleep") {
    const n = await sleepTabs(all.filter((t) => t.id !== tab.id && !untouchable(t, EXT)));
    return badge(String(n), tab.id);
  }
  if (info.menuItemId === "site") {
    const site = siteOf(tab.url);
    const pick = all.filter((t) => t.id !== tab.id && !untouchable(t, EXT) && siteOf(t.url) === site);
    if (!pick.length) return badge("0", tab.id);
    const res = await collectTabs(pick);
    return badge(String(res.added + res.merged), tab.id);
  }
});

// Открыть ссылки из списка; у тех, что были прокручены, — вернуть место прокрутки.
const pendingScroll = new Map();

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.type === "open") {
    (async () => {
      const opened = [];
      let i = 0;
      for (const it of msg.items) {
        const t = await chrome.tabs.create({
          url: it.url,
          active: msg.items.length === 1,
          windowId: sender.tab && sender.tab.windowId,
          index: sender.tab ? sender.tab.index + 1 + i++ : undefined,
        });
        if (it.scrollY > 0) pendingScroll.set(t.id, it.scrollY);
        // после второй вкладки — сразу усыпляем (откроются при переходе), чтобы не грузить всё разом
        if (msg.lazy && msg.items.length > 1 && opened.length >= 1) {
          chrome.tabs.discard(t.id).catch(() => {});
        }
        opened.push(t.id);
      }
      reply({ ok: true, n: opened.length });
    })();
    return true;
  }
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status !== "complete" || !pendingScroll.has(tabId)) return;
  const y = pendingScroll.get(tabId);
  pendingScroll.delete(tabId);
  chrome.scripting
    .executeScript({
      target: { tabId },
      func: (y) => {
        const go = () => window.scrollTo({ top: y, behavior: "instant" });
        go();
        setTimeout(go, 600); // страницы, которые дорисовываются после загрузки
      },
      args: [y],
    })
    .catch(() => {});
});
chrome.tabs.onRemoved.addListener((id) => pendingScroll.delete(id));
