// Фон: значок открывает страницу сборщика (одну на все окна), меню значка —
// быстрые действия без страницы, восстановление прокрутки у открытых из списка ссылок.

import { collectTabs, sleepTabs, untouchable } from "./core/collect.js";
import { siteOf, normalizeUrl, collectable } from "./core/url.js";
import { putShot, shrink, pruneShots } from "./core/shots.js";

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

// Значок открывает боковую панель (как у «Сводки комментариев YouTube») или вкладку — по настройке.
async function iconBehavior() {
  const { settings } = await chrome.storage.local.get("settings");
  const panel = !settings || settings.iconOpens !== "tab";
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: panel }).catch(() => {});
}
iconBehavior();
chrome.storage.onChanged.addListener((ch, area) => {
  if (area === "local" && ch.settings && (ch.settings.oldValue || {}).iconOpens !== (ch.settings.newValue || {}).iconOpens) iconBehavior();
});

function menus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: "site", title: "Собрать вкладки этого сайта и закрыть", contexts: ["action"] });
    chrome.contextMenus.create({ id: "sleep", title: "Усыпить все вкладки окна, кроме текущей", contexts: ["action"] });
    chrome.contextMenus.create({ id: "library", title: "Открыть собранные ссылки во вкладке", contexts: ["action"] });
    chrome.contextMenus.create({ id: "panel", title: "Открыть в боковой панели", contexts: ["action"] });
  });
}
chrome.runtime.onInstalled.addListener(menus);
chrome.runtime.onStartup.addListener(menus);
// старые снимки — сверх 3000 — убираем при запуске браузера и обновлении расширения
chrome.runtime.onInstalled.addListener(() => pruneShots().catch(() => {}));
chrome.runtime.onStartup.addListener(() => pruneShots().catch(() => {}));

async function badge(text, tabId) {
  await chrome.action.setBadgeBackgroundColor({ color: "#6d5efc" });
  await chrome.action.setBadgeText({ text, tabId });
  setTimeout(() => chrome.action.setBadgeText({ text: "", tabId }).catch(() => {}), 4000);
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "library") return openApp("library", tab);
  if (info.menuItemId === "panel") return chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  const all = await chrome.tabs.query({ windowId: tab.windowId });
  if (info.menuItemId === "sleep") {
    const res = await sleepTabs(all.filter((t) => t.id !== tab.id && !untouchable(t, EXT)));
    return badge(String(res.n), tab.id);
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
// Нужная прокрутка хранится в chrome.storage.session: усыплённая вкладка грузится, когда вы
// на неё перейдёте (через минуты), а фон к тому времени успевает уснуть и потерять память.
const SCROLL = "scroll";

async function rememberScroll(tabId, y) {
  const d = (await chrome.storage.session.get(SCROLL))[SCROLL] || {};
  d[tabId] = y;
  await chrome.storage.session.set({ [SCROLL]: d });
}

async function takeScroll(tabId) {
  const d = (await chrome.storage.session.get(SCROLL))[SCROLL] || {};
  if (!(tabId in d)) return 0;
  const y = d[tabId];
  delete d[tabId];
  await chrome.storage.session.set({ [SCROLL]: d });
  return y;
}

// усыпить только что открытую вкладку, когда у неё уже есть адрес (иначе останется пустой)
function discardWhenReady(tabId) {
  const done = () => chrome.tabs.onUpdated.removeListener(on);
  const on = (id, change, tab) => {
    if (id !== tabId || !(change.url || tab.url || tab.pendingUrl)) return;
    done();
    chrome.tabs.discard(tabId).catch(() => {});
  };
  chrome.tabs.onUpdated.addListener(on);
  setTimeout(done, 15000);
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.type === "open-app") {
    (async () => {
      const [active] = await chrome.tabs.query({ active: true, windowId: msg.windowId });
      await chrome.storage.session.set({ fromTab: active ? active.id : null });
      await openApp(msg.view === "library" ? "library" : "", active);
      reply({ ok: true });
    })();
    return true;
  }
  if (msg && msg.type === "open") {
    (async () => {
      let n = 0;
      // справа от активной вкладки: из вкладки сборщика — от неё, из боковой панели — от открытой рядом
      let base = sender.tab;
      if (!base && msg.windowId != null) [base] = await chrome.tabs.query({ active: true, windowId: msg.windowId });
      let index = base ? base.index + 1 : undefined;
      for (const it of msg.items) {
        if (!/^(https?|file|ftp):/i.test(it.url || "")) continue; // javascript:, chrome:// и т.п. не открываем
        try {
          const t = await chrome.tabs.create({
            url: it.url,
            active: msg.items.length === 1,
            windowId: base && base.windowId,
            index: index === undefined ? undefined : index++,
          });
          if (it.scrollY > 0) {
            await rememberScroll(t.id, it.scrollY);
            // быстрая страница могла загрузиться, пока запоминали, — тогда прокручиваем сразу
            const now = await chrome.tabs.get(t.id).catch(() => null);
            if (now && now.status === "complete") applyScroll(t.id);
          }
          // все, кроме первой, — усыплёнными: загрузятся, когда вы на них перейдёте
          if (msg.lazy && msg.items.length > 1 && n >= 1) discardWhenReady(t.id);
          n++;
        } catch (e) {
          /* одна негодная ссылка не мешает открыть остальные */
        }
      }
      reply({ ok: true, n });
    })();
    return true;
  }
});

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "complete") applyScroll(tabId);
});

