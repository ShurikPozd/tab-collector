// Фон: значок открывает страницу сборщика (одну на все окна), меню значка —
// быстрые действия без страницы, восстановление прокрутки у открытых из списка ссылок.

import { collectTabs, sleepTabs, untouchable } from "./core/collect.js";
import { siteOf, normalizeUrl, collectable } from "./core/url.js";
import { putShot, shrink, pruneShots } from "./core/shots.js";
import { migrateKeys, loadSettings } from "./core/store.js";
import { sendBackup, backupDue } from "./core/backup.js";

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

// ---------- Само перезагружается при новой версии (как «Сводка комментариев YouTube») ----------
// Расширение установлено из папки («распакованное»): когда в manifest.json на диске появляется
// другая версия (её поднимают при каждой правке), оно перезапускается само — не нужно жать
// «Обновить» на chrome://extensions. Для установленного из магазина ничего не делает.
async function devAutoReload() {
  try {
    const self = await chrome.management.getSelf();
    if (self.installType !== "development") return chrome.alarms.clear("dev-reload");
    // будильник — только у распакованного: у установленного из магазина фон зря не просыпается
    if (!(await chrome.alarms.get("dev-reload"))) chrome.alarms.create("dev-reload", { periodInMinutes: 0.5 });
    const disk = await (await fetch(chrome.runtime.getURL("manifest.json"), { cache: "no-store" })).json();
    if (!disk || !disk.version || disk.version === chrome.runtime.getManifest().version) return;
    // не посреди отправки в бота или сбора: иначе отправленное не отметится и уйдёт второй раз
    const { held } = await navigator.locks.query();
    if (held.some((l) => ["tc-send", "tc-collect", "tc-store", "tc-backup"].includes(l.name))) return;
    chrome.runtime.reload();
  } catch (e) {
    /* файл в процессе записи — проверим в следующий раз */
  }
}
chrome.alarms.onAlarm.addListener((a) => a.name === "dev-reload" && void devAutoReload());
void devAutoReload();

// Значок открывает боковую панель (как у «Сводки комментариев YouTube») или вкладку — по настройке.
async function iconBehavior() {
  const { settings } = await chrome.storage.local.get("settings");
  const panel = !settings || settings.iconOpens !== "tab";
  await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: panel }).catch(() => {});
}
iconBehavior();
// меняется в настройках — оттуда приходит сообщение «icon-behavior» (без слежения за каждой записью)

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
chrome.runtime.onInstalled.addListener(() => migrateKeys().catch(() => {}));
chrome.runtime.onStartup.addListener(() => migrateKeys().catch(() => {}));

async function badge(text, tabId) {
  await chrome.action.setBadgeBackgroundColor({ color: "#6d5efc" });
  await chrome.action.setBadgeText({ text, tabId });
  setTimeout(() => chrome.action.setBadgeText({ text: "", tabId }).catch(() => {}), 4000);
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "library") return openApp("library", tab);
  if (info.menuItemId === "panel") return chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
  const all = await chrome.tabs.query({ windowId: tab.windowId, windowType: "normal" });
  if (info.menuItemId === "sleep") {
    const res = await sleepTabs(all.filter((t) => t.id !== tab.id && !untouchable(t, EXT)));
    return badge(String(res.n), tab.id);
  }
  if (info.menuItemId === "site") {
    const site = siteOf(tab.url);
    const fileOk = await chrome.extension.isAllowedFileSchemeAccess().catch(() => false);
    const pick = all.filter((t) => t.id !== tab.id && !untouchable(t, EXT) && siteOf(t.url) === site && (fileOk || !/^file:/i.test(t.url)));
    if (!pick.length) return badge("0", tab.id);
    const res = await navigator.locks.request("tc-collect", () => collectTabs(pick));
    return badge(String(res.items.length), tab.id); // сколько вкладок закрыто (оставленные открытыми не в счёт)
  }
});

// Открыть ссылки из списка; у тех, что были прокручены, — вернуть место прокрутки.
// Нужная прокрутка хранится в chrome.storage.session: усыплённая вкладка грузится, когда вы
// на неё перейдёте (через минуты), а фон к тому времени успевает уснуть и потерять память.
// у каждой вкладки свой ключ — записи для разных вкладок не затирают друг друга
const SK = (id) => `scroll:${id}`;
const LAZY = (id) => `lazy:${id}`; // вкладка вот-вот уснёт: прокрутку применим, когда её разбудят

async function rememberScroll(tabId, y) {
  await chrome.storage.session.set({ [SK(tabId)]: y });
}

async function takeScroll(tabId) {
  const k = SK(tabId);
  const y = (await chrome.storage.session.get(k))[k];
  if (!y) return 0;
  await chrome.storage.session.remove(k);
  return y;
}