async function applyScroll(tabId) {
  const y = await takeScroll(tabId);
  if (!y) return;
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
}
chrome.tabs.onRemoved.addListener((id) => takeScroll(id).catch(() => {}));

// ---------------------------------------------------------------- снимки для предпросмотра
// Когда вы переходите на вкладку (или она догрузилась на экране), снимаем видимую часть
// и уменьшаем до 640 px. Спящие и фоновые вкладки снять нельзя — только то, что на экране.
let shotTimer = null;
let lastShot = 0;
// банки, госуслуги, почта и входы — не снимаем
const PRIVATE = /(^|\.)(bank|sber|sberbank|tinkoff|tbank|alfabank|vtb|raiffeisen|gazprombank|paypal|qiwi|yoomoney|gosuslugi|nalog|accounts\.google|login|auth|passport|id\.yandex)\b|^(mail|e\.mail|outlook|webmail)\./i;

async function shotsOn() {
  const { settings } = await chrome.storage.local.get("settings");
  return !settings || settings.shots !== false;
}

function scheduleShot(tabId) {
  clearTimeout(shotTimer);
  // даём странице дорисоваться; не чаще ~1 снимка в секунду (лимит Chrome — 2 в секунду)
  shotTimer = setTimeout(() => takeShot(tabId), Math.max(900, 1100 - (Date.now() - lastShot)));
}

async function takeShot(tabId) {
  try {
    if (!(await shotsOn())) return;
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active || tab.incognito || tab.status !== "complete" || !collectable(tab.url) || tab.url.startsWith(EXT)) return;
    const win = await chrome.windows.get(tab.windowId);
    if (win.state === "minimized") return;
    const host = new URL(tab.url).hostname;
    if (PRIVATE.test(host)) return;
    // страница с полем пароля (вход, оплата) — тоже не снимаем
    const [probe] = await chrome.scripting.executeScript({ target: { tabId }, func: () => !!document.querySelector('input[type="password"]') }).catch(() => [null]);
    if (!probe || probe.result) return;
    lastShot = Date.now();
    const data = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 80 });
    // пока снимали, вкладку могли переключить — проверяем, что сняли ту же страницу
    const again = await chrome.tabs.get(tabId);
    if (!again.active || again.url !== tab.url) return;
    await putShot(normalizeUrl(tab.url), await shrink(data));
    // фон засыпает и счётчики в памяти теряются — чистим случайно, в среднем раз в 50 снимков
    if (Math.random() < 0.02) pruneShots().catch(() => {});
  } catch (e) {
    /* вкладку закрыли, окно скрыто или страницу снимать нельзя */
  }
}

chrome.tabs.onActivated.addListener(({ tabId }) => scheduleShot(tabId));
chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.status === "complete" && tab.active) scheduleShot(tabId);
});