// усыпить только что открытую вкладку, когда у неё уже есть настоящий адрес (иначе проснётся пустой)
function discardWhenReady(tabId) {
  const done = () => chrome.tabs.onUpdated.removeListener(on);
  const real = (u) => u && u !== "about:blank";
  let fired = false;
  const on = async (id, change, tab) => {
    if (fired || id !== tabId || !(real(change.url) || real(tab.url))) return;
    fired = true;
    done();
    await chrome.tabs.discard(tabId).catch(() => {});
    await chrome.storage.session.remove(LAZY(tabId)); // теперь прокрутку можно применить при пробуждении
  };
  chrome.tabs.onUpdated.addListener(on);
  // быстрая страница (из кэша) могла получить адрес ещё до того, как мы начали слушать
  chrome.tabs.get(tabId).then((t) => on(tabId, {}, t), () => done());
  setTimeout(() => {
    done();
    chrome.storage.session.remove(LAZY(tabId));
  }, 15000);
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg && msg.type === "backup-now") {
    sendBackup({ manual: true }).then(reply, () => reply({ ok: false, text: "Копия не отправлена." }));
    return true;
  }
  if (msg && msg.type === "backup-soon") {
    // после крупного сбора — копия, если последняя была давно (больше часа назад)
    backupDue(3600 * 1000).then((due) => due && sendBackup()).catch(() => {});
    return false;
  }
  if (msg && msg.type === "schedule") {
    schedule().then(() => reply({ ok: true }));
    return true;
  }
  if (msg && msg.type === "icon-behavior") {
    iconBehavior().then(() => reply({ ok: true }));
    return true;
  }
  if (msg && msg.type === "open-app") {
    (async () => {
      try {
        const [active] = await chrome.tabs.query({ active: true, windowId: msg.windowId });
        await chrome.storage.session.set({ fromTab: active ? active.id : null });
        await openApp(msg.view === "library" ? "library" : "", active || { windowId: msg.windowId });
        reply({ ok: true });
      } catch (e) {
        reply({ ok: false });
      }
    })();
    return true;
  }
  if (msg && msg.type === "focus-tab") {
    focusTab(msg.tabId).then((ok) => reply({ ok }));
    return true;
  }
  if (msg && msg.type === "open") {
    (async () => {
      let n = 0;
      let switched = 0;
      const opened = []; // какие адреса реально открылись (или уже были открыты)
      // какие из ссылок уже открыты во вкладках: их не дублируем
      const openByKey = new Map();
      for (const t of await chrome.tabs.query({})) if (t.url && !t.url.startsWith(EXT)) openByKey.set(normalizeUrl(t.url), t);
      // справа от активной вкладки: из вкладки сборщика — от неё, из боковой панели — от открытой рядом
      let base = sender.tab;
      if (!base && msg.windowId != null) [base] = await chrome.tabs.query({ active: true, windowId: msg.windowId });
      let index = base ? base.index + 1 : undefined;
      for (const it of msg.items) {
        if (!/^(https?|file|ftp):/i.test(it.url || "")) continue; // javascript:, chrome:// и т.п. не открываем
        // force — «Вернуть» после «Закрыть дубли»: открыть копию, хоть такая страница и открыта
        const already = msg.force ? null : openByKey.get(normalizeUrl(it.url));
        if (already) {
          // одна ссылка — переключаемся на её вкладку; из нескольких — просто не открываем вторую копию
          if (msg.items.length === 1) await focusTab(already.id);
          switched++;
          opened.push(it.url);
          continue;
        }
        try {
          const t = await chrome.tabs.create({
            url: it.url,
            active: msg.items.length === 1,
            windowId: base && base.windowId,
            index: index === undefined ? undefined : index++,
          });
          // все, кроме первой, — усыплёнными: загрузятся, когда вы на них перейдёте
          const lazy = msg.lazy && msg.items.length > 1 && n >= 1;
          if (lazy) await chrome.storage.session.set({ [LAZY(t.id)]: true });
          if (it.scrollY > 0) {
            await rememberScroll(t.id, it.scrollY);
            // быстрая страница могла загрузиться, пока запоминали, — тогда прокручиваем сразу
            const now = await chrome.tabs.get(t.id).catch(() => null);
            if (!lazy && now && now.status === "complete") applyScroll(t.id);
          }
          if (lazy) discardWhenReady(t.id);
          n++;
          opened.push(it.url);
        } catch (e) {
          /* одна негодная ссылка не мешает открыть остальные */
        }
      }
      reply({ ok: true, n, switched, opened });
    })();
    return true;
  }
});

/** Перейти к вкладке: сделать её активной и поднять её окно. */
async function focusTab(tabId) {
  try {
    const t = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(t.windowId, { focused: true });
    return true;
  } catch (e) {
    return false;
  }
}

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "complete") applyScroll(tabId);
});

async function applyScroll(tabId) {
  // вкладку сейчас усыпят — прокрутку не тратим, применим, когда вы на неё перейдёте
  if ((await chrome.storage.session.get(LAZY(tabId)))[LAZY(tabId)]) return;
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
chrome.tabs.onRemoved.addListener((id) => chrome.storage.session.remove([SK(id), LAZY(id)]).catch(() => {}));

// ---------------------------------------------------------------- снимки для предпросмотра
// Когда вы переходите на вкладку (или она догрузилась на экране), снимаем видимую часть
// и уменьшаем до 640 px. Спящие и фоновые вкладки снять нельзя — только то, что на экране.
let shotTimer = null;
let lastShot = 0;
// банки, госуслуги, почта, мессенджеры и входы — не снимаем
const PRIVATE = /(^|\.)(bank|sber|sberbank|tinkoff|tbank|alfabank|vtb|raiffeisen|gazprombank|paypal|qiwi|yoomoney|gosuslugi|nalog|accounts\.google|login|auth|passport|id\.yandex|web\.telegram|web\.whatsapp|discord|slack|messenger)\b|^(mail|e\.mail|outlook|webmail)\./i;

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
    // поле пароля (вход, оплата) — в любом кадре страницы, в том числе во встроенных окнах оплаты
    const probes = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => !!document.querySelector('input[type="password"]'), injectImmediately: true }).catch(() => null);
    if (!probes || probes.some((p) => p && p.result)) return;
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

// ---------------------------------------------------------------- автоусыпление и автокопия
// Раз в 15 минут: вкладки, к которым вы не возвращались дольше заданного (Настройки), усыпляются —
// кроме закреплённых, активных, со звуком и с недописанным текстом. Раз в сутки — копия списка в бота.
async function schedule() {
  const st = await loadSettings();
  if (st.autoSleepHours > 0) {
    if (!(await chrome.alarms.get("tc-autosleep"))) chrome.alarms.create("tc-autosleep", { periodInMinutes: 15 });
  } else await chrome.alarms.clear("tc-autosleep");
  if (st.autoBackup !== false) {
    if (!(await chrome.alarms.get("tc-backup"))) chrome.alarms.create("tc-backup", { periodInMinutes: 60, delayInMinutes: 5 });
  } else await chrome.alarms.clear("tc-backup");
}
chrome.runtime.onInstalled.addListener(() => schedule().catch(() => {}));
chrome.runtime.onStartup.addListener(() => schedule().catch(() => {}));
schedule().catch(() => {}); // и при каждом пробуждении фона (выключили и включили расширение — будильники вернутся)

// мессенджеры, созвоны, почта: в фоне ждут сообщений и звонков — их не усыпляем
const KEEP_AWAKE = /(^|\.)(web\.telegram\.org|web\.whatsapp\.com|discord\.com|app\.slack\.com|meet\.google\.com|zoom\.us|teams\.microsoft\.com|teams\.live\.com|vk\.com|web\.max\.ru|mail\.google\.com|mail\.yandex\.ru|e\.mail\.ru|outlook\.live\.com|outlook\.office\.com)$/i;

// когда вы ушли с вкладки: lastAccessed у Chrome — время, когда на неё пришли
async function noteLeave(windowId, newTabId) {
  const k = `act:${windowId}`;
  const prev = (await chrome.storage.session.get(k))[k];
  const set = { [k]: newTabId };
  if (prev != null && prev !== newTabId) set[`left:${prev}`] = Date.now();
  await chrome.storage.session.set(set);
}
// по очереди: при быстром Ctrl+Tab вызовы читали бы одно и то же «прошлое» и теряли время ухода
let leaveChain = Promise.resolve();
chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  leaveChain = leaveChain.then(() => noteLeave(windowId, tabId)).catch(() => {});
});
chrome.tabs.onRemoved.addListener((id) => chrome.storage.session.remove(`left:${id}`).catch(() => {}));

async function autoSleep() {
  const st = await loadSettings();
  const hours = Number(st.autoSleepHours) || 0;
  if (hours <= 0) return;
  const old = Date.now() - hours * 3600 * 1000;
  const all = await chrome.tabs.query({ windowType: "normal" });
  const left = await chrome.storage.session.get(all.map((t) => `left:${t.id}`));
  const tabs = all.filter((t) => {
    if (t.active || t.discarded || t.pinned || t.audible || untouchable(t, EXT)) return false;
    let host = "";
    try {
      host = new URL(t.url).hostname;
    } catch (e) {
      /* пусто */
    }
    if (KEEP_AWAKE.test(host)) return false;
    const last = Math.max(t.lastAccessed || 0, left[`left:${t.id}`] || 0);
    return last > 0 && last < old;
  });
  if (tabs.length) await sleepTabs(tabs); // проверит черновики сама
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === "tc-autosleep") autoSleep().catch(() => {});
  // будильник раз в час, а копия — раз в сутки (если компьютер спал, догоним при пробуждении)
  if (a.name === "tc-backup") backupDue().then((due) => due && sendBackup()).catch(() => {});
});
