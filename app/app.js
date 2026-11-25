// Страница сборщика: «Открытые» (выбор вкладок по сайтам → собрать/усыпить)
// и «Собранные» (список с папками, поиском, открытием и отправкой в Telegram).

import { hydrateIcons, icon } from "./icons.js";
import { isItemKey, load, removeItems, restoreItems, patchItems, addFolder, renameFolder, deleteFolder, saveSettings } from "../core/store.js";
import { collectTabs, sleepTabs, untouchable, draftIn } from "../core/collect.js";
import { findDuplicates } from "../core/dups.js";
import { plural } from "../core/format.js";
import { MARKS, MARK_ICON, MARK_NAV, markLabel } from "../core/marks.js";
import { recognize, siteOf, siteLabel, hostLabel, normalizeUrl, KINDS, SITE_NAMES, providerForSite, siteTitle } from "../core/url.js";
import { shotStamps } from "../core/shots.js";
import { cleanOrphans, migrateKeys } from "../core/store.js";
import { bindPeek, shotUrl, forgetShots, forgetShotKeys } from "./peek.js";
import { runEnrich, onEnrichState, retryFailed } from "./enricher.js";
import { openSend } from "./send.js";
import { openSettings, applyTheme, applyScale, scaleOf } from "./settings.js";
import { askName, confirmDlg, esc } from "./ui.js";

const EXT = chrome.runtime.getURL("");
const PANEL = new URLSearchParams(location.search).has("panel"); // открыто в боковой панели
const PAGE = 200;
const $ = (id) => document.getElementById(id);

const st = {
  view: location.hash === "#library" ? "library" : "open",
  items: [],
  folders: [],
  settings: {},
  tabs: [],
  myTabId: null,
  fromTab: null,
  scope: "all",
  openSel: new Set(),
  openGroups: new Set(),
  libSel: new Set(),
  filter: { type: "all" },
  q: "",
  shown: PAGE,
  enrichLeft: 0,
  shotKeys: new Set(), // у каких ссылок есть снимок страницы
  layout: { open: "tiles", lib: "tiles" }, // плитками (галерея) или списком
  groupBy: "site", // «Собранные»: по сайтам, по сборам или без групп
  closedGroups: new Set(), // свёрнутые группы (запоминаются)
};

const GROUP_LABEL = { site: "Сайты", batch: "Сборы", none: "Без групп" }; // коротко — на кнопке; полностью — в меню
try {
  st.closedGroups = new Set(JSON.parse(localStorage.getItem("tc:closed-groups") || "[]"));
} catch (e) {
  /* по умолчанию всё раскрыто */
}
function saveClosed() {
  try {
    localStorage.setItem("tc:closed-groups", JSON.stringify([...st.closedGroups].slice(-300)));
  } catch (e) {
    /* не критично */
  }
}

/**
 * Разбить показанные ссылки на группы.
 * По сайтам — как в «Открытых»; если слева уже выбран один сайт — по типам (аниме, манга…).
 * По сборам — что собрано за один раз (одно время сбора; старые записи — по паузе больше 2 минут).
 */
function groupItems(items) {
  if (st.groupBy === "none") return null;
  const groups = new Map();
  const add = (key, it, make) => {
    if (!groups.has(key)) groups.set(key, { key, items: [], ...make() });
    groups.get(key).items.push(it);
  };
  if (st.groupBy === "batch") {
    // сбор помечен временем (batch) — по нему; у старых записей без пометки — по паузе больше 2 минут
    const sorted = items.slice().sort((a, b) => (b.batch || b.addedAt) - (a.batch || a.addedAt));
    let cur = null;
    for (const it of sorted) {
      if (it.batch) {
        add(`b:${it.batch}`, it, () => ({ kind: "batch", at: it.batch }));
        cur = null;
        continue;
      }
      if (!cur || cur.last - it.addedAt > 120000) cur = { key: `b:${it.addedAt}`, at: it.addedAt, last: it.addedAt };
      cur.last = it.addedAt;
      add(cur.key, it, () => ({ kind: "batch", at: cur.at }));
    }
    return [...groups.values()];
  }
  const byKind = st.filter.type === "site";
  // известный сайт определяется по адресу: форум Shikimori и каналы YouTube — в той же группе,
  // что аниме и видео, и группа не меняет имя, когда удалили последнюю распознанную ссылку
  for (const it of items) {
    if (byKind) add(`k:${it.kind}`, it, () => ({ kind: "kind", k: it.kind }));
    else {
      // известные сайты — одной группой под своим именем (Shikimori .one и .io, Википедия ru и en)
      const prov = providerForSite(it.site);
      add(prov ? `p:${prov}` : `s:${it.site}`, it, () => ({ kind: "site", site: it.site, sample: it, provider: prov }));
    }
  }
  return [...groups.values()].sort((a, b) => b.items.length - a.items.length);
}

function groupHead(g, visAll) {
  const ids = (visAll.get(g.key) || g.items).map((it) => it.id);
  const nSel = ids.filter((id) => st.libSel.has(id)).length;
  const closed = st.closedGroups.has(g.key);
  const count = (visAll.get(g.key) || g.items).length;
  let lead;
  let title;
  let sub = "";
  if (g.kind === "batch") {
    lead = `<span class="fav lg-ico">${icon("clock", 22)}</span>`;
    title = `Собрано ${dateText(g.at)}`;
    const sites = new Map();
    for (const it of visAll.get(g.key) || g.items) sites.set(it.site, (sites.get(it.site) || 0) + 1);
    sub = [...sites.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([site, n]) => `${hostLabel(site)} ${n}`)
      .join(" · ");
  } else if (g.kind === "kind") {
    const k = KINDS[g.k] || KINDS.page;
    lead = `<span class="fav lg-ico lg-emoji">${k.icon}</span>`;
    title = k.label;
  } else {
    const smp = g.sample;
    lead = `<span class="fav lg-ico">${favImg(smp.favicon, smp.url)}</span>`;
    title = g.provider ? SITE_NAMES[g.provider] : hostLabel(g.site);
    const kinds = new Map();
    for (const it of visAll.get(g.key) || g.items) if (it.kind !== "page") kinds.set(it.kindLabel, (kinds.get(it.kindLabel) || 0) + 1);
    sub = [...kinds.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([kl, n]) => `${kl.toLowerCase()} ${n}`)
      .join(" · ");
  }
  return `<div class="lg-head">
      <span class="chk lg-chk"><input type="checkbox" ${nSel && nSel === ids.length ? "checked" : ""} data-ind="${nSel > 0 && nSel < ids.length ? 1 : 0}" aria-label="Выбрать всю группу «${esc(title)}»" /><span class="box"></span></span>
      ${lead}
      <span class="lg-name"><span class="lg-title">${esc(title)}</span>${sub ? `<span class="lg-sub">${esc(sub)}</span>` : ""}</span>
      <span class="lg-count">${nSel ? `${nSel} из ${count}` : nLinks(count)}</span>
      <button type="button" class="chev" aria-expanded="${!closed}" aria-label="${closed ? "Развернуть" : "Свернуть"} группу «${esc(title)}»">${icon("chevron", 20)}</button>
    </div>`;
}

/** Переключатели «Плитки / Список» и классы списков. */
function applyLayout() {
  $("open-list").classList.toggle("tiles", st.layout.open === "tiles");
  $("lib-list").classList.toggle("tiles", st.layout.lib === "tiles");
  document.querySelectorAll("[data-layout]").forEach((b) => b.setAttribute("aria-checked", String(st.layout[b.dataset.for] === b.dataset.layout)));
}

/** Обновить, у каких ссылок есть снимок. Возвращает true, если что-то поменялось (новый, переснятый, удалённый). */
async function refreshShots() {
  let stamps;
  try {
    stamps = await shotStamps();
  } catch (e) {
    stamps = new Map();
  }
  const prev = st.shotStamps || new Map();
  const changed = [];
  for (const [k, ts] of stamps) if (prev.get(k) !== ts) changed.push(k);
  for (const k of prev.keys()) if (!stamps.has(k)) changed.push(k);
  st.shotStamps = stamps;
  const had = st.shotKeys;
  st.shotKeys = new Set(stamps.keys());
  if (!changed.length) return false;
  if (prev.size) forgetShotKeys(changed);
  // переснятые — просто подменить картинку там, где она уже показана (без перерисовки и мигания)
  const retaken = changed.filter((k) => had.has(k) && st.shotKeys.has(k));
  for (const k of retaken)
    document.querySelectorAll(`img[data-shot="${CSS.escape(k)}"]`).forEach(async (img) => {
      const u = await shotUrl(k);
      if (u) img.src = u;
    });
  // новый или удалённый снимок — перерисовка нужна, только если такая ссылка сейчас на экране
  const shown = new Set([...st.items.map((it) => it.nkey), ...st.tabs.map((t) => normalizeUrl(t.url))]);
  return changed.some((k) => !retaken.includes(k) && shown.has(k));
}

/** Подставить снимки страниц в миниатюры (после отрисовки). */
function fillShots(root) {
  root.querySelectorAll("img[data-shot]").forEach(async (img) => {
    const u = await shotUrl(img.dataset.shot);
    if (u) {
      img.src = u;
      return;
    }
    // снимок успели удалить — иконка сайта вместо пустой серой области
    const box = img.closest(".thumb, .r-thumb");
    if (!box) return;
    const page = img.dataset.page || "";
    box.classList.remove("shot");
    box.classList.add("no-shot");
    box.innerHTML = box.classList.contains("r-thumb")
      ? `<span class="fav fav-big">${favImg("", page)}</span>`
      : `<img class="favimg" src="${esc(page ? siteFav(page) : "")}" alt="" />`;
  });
}

/** Перерисовать, сохранив фокус: после щелчка по флажку с клавиатуры фокус не уходит в начало. */
function keepFocus(root, paint) {
  const a = document.activeElement;
  const host = a && root.contains(a) ? a.closest("[data-tab], [data-id], [data-site], [data-g], [data-f], .nav-pick") : null;
  const key =
    host &&
    (host.dataset.tab
      ? `[data-tab="${host.dataset.tab}"]`
      : host.dataset.id
        ? `[data-id="${CSS.escape(host.dataset.id)}"]`
        : host.dataset.site
          ? `[data-site="${CSS.escape(host.dataset.site)}"]`
          : host.dataset.g
            ? `[data-g="${CSS.escape(host.dataset.g)}"]`
          : host.dataset.f
            ? `[data-f="${CSS.escape(host.dataset.f)}"]`
            : host.classList.contains("nav-folders-btn")
              ? ".nav-folders-btn"
              : host.classList.contains("nav-marks-btn")
                ? ".nav-marks-btn"
                : ".nav-sites-btn");
  const role = a && (a.matches("input") ? "input" : a.matches("button.chev") ? "button.chev" : a.matches("a[data-open]") ? "a[data-open]" : a.matches("[data-act]") ? `[data-act="${a.dataset.act}"]` : "");
  paint();
  if (!key) return;
  const again = root.querySelector(key);
  const target = again && (role ? again.querySelector(role) || again : again);
  if (target && target.focus) target.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- утилиты

// подсветка ищется в исходном тексте, а не в экранированном («amp» не найдётся внутри &amp;)
function hl(text, q) {
  const raw = String(text ?? "");
  if (!q) return esc(raw);
  const words = q.split(/\s+/).filter((w) => w.length > 1).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!words.length) return esc(raw);
  return raw
    .split(new RegExp(`(${words.join("|")})`, "gi"))
    .map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part)))
    .join("");
}

function matches(q, ...fields) {
  if (!q) return true;
  const hay = fields.join(" ").toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

const nTabs = (n) => `${n} ${plural(n, "вкладка", "вкладки", "вкладок")}`;
const nTabsAcc = (n) => `${n} ${plural(n, "вкладку", "вкладки", "вкладок")}`;
const nLinks = (n) => `${n} ${plural(n, "ссылка", "ссылки", "ссылок")}`;
const nLinksAcc = (n) => `${n} ${plural(n, "ссылку", "ссылки", "ссылок")}`;
const nSites = (n) => `${n} ${plural(n, "сайте", "сайтах", "сайтах")}`;

/** Иконка сайта: своя у вкладки, иначе — из кэша Chrome; не загрузилась — значок «глобус». */
function favImg(url, pageUrl) {
  const src = url || (pageUrl && /^https?:/.test(pageUrl) ? siteFav(pageUrl) : "");
  if (src) return `<img class="fav-img" src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`;
  return icon("globe", 18);
}

/** Иконка сайта через кэш Chrome (_favicon), если у записи своей нет. */
function siteFav(pageUrl) {
  const u = new URL(chrome.runtime.getURL("/_favicon/"));
  u.searchParams.set("pageUrl", pageUrl);
  u.searchParams.set("size", "32");
  return u.toString();
}

function dateText(ts) {
  const d = new Date(ts);
  const today = new Date();
  const same = d.toDateString() === today.toDateString();
  if (same) return `сегодня, ${d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: d.getFullYear() === today.getFullYear() ? undefined : "numeric" });
}

let toastTimer = null;
export function toast(text, undo) {
  const el = $("toast");
  $("toast-text").textContent = text;
  const btn = $("toast-undo");
  btn.hidden = !undo;
  btn.onclick = undo
    ? async () => {
        el.hidden = true;
        await undo();
      }
    : null;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), undo ? 8000 : 4000);
}

function progress(frac) {
  const p = $("progress");
  if (frac == null) {
    p.hidden = true;
    return;
  }
  p.hidden = false;
  p.firstElementChild.style.width = `${Math.round(frac * 100)}%`;
}

// ---------------------------------------------------------------- данные

async function reloadItems() {
  const d = await load();
  st.items = d.items;
  st.folders = d.folders;
  st.settings = d.settings;
  const ids = new Set(st.items.map((it) => it.id));
  for (const id of st.libSel) if (!ids.has(id)) st.libSel.delete(id);
  if (st.filter.type === "folder" && !st.folders.some((f) => f.id === st.filter.id)) st.filter = { type: "all" };
  if (st.filter.type === "mark" && !st.items.some((it) => it.mark === st.filter.mark)) st.filter = { type: "all" };
}

async function reloadTabs() {
  const me = PANEL ? null : await chrome.tabs.getCurrent();
  st.myTabId = me && me.id;
  // во вкладке окно может смениться (вкладку перетащили); панель всегда в своём окне
  if (me) st.myWindowId = me.windowId;
  else if (st.myWindowId == null) st.myWindowId = (await chrome.windows.getCurrent()).id;
  const q = st.scope === "window" ? { windowId: st.myWindowId } : {};
  st.tabs = await chrome.tabs.query({ ...q, windowType: "normal" }); // попапы и окна приложений не трогаем
  if (st.fileOk == null) st.fileOk = await chrome.extension.isAllowedFileSchemeAccess().catch(() => false);
  // какие ссылки сейчас открыты во вкладках (для «● открыта» и перехода вместо дубля)
  const all = st.scope === "window" ? await chrome.tabs.query({}) : st.tabs;
  st.openKeys = new Set(all.filter((t) => t.url && !t.url.startsWith(EXT)).map((t) => normalizeUrl(t.url)));
  // выбор держим только на тех, что ещё можно собрать (вкладка могла закрыться или стать текущей)
  const live = new Set(st.tabs.filter((t) => selectable(t)).map((t) => t.id));
  for (const id of st.openSel) if (!live.has(id)) st.openSel.delete(id);
}

// ---------------------------------------------------------------- «Открытые»

function tabState(t) {
  if (t.id === st.myTabId) return "self";
  const u = untouchable(t, EXT);
  if (u) return u;
  // файлы с диска: без «Доступа к URL файлов» расширение не сможет их потом открыть — не собираем
  if (/^file:/i.test(t.url) && !st.fileOk) return "system";
  // в панели «текущая» — та, что открыта рядом с панелью; во вкладке — с которой открыли сборщик
  if (PANEL ? t.active && t.windowId === st.myWindowId : t.id === st.fromTab) return "current";
  return "";
}

function openGroups() {
  const groups = new Map();
  for (const t of st.tabs) {
    const s = tabState(t);
    if (s && s !== "current") continue; // закреплённые/служебные/сам сборщик — не показываем
    if (!matches(st.q, t.title, t.url)) continue;
    const site = siteOf(t.url);
    if (!groups.has(site)) groups.set(site, []);
    groups.get(site).push(t);
  }
  return [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
}

function selectable(t) {
  return tabState(t) === "";
}

function renderOpen() {
  const groups = openGroups();
  const list = $("open-list");
  const total = groups.reduce((n, [, ts]) => n + ts.filter(selectable).length, 0);
  $("open-count").textContent = String(st.tabs.filter((t) => tabState(t) === "").length || "");
  $("open-empty").hidden = groups.length > 0;
  const autoOpen = groups.length <= 3 || !!st.q;

  const html = groups
    .map(([site, tabs]) => {
      const pick = tabs.filter(selectable);
      const nSel = pick.filter((t) => st.openSel.has(t.id)).length;
      const kinds = new Map();
      for (const t of tabs) {
        const r = recognize(t.url);
        if (r.kind !== "page") kinds.set(r.kindLabel, (kinds.get(r.kindLabel) || 0) + 1);
      }
      const kindsText = [...kinds.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, n]) => `${k.toLowerCase()} ${n}`)
        .join(" · ");
      const isOpen = autoOpen || st.openGroups.has(site);
      const rows = isOpen
        ? tabs
            .map((t) => {
              const s = tabState(t);
              const r = recognize(t.url);
              const tags = [
                r.kind !== "page" ? `<span class="tag kind">${r.icon} ${esc(r.kindLabel)}</span>` : "",
                t.discarded ? `<span class="tag">${icon("sleep", 14)}усыплена</span>` : "",
                t.audible ? `<span class="tag">${icon("sound", 14)}звук</span>` : "",
                s === "current" ? `<span class="tag">текущая</span>` : "",
              ].join("");
              let path = t.url;
              try {
                const u = new URL(t.url);
                path = decodeURI(u.pathname + u.search);
              } catch (e) {
                /* как есть */
              }
              const key = normalizeUrl(t.url);
              // в плитках — снимок страницы (если вы на неё заходили) или крупная иконка сайта
              const thumb = st.shotKeys.has(key)
                ? `<span class="r-thumb shot"><img class="cover" data-shot="${esc(key)}" data-page="${esc(t.url)}" alt="" /></span>`
                : `<span class="r-thumb"><span class="fav fav-big">${favImg(t.favIconUrl, t.url)}</span></span>`;
              return `<label class="row${s ? " off" : ""}" data-tab="${t.id}">
                ${thumb}
                <span class="chk"><input type="checkbox" ${st.openSel.has(t.id) ? "checked" : ""} ${s ? "disabled" : ""} aria-label="Выбрать вкладку" /><span class="box"></span></span>
                <span class="fav">${favImg(t.favIconUrl, t.url)}</span>
                <span class="r-text"><span class="r-title">${hl(t.title || t.url, st.q)}</span><span class="r-url">${hl(path, st.q)}</span></span>
                <span class="tags">${tags}</span>
                <button type="button" class="icon-btn r-go" data-go title="Перейти к этой вкладке (или двойной щелчок)" aria-label="Перейти к вкладке ${esc(t.title || t.url)}">${icon("external", 18)}</button>
              </label>`;
            })
            .join("")
        : "";
      return `<section class="group${isOpen ? " open" : ""}" data-site="${esc(site)}">
        <div class="g-head">
          <span class="chk g-chk"><input type="checkbox" ${pick.length && nSel === pick.length ? "checked" : ""} ${pick.length ? "" : "disabled"} data-ind="${nSel > 0 && nSel < pick.length ? 1 : 0}" aria-label="Выбрать все вкладки ${esc(site)}" /><span class="box"></span></span>
          <span class="fav">${favImg((tabs.find((t) => t.favIconUrl) || {}).favIconUrl, tabs[0].url)}</span>
          <span class="g-name"><span class="g-title">${esc(hostLabel(site))}</span>${kindsText ? `<span class="g-kinds">${esc(kindsText)}</span>` : ""}</span>
          <span class="g-count">${nSel ? `${nSel} из ${pick.length}` : tabs.length}<span class="g-count-w"> ${nSel ? "" : plural(tabs.length, "вкладка", "вкладки", "вкладок")}</span></span>
          <button type="button" class="chev" aria-expanded="${isOpen}" aria-label="${isOpen ? "Свернуть" : "Показать"} вкладки ${esc(hostLabel(site))}">${icon("chevron", 20)}</button>
          ${isOpen ? "" : `<span class="g-list">${tabs
            .slice(0, 3)
            .map((t) => `<span>${esc(t.title || t.url)}</span>`)
            .join("")}${tabs.length > 3 ? `<span class="g-more">и ещё ${tabs.length - 3}</span>` : ""}</span>`}
        </div>
        <div class="g-rows">${rows}</div>
      </section>`;
    })
    .join("");
  if (html !== st.openHtml) {
    st.openHtml = html;
    keepFocus(list, () => (list.innerHTML = html));
  }
  list.querySelectorAll('input[data-ind="1"]').forEach((i) => (i.indeterminate = true));
  fillShots(list);

  const sel = st.openSel.size;
  const all = $("open-all");
  all.checked = total > 0 && sel >= total;
  all.indeterminate = sel > 0 && sel < total;
  all.disabled = total === 0;
  $("open-summary").innerHTML = sel
    ? `Выбрано <b>${sel}</b> из ${total}`
    : `${esc(nTabs(total))} на ${esc(nSites(groups.length))}`;
  // дубли: одна и та же страница открыта несколько раз
  const dups = findDuplicates(st.tabs.filter((t) => tabState(t) === ""), normalizeUrl);
  st.dups = dups.close;
  $("dups-btn").hidden = !dups.close.length;
  $("dups-label").textContent = `Закрыть дубли (${dups.close.length})`;
  $("dups-btn").disabled = !!st.collecting;
  $("collect-btn").disabled = !sel || !!st.collecting;
  $("sleep-btn").disabled = !sel || !!st.collecting;
}

/** Перейти к открытой вкладке. В панели панель остаётся, во вкладке сборщика — переключаемся. */
async function goTab(tabId) {
  const r = await chrome.runtime.sendMessage({ type: "focus-tab", tabId }).catch(() => null);
  if (!r || !r.ok) toast("Эта вкладка уже закрыта");
}

function visibleSelectable() {
  return openGroups().flatMap(([, ts]) => ts.filter(selectable));
}

function bindOpen() {
  $("open-list").addEventListener("click", (e) => {
    const head = e.target.closest(".g-head");
    if (head) {
      st.lastRowClick = null; // щелчок по заголовку сайта — второй щелчок по вкладке не «двойной»
      const group = head.parentElement;
      const site = group.dataset.site;
      if (e.target.closest(".g-chk")) {
        e.preventDefault();
        const tabs = openGroups().find(([s]) => s === site)?.[1].filter(selectable) || [];
        const allOn = tabs.every((t) => st.openSel.has(t.id));
        for (const t of tabs) allOn ? st.openSel.delete(t.id) : st.openSel.add(t.id);
      } else if (st.openGroups.has(site)) st.openGroups.delete(site);
      else st.openGroups.add(site);
      renderOpen();
      return;
    }
    const go = e.target.closest("[data-go]");
    if (go) {
      e.preventDefault();
      return goTab(Number(go.closest(".row").dataset.tab));
    }
    const row = e.target.closest(".row");
    if (!row) return;
    // двойной щелчок — перейти к вкладке. Ловим по счётчику щелчков (e.detail): после первого
    // щелчка строка перерисовывается, и обычное событие dblclick до списка не доходит.
    // Переход — только если оба щелчка по одной строке и не по флажку; тройной — ничего.
    const id0 = Number(row.dataset.tab);
    const onChk = !!e.target.closest(".chk");
    if (e.detail > 2) {
      e.preventDefault();
      return;
    }
    const double = e.detail === 2 && !onChk && st.lastRowClick === id0;
    if (e.detail <= 1) st.lastRowClick = onChk ? null : id0;
    if (e.detail === 2 && !double) st.lastRowClick = null;
    if (!row.classList.contains("off")) {
      e.preventDefault();
      const id = Number(row.dataset.tab);
      // второй щелчок возвращает выбор как было — двойной щелчок выбор не меняет
      st.openSel.has(id) ? st.openSel.delete(id) : st.openSel.add(id);
      renderOpen();
    }
    if (double) goTab(Number(row.dataset.tab));
  });
  $("open-all").addEventListener("change", (e) => {
    const tabs = visibleSelectable();
    if (e.target.checked) tabs.forEach((t) => st.openSel.add(t.id));
    else st.openSel.clear();
    renderOpen();
  });
  document.querySelectorAll("[data-scope]").forEach((b) =>
    b.addEventListener("click", async () => {
      st.scope = b.dataset.scope;
      document.querySelectorAll("[data-scope]").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
      await reloadTabs();
      renderOpen();
    })
  );

  $("collect-btn").addEventListener("click", async () => {
    const tabs = st.tabs.filter((t) => st.openSel.has(t.id) && selectable(t));
    if (!tabs.length || st.collecting) return;
    st.collecting = true;
    renderOpen();
    let res;
    try {
      res = await navigator.locks.request("tc-collect", () => collectTabs(tabs, { onProgress: (d, n) => progress(d / n) }));
    } catch (e) {
      toast("Не получилось собрать вкладки — они остались открытыми.");
      return;
    } finally {
      st.collecting = false;
      progress(null);
      renderOpen();
    }
    st.openSel.clear();
    await reloadItems();
    await reloadTabs();
    render();
    const extra = [
      res.merged ? `${res.merged} уже были в списке` : "",
      res.kept ? `${res.kept} с недописанным текстом оставлены открытыми` : "",
      res.unchecked ? `${res.unchecked} не успели проверить — оставлены открытыми` : "",
      res.moved ? `${res.moved} — вы на них перешли или они сменили страницу, оставлены открытыми` : "",
    ]
      .filter(Boolean)
      .join(", ");
    const closed = res.items; // вкладки с черновиками не закрывались — их и не открываем
    toast(`Собрано: ${nTabs(tabs.length)}${extra ? ` (${extra})` : ""}`, async () => {
      // «Вернуть»: открыть закрытые вкладки обратно (усыплёнными, на месте прокрутки) и убрать добавленные записи
      const back = await chrome.runtime.sendMessage({ type: "open", items: closed.map((it) => ({ url: it.url, scrollY: it.scrollY || 0 })), lazy: true, windowId: st.myWindowId }).catch(() => null);
      // убираем из списка только то, что действительно снова открылось (файл с диска может не открыться)
      const reopened = new Set((back && back.opened) || []);
      const added = new Set(res.ids);
      await removeItems(res.items.filter((it) => added.has(it.id) && reopened.has(it.url)).map((it) => it.id).concat(res.ids.filter((id) => !res.items.some((it) => it.id === id))));
      await reloadItems();
      await reloadTabs();
      render();
    });
    runEnrich();
    if (tabs.length >= 20) chrome.runtime.sendMessage({ type: "backup-soon" }).catch(() => {});
  });

  $("dups-btn").addEventListener("click", async () => {
    const list = (st.dups || []).slice();
    if (!list.length || st.collecting) return;
    const pages = new Set(list.map((t) => normalizeUrl(t.url))).size;
    if (!(await confirmDlg(`Закрыть дубли: ${nTabsAcc(list.length)}?`, `Эти страницы (${pages}) открыты несколько раз — останется по одной копии: закреплённая, активная или та, где вы были последним. Вкладки с недописанным текстом не закроются.`, "Закрыть дубли"))) return;
    st.collecting = true;
    renderOpen();
    const closed = [];
    const closing = new Set(); // закрытые и закрываемые прямо сейчас (воркеры идут параллельно)
    let skipped = 0;
    let unknown = 0;
    try {
      // пока было открыто окно подтверждения, вкладки могли измениться — пересчитываем по свежему
      // списку, но закрываем только те, что были в подтверждённом числе
      const agreed = new Set(list.map((t) => t.id));
      await reloadTabs();
      const fresh = findDuplicates(st.tabs.filter((t) => tabState(t) === ""), normalizeUrl).close.filter((t) => agreed.has(t.id));
      const queue = fresh.slice();
      const worker = async () => {
        while (queue.length) {
          const t = queue.shift();
          // состояние — свежее: спящую копию могли разбудить и начать в ней писать
          const cur = await chrome.tabs.get(t.id).catch(() => null);
          if (!cur) continue;
          const d = await draftIn(cur);
          if (d !== "no") {
            d === "yes" ? skipped++ : unknown++; // недописанный текст или не успели проверить — не трогаем
            continue;
          }
          // пока проверяли, на вкладку могли перейти или открыть в ней другую страницу
          const now = await chrome.tabs.get(t.id).catch(() => null);
          if (!now || now.active || now.pinned || now.audible || now.url !== t.url) continue;
          // оставляемую копию могли закрыть, пока проверяли черновик, — тогда эту не трогаем.
          // Себя отмечаем ДО поиска копий: две копии не сочтут друг друга оставленными
          const key = normalizeUrl(t.url);
          closing.add(t.id);
          const twins = (await chrome.tabs.query({ windowType: "normal" }).catch(() => [])).filter((x) => !closing.has(x.id) && !x.incognito && normalizeUrl(x.url || "") === key);
          if (!twins.length) {
            closing.delete(t.id);
            continue;
          }
          try {
            await chrome.tabs.remove(t.id);
            closed.push(t);
          } catch (e) {
            /* уже закрыта */
          }
        }
      };
      await navigator.locks.request("tc-collect", () => Promise.all(Array.from({ length: Math.min(8, queue.length) }, worker)));
    } finally {
      st.collecting = false;
      await reloadTabs();
      renderOpen();
    }
    const kept = [skipped && `${skipped} с недописанным текстом`, unknown && `${unknown} не удалось проверить`].filter(Boolean).join(", ");
    toast(`Закрыто дублей: ${closed.length}${kept ? ` (оставлены: ${kept})` : ""}`, async () => {
      // force: такая страница открыта (оставленная копия), но вернуть нужно именно закрытые копии
      await chrome.runtime.sendMessage({ type: "open", items: closed.map((t) => ({ url: t.url })), lazy: true, force: true, windowId: st.myWindowId }).catch(() => {});
    });
  });

  $("sleep-btn").addEventListener("click", async () => {
    const tabs = st.tabs.filter((t) => st.openSel.has(t.id) && selectable(t));
    if (!tabs.length || st.collecting) return;
    st.collecting = true;
    renderOpen();
    let res;
    try {
      res = await sleepTabs(tabs, (d, n) => progress(d / n));
    } catch (e) {
      res = null;
    } finally {
      st.collecting = false;
      progress(null);
    }
    if (!res) {
      renderOpen();
      return toast("Не получилось усыпить вкладки");
    }
    st.openSel.clear();
    await reloadTabs();
    renderOpen();
    const why = [
      res.drafts ? `${res.drafts} — с недописанным текстом` : "",
      res.audible ? `${res.audible} — со звуком` : "",
      res.unknown ? `${res.unknown} — не успели проверить` : "",
    ].filter(Boolean);
    toast(`Усыплено: ${nTabs(res.n)}${why.length ? `. Не тронуты: ${why.join(", ")}` : ""}`);
  });
}

// ---------------------------------------------------------------- «Собранные»

function inFilter(it, f = st.filter) {
  if (f.type === "unsent") return !it.sentAt;
  if (f.type === "sent") return !!it.sentAt;
  if (f.type === "folder") return it.folder === f.id;
  if (f.type === "site") return it.site === f.site && (!f.kind || it.kind === f.kind);
  if (f.type === "mark") return it.mark === f.mark;
  return true;
}

function libVisible() {
  return st.items.filter((it) => inFilter(it) && matches(st.q, it.title, it.description, it.meta, it.url, it.siteName, it.kindLabel));
}

function navItem(f, label, count, lead = "", sub = false, extra = "") {
  const cur =
    st.filter.type === f.type &&
    (f.type !== "folder" || st.filter.id === f.id) &&
    (f.type !== "site" || (st.filter.site === f.site && (st.filter.kind || "") === (f.kind || ""))) &&
    (f.type !== "mark" || st.filter.mark === f.mark);
  return `<button type="button" class="nav-item${sub ? " sub" : ""}${extra ? " " + extra : ""}" aria-current="${cur}" title="${esc(label)}" aria-label="${esc(`${label}: ${count}`)}" data-f='${esc(JSON.stringify(f))}'>
    ${lead || "<span></span>"}<span class="n-label">${esc(label)}</span><span class="n-count">${count}</span></button>`;
}

function renderSide() {
  const items = st.items;
  const sent = items.filter((it) => it.sentAt).length;
  let h = "";
  h += navItem({ type: "all" }, "Все ссылки", items.length, `<span class="nav-emoji">${icon("list", 18)}</span>`, false, "nav-main");
  h += navItem({ type: "unsent" }, "Не отправлены", items.length - sent, `<span class="nav-emoji">${icon("inbox", 18)}</span>`, false, "nav-main");
  h += navItem({ type: "sent" }, "В Telegram", sent, `<span class="nav-emoji">${icon("send", 18)}</span>`, false, "nav-main");
  // отметки — появляются, когда отмечена хоть одна ссылка
  const markCount = Object.fromEntries(MARKS.map((m) => [m, items.filter((it) => it.mark === m).length]));
  if (MARKS.some((m) => markCount[m])) {
    for (const m of MARKS) h += navItem({ type: "mark", mark: m }, MARK_NAV[m], markCount[m], `<span class="nav-emoji">${MARK_ICON[m]}</span>`, false, "nav-mark");
    const curMark = st.filter.type === "mark" ? st.filter.mark : "";
    h += `<button type="button" class="nav-item nav-pick nav-marks-btn${curMark ? " on" : ""}" aria-haspopup="menu" aria-current="${!!curMark}" title="${curMark ? MARK_NAV[curMark] : "Отметки"}" aria-label="${curMark ? `Отметка: ${MARK_NAV[curMark]}` : "Отметки"}" aria-expanded="false">
      <span class="nav-emoji">${icon("star", 18)}</span><span class="n-label">${curMark ? MARK_NAV[curMark] : "Отметки"}</span><span class="n-count">${icon("chevron", 14)}</span></button>`;
  }
  // узко: папки — одной кнопкой с меню (как сайты)
  const curFolder = st.filter.type === "folder" ? st.folders.find((f) => f.id === st.filter.id) : null;
  h += `<button type="button" class="nav-item nav-pick nav-folders-btn${curFolder ? " on" : ""}" aria-haspopup="menu" aria-current="${!!curFolder}" title="${curFolder ? esc(curFolder.name) : "Папки"}" aria-label="${curFolder ? esc(`Папка: ${curFolder.name}`) : "Папки"}" aria-expanded="false">
    <span class="nav-emoji">${icon("folder", 18)}</span><span class="n-label">${curFolder ? esc(curFolder.name) : "Папки"}</span><span class="n-count">${icon("chevron", 14)}</span></button>`;

  h += `<div class="side-h"><span>Папки</span><button type="button" class="icon-btn" id="folder-new" title="Новая папка" aria-label="Новая папка">${icon("plus", 18)}</button></div>`;
  if (!st.folders.length) h += `<p class="side-empty">Пока нет. Выберите ссылки и нажмите «В папку».</p>`;
  for (const f of st.folders) {
    h += navItem({ type: "folder", id: f.id }, f.name, items.filter((it) => it.folder === f.id).length, `<span class="nav-emoji">${icon("folder", 18)}</span>`, false, "nav-folder");
  }

  const sites = new Map();
  for (const it of items) {
    if (!sites.has(it.site)) sites.set(it.site, { n: 0, kinds: new Map(), sample: it });
    const s = sites.get(it.site);
    s.n++;
    s.kinds.set(it.kind, (s.kinds.get(it.kind) || 0) + 1);
    if (!s.sample.favicon && it.favicon) s.sample = it;
  }
  const siteList = [...sites.entries()].sort((a, b) => b[1].n - a[1].n);
  // известные сайты — по имени (Shikimori), остальные — по адресу: «Тестовый блог» на трёх хостах не сольётся
  const baseLabel = (site) => siteTitle(site); // как у заголовков групп
  const labelCount = new Map();
  for (const [site, s] of siteList) labelCount.set(baseLabel(site, s), (labelCount.get(baseLabel(site, s)) || 0) + 1);
  // две «Википедии» (ru и en) — с адресом, чтобы отличать
  // имя совпадает с адресом (hh.ru и spb.hh.ru) — адрес вместо «hh.ru · hh.ru»
  const labelOf = (site, s) => {
    const b = baseLabel(site, s);
    return labelCount.get(b) > 1 ? (b === site ? site : `${b} · ${site}`) : b;
  };
  st.siteList = siteList.map(([site, s]) => ({ site, label: labelOf(site, s), n: s.n, sample: s.sample }));
  // на узком экране сайты — не длинной лентой, а одной кнопкой с меню
  if (sites.size) {
    const curSite = st.filter.type === "site" ? st.siteList.find((x) => x.site === st.filter.site) : null;
    h += `<button type="button" class="nav-item nav-pick nav-sites-btn${curSite ? " on" : ""}" aria-haspopup="menu" aria-current="${!!curSite}" title="${curSite ? esc(curSite.label) : "Сайты"}" aria-label="${curSite ? esc(`Сайт: ${curSite.label}`) : "Сайты"}" aria-expanded="false">
      <span class="nav-emoji">${icon("globe", 18)}</span><span class="n-label">${curSite ? esc(curSite.label) : "Сайты"}</span><span class="n-count">${icon("chevron", 14)}</span></button>`;
    h += `<div class="side-h"><span>Сайты</span></div>`;
  }
  for (const [site, s] of siteList) {
    const lead = `<span class="fav">${favImg(s.sample.favicon, s.sample.url)}</span>`;
    h += navItem({ type: "site", site }, labelOf(site, s), s.n, lead, false, "nav-site");
    if (st.filter.type === "site" && st.filter.site === site && s.kinds.size > 1) {
      for (const [kind, n] of [...s.kinds.entries()].sort((a, b) => b[1] - a[1])) {
        const k = KINDS[kind] || KINDS.page;
        h += navItem({ type: "site", site, kind }, k.label, n, `<span class="nav-emoji">${k.icon}</span>`, true, "nav-site");
      }
    }
  }
  if (h !== st.sideHtml) {
    st.sideHtml = h;
    keepFocus($("side-nav"), () => ($("side-nav").innerHTML = h));
    // меню «Папки»/«Сайты» открыто — его кнопка пересоздана: привязываем к новой
    const menu = $("folder-menu");
    if (!menu.hidden && ["folder-pick", "sites", "mark-pick"].includes(menu.dataset.kind)) {
      const btn = $("side-nav").querySelector({ sites: ".nav-sites-btn", "folder-pick": ".nav-folders-btn", "mark-pick": ".nav-marks-btn" }[menu.dataset.kind]);
      if (btn) {
        menuOpener = btn;
        btn.setAttribute("aria-expanded", "true");
      } else closeMenu();
    }
  }
}

function card(it) {
  const folder = it.folder && st.folders.find((f) => f.id === it.folder);
  const thumb = it.image
    ? `<span class="thumb${["anime", "manga", "ranobe", "character", "person"].includes(it.kind) ? " poster" : ""}"><img class="cover" src="${esc(it.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" /></span>`
    : st.shotKeys.has(it.nkey)
      ? `<span class="thumb shot"><img class="cover" data-shot="${esc(it.nkey)}" data-page="${esc(it.url)}" alt="" /></span>`
      : `<span class="thumb"><img class="favimg" src="${esc(it.favicon || siteFav(it.url))}" alt="" loading="lazy" /></span>`;
  const foot = [
    `<span>${esc(dateText(it.addedAt))}</span>`,
    folder ? `<span>${icon("folder", 14).replace("<svg", '<svg style="display:inline;vertical-align:-2px;margin-right:4px"')}${esc(folder.name)}</span>` : "",
    it.sentAt ? `<span class="c-sent">✓ в Telegram${it.sentCategory ? ` · ${esc(it.sentCategory)}` : ""}</span>` : "",
    it.enrich === "pending" ? `<span class="c-pending">уточняю описание…</span>` : "",
    st.openKeys && st.openKeys.has(it.nkey) ? `<span class="c-open">● открыта</span>` : "",
  ].join("");
  return `<article class="card${st.libSel.has(it.id) ? " sel" : ""}" data-id="${esc(it.id)}">
    <label class="chk"><input type="checkbox" ${st.libSel.has(it.id) ? "checked" : ""} aria-label="Выбрать" /><span class="box"></span></label>
    ${thumb}
    <div class="c-body">
      <div class="c-kicker"><span class="tag kind">${esc(it.icon)} ${esc(it.kindLabel)}</span>${it.mark ? `<span class="tag mark mark-${esc(it.mark)}">${MARK_ICON[it.mark] || ""} ${esc(markLabel(it.mark, it.kind))}</span>` : ""}<span>${esc(siteLabel(it))}</span></div>
      <a class="c-title" href="${esc(it.url)}" data-open>${hl(it.title || it.url, st.q)}</a>
      ${it.meta ? `<div class="c-meta">${hl(it.meta, st.q)}</div>` : ""}
      ${it.description ? `<div class="c-desc">${hl(it.description, st.q)}</div>` : ""}
      <div class="c-foot">${foot}</div>
    </div>
    <div class="c-actions">
      <button type="button" class="icon-btn" data-act="open" title="${st.openKeys && st.openKeys.has(it.nkey) ? "Перейти к открытой вкладке" : "Открыть"}" aria-label="${st.openKeys && st.openKeys.has(it.nkey) ? "Перейти к открытой вкладке" : "Открыть"}">${icon("external", 18)}</button>
      <button type="button" class="icon-btn" data-act="mark" aria-haspopup="menu" title="Отметить: хочу, смотрю, готово" aria-label="Отметить">${icon("star", 18)}</button>
      <button type="button" class="icon-btn" data-act="del" title="Убрать из списка" aria-label="Убрать из списка">${icon("trash", 18)}</button>
    </div>
  </article>`;
}

function renderLib() {
  renderSide();
  const vis = libVisible();
  $("lib-count").textContent = String(st.items.length || "");
  // «По сборам» — показываем от новых сборов к старым (в списке порядок может быть другим после загрузки копии)
  const ordered = st.groupBy === "batch" ? vis.slice().sort((a, b) => (b.batch || b.addedAt) - (a.batch || a.addedAt)) : vis;
  const page = ordered.slice(0, st.shown);
  const groups = groupItems(page);
  $("lib-list").classList.toggle("grouped", !!groups);
  let libHtml;
  if (groups) {
    // для флажка группы и счётчика — все ссылки группы в разделе, а не только показанные
    const allGroups = groupItems(vis) || [];
    const full = new Map(allGroups.map((g) => [g.key, g.items]));
    // порядок групп — как у полного списка: «Показать ещё» не переставляет группы местами
    const rank = new Map(allGroups.map((g, i) => [g.key, i]));
    if (st.groupBy !== "batch") groups.sort((a, b) => (rank.get(a.key) ?? 1e9) - (rank.get(b.key) ?? 1e9));
    libHtml = groups
      .map((g) => {
        const closed = st.closedGroups.has(g.key);
        return `<section class="lgroup${closed ? " closed" : ""}" data-g="${esc(g.key)}">${groupHead(g, full)}${closed ? "" : `<div class="lg-cards">${g.items.map(card).join("")}</div>`}</section>`;
      })
      .join("");
  } else libHtml = page.map(card).join("");
  if (libHtml !== st.libHtml) {
    st.libHtml = libHtml;
    keepFocus($("lib-list"), () => ($("lib-list").innerHTML = libHtml));
  }
  $("lib-list").querySelectorAll('input[data-ind="1"]').forEach((i) => (i.indeterminate = true));
  fillShots($("lib-list"));
  $("group-label").textContent = GROUP_LABEL[st.groupBy];
  $("group-btn").setAttribute("aria-label", `Группы: ${GROUP_LABEL[st.groupBy]}`);
  const more = $("more-btn");
  more.hidden = vis.length <= st.shown;
  more.textContent = `Показать ещё ${Math.min(PAGE, vis.length - st.shown)}`;
  $("lib-empty").hidden = vis.length > 0;
  if (!vis.length && st.items.length) {
    $("lib-empty").querySelector(".empty-title").textContent = "Ничего не нашлось";
    $("lib-empty").querySelector(".empty-text").textContent = st.q ? "Попробуйте другие слова или другой раздел слева." : "В этом разделе пока нет ссылок.";
  } else {
    $("lib-empty").querySelector(".empty-title").textContent = "Список пуст";
    $("lib-empty").querySelector(".empty-text").textContent = "Соберите вкладки на вкладке «Открытые» — они появятся здесь.";
  }

  const visSel = vis.filter((it) => st.libSel.has(it.id)).length;
  const all = $("lib-all");
  all.checked = vis.length > 0 && visSel === vis.length;
  all.indeterminate = visSel > 0 && visSel < vis.length;
  all.disabled = !vis.length;
  const sel = st.libSel.size;
  $("lib-summary").innerHTML = sel ? `Выбрано <b>${sel}</b>` : `<span class="where-now">${esc(filterName())} · </span>${esc(nLinks(vis.length))}`;
  for (const id of ["open-btn", "folder-btn", "mark-btn", "delete-btn", "send-btn"]) $(id).disabled = !sel;
  $("folder-tools").hidden = st.filter.type !== "folder";

  const line = $("enrich-line");
  const failed = st.items.filter((it) => it.enrich === "failed" && !it.description).length;
  if (st.enrichLeft) {
    line.hidden = false;
    line.textContent = `Уточняю описания у сайтов: осталось ${st.enrichLeft}`;
  } else if (failed) {
    line.hidden = false;
    line.innerHTML = `${esc(nLinks(failed))} без описания — сайт не ответил. <a href="#" id="retry-enrich">Попробовать ещё раз</a>`;
  } else line.hidden = true;
}

function filterName() {
  const f = st.filter;
  if (f.type === "mark") return MARK_NAV[f.mark] || "Отметка";
  if (f.type === "unsent") return "Не отправлены";
  if (f.type === "sent") return "В Telegram";
  if (f.type === "folder") return (st.folders.find((x) => x.id === f.id) || {}).name || "Папка";
  if (f.type === "site") {
    const s = (st.siteList || []).find((x) => x.site === f.site);
    return (s ? s.label : f.site) + (f.kind ? ` · ${(KINDS[f.kind] || KINDS.page).label}` : "");
  }
  return "Все ссылки";
}

function selectedItems() {
  return st.items.filter((it) => st.libSel.has(it.id));
}

async function openItems(items) {
  if (items.length >= 20 && !(await confirmDlg(`Открыть ${nLinksAcc(items.length)}?`, "Откроются в новых вкладках справа; все, кроме первой, — усыплёнными, чтобы не грузить компьютер. Уже открытые не продублируются.", "Открыть"))) return;
  const r = await chrome.runtime.sendMessage({ type: "open", items: items.map((it) => ({ url: it.url, scrollY: it.scrollY || 0 })), lazy: true, windowId: st.myWindowId }).catch(() => null);
  if (r && items.length > 1 && r.switched) toast(`Открыто: ${r.n}. Уже были открыты: ${r.switched} — вторую копию не открывали`);
}

async function deleteItems(ids) {
  const removed = await removeItems(ids);
  ids.forEach((id) => st.libSel.delete(id));
  if (!removed.length) return; // повторный щелчок: прежнее «Вернуть» не затираем
  await reloadItems();
  renderLib();
  toast(`Убрано из списка: ${nLinksAcc(removed.length)}`, async () => {
    await restoreItems(removed);
    await reloadItems();
    renderLib();
  });
}

function closeMenu(refocus = false) {
  const menu = $("folder-menu");
  if (menu.hidden) return;
  menu.hidden = true;
  if (menuOpener) {
    menuOpener.setAttribute("aria-expanded", "false");
    if (refocus && menuOpener.isConnected) menuOpener.focus();
  }
}

let menuOpener = null;
function placeMenu(anchor) {
  const menu = $("folder-menu");
  menu.hidden = false;
  menuOpener = anchor;
  anchor.setAttribute("aria-expanded", "true");
  menu.querySelectorAll("button").forEach((b) => b.setAttribute("role", b.hasAttribute("aria-checked") ? "menuitemradio" : "menuitem"));
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  menu.style.left = `${Math.max(16, Math.min(r.left, innerWidth - w - 16))}px`;
  const below = r.bottom + 6;
  menu.style.top = below + menu.offsetHeight > innerHeight - 16 ? `${Math.max(16, r.top - menu.offsetHeight - 6)}px` : `${below}px`;
  menu.querySelector("button").focus();
}

let markTarget = [];
function showMarkMenu(anchor, ids) {
  const menu = $("folder-menu");
  if (!menu.hidden && menu.dataset.kind === "mark" && menuOpener === anchor) return closeMenu(true);
  menu.dataset.kind = "mark";
  markTarget = ids;
  const kinds = new Set(ids.map((id) => (st.items.find((it) => it.id === id) || {}).kind));
  const k = kinds.size === 1 ? [...kinds][0] : ""; // у всех один тип — «Смотрю/Читаю», иначе — общие подписи
  const cur = ids.length === 1 ? (st.items.find((it) => it.id === ids[0]) || {}).mark : "";
  menu.innerHTML =
    MARKS.map((m) => `<button type="button" data-mark="${m}" aria-checked="${cur === m}">${MARK_ICON[m]}<span class="m-label">${esc(k ? markLabel(m, k) : MARK_NAV[m])}</span><span class="m-count">${cur === m ? icon("check", 16) : ""}</span></button>`).join("") +
    `<hr /><button type="button" data-mark="">${icon("close", 18)}<span class="m-label">Без отметки</span></button>`;
  placeMenu(anchor);
}

function showFolderMenu(anchor) {
  const menu = $("folder-menu");
  menu.dataset.kind = "folders";
  menu.innerHTML =
    st.folders.map((f) => `<button type="button" data-folder="${esc(f.id)}">${icon("folder", 18)}<span class="m-label">${esc(f.name)}</span></button>`).join("") +
    (st.folders.length ? "<hr />" : "") +
    `<button type="button" data-folder="">${icon("close", 18)}<span>Убрать из папки</span></button>
     <button type="button" data-folder="new">${icon("folderPlus", 18)}<span>Новая папка…</span></button>`;
  placeMenu(anchor);
}

function bindLib() {
  $("side-nav").addEventListener("click", async (e) => {
    const mb = e.target.closest(".nav-marks-btn");
    if (mb) {
      e.stopPropagation();
      const menu = $("folder-menu");
      if (!menu.hidden && menu.dataset.kind === "mark-pick") return closeMenu(true);
      menu.dataset.kind = "mark-pick";
      menu.innerHTML = MARKS.map((m) => `<button type="button" data-mark-filter="${m}">${MARK_ICON[m]}<span class="m-label">${MARK_NAV[m]}</span><span class="m-count">${st.items.filter((it) => it.mark === m).length}</span></button>`).join("");
      placeMenu(mb);
      return;
    }
    const fb = e.target.closest(".nav-folders-btn");
    if (fb) {
      e.stopPropagation();
      const menu = $("folder-menu");
      if (!menu.hidden && menu.dataset.kind === "folder-pick") return closeMenu();
      menu.dataset.kind = "folder-pick";
      menu.innerHTML =
        st.folders
          .map((f) => `<button type="button" data-folder-pick="${esc(f.id)}">${icon("folder", 18)}<span class="m-label">${esc(f.name)}</span><span class="m-count">${st.items.filter((it) => it.folder === f.id).length}</span></button>`)
          .join("") +
        (st.folders.length ? "<hr />" : "") +
        `<button type="button" data-folder-pick="new">${icon("folderPlus", 18)}<span class="m-label">Новая папка…</span></button>`;
      placeMenu(fb);
      return;
    }
    const sb = e.target.closest(".nav-sites-btn");
    if (sb) {
      e.stopPropagation();
      const menu = $("folder-menu");
      if (!menu.hidden && menu.dataset.kind === "sites") return closeMenu();
      menu.dataset.kind = "sites";
      menu.innerHTML =
        `<button type="button" data-site-pick="">${icon("list", 18)}<span>Все сайты</span></button><hr />` +
        st.siteList
          .map((x) => `<button type="button" data-site-pick="${esc(x.site)}"><span class="fav">${favImg(x.sample.favicon, x.sample.url)}</span><span class="m-label">${esc(x.label)}</span><span class="m-count">${x.n}</span></button>`)
          .join("");
      placeMenu(sb);
      return;
    }
    if (e.target.closest("#folder-new")) {
      const name = await askName("Новая папка");
      if (name) {
        const f = await addFolder(name);
        await reloadItems();
        st.filter = { type: "folder", id: f.id };
        renderLib();
      }
      return;
    }
    const b = e.target.closest(".nav-item");
    if (!b) return;
    st.filter = JSON.parse(b.dataset.f);
    st.shown = PAGE;
    st.libSel.clear(); // действия — только над тем, что видно
    renderLib();
  });
  $("folder-rename").addEventListener("click", async () => {
    const folder = st.folders.find((x) => x.id === st.filter.id);
    if (!folder) return;
    const name = await askName("Переименовать папку", folder.name);
    if (name) {
      await renameFolder(folder.id, name);
      await reloadItems();
      renderLib();
    }
  });
  $("folder-delete").addEventListener("click", async () => {
    const folder = st.folders.find((x) => x.id === st.filter.id);
    if (!folder) return;
    if (await confirmDlg("Удалить папку?", `Папка «${folder.name}» исчезнет, ссылки из неё останутся в списке.`, "Удалить папку")) {
      await deleteFolder(folder.id);
      st.filter = { type: "all" };
      await reloadItems();
      renderLib();
    }
  });

  $("lib-list").addEventListener("click", async (e) => {
    const gh = e.target.closest(".lg-head");
    if (gh) {
      const key = gh.parentElement.dataset.g;
      if (e.target.closest(".lg-chk")) {
        e.preventDefault();
        const g = (groupItems(libVisible()) || []).find((x) => x.key === key);
        const list = g ? g.items : [...gh.parentElement.querySelectorAll(".card")].map((c) => st.items.find((it) => it.id === c.dataset.id)).filter(Boolean);
        if (!list.length) return;
        const allOn = list.every((it) => st.libSel.has(it.id));
        for (const it of list) allOn ? st.libSel.delete(it.id) : st.libSel.add(it.id);
      } else {
        st.closedGroups.has(key) ? st.closedGroups.delete(key) : st.closedGroups.add(key);
        saveClosed();
      }
      renderLib();
      return;
    }
    const c = e.target.closest(".card");
    if (!c) return;
    const id = c.dataset.id;
    const it = st.items.find((x) => x.id === id);
    if (!it) return; // карточку уже убрали (из другой страницы)
    if (e.target.closest("[data-open]")) {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return; // как обычная ссылка
      e.preventDefault();
      return openItems([it]);
    }
    const act = e.target.closest("[data-act]");
    if (act) {
      if (act.dataset.act === "open") return openItems([it]);
      if (act.dataset.act === "del") return deleteItems([id]);
      if (act.dataset.act === "mark") {
        e.stopPropagation();
        return showMarkMenu(act, [id]);
      }
    }
    if (e.target.closest(".chk") || e.target === c || e.target.closest(".c-body") && !e.target.closest("a")) {
      if (e.target.closest(".chk")) e.preventDefault();
      st.libSel.has(id) ? st.libSel.delete(id) : st.libSel.add(id);
      renderLib();
    }
  });
  $("lib-all").addEventListener("change", (e) => {
    const vis = libVisible();
    if (e.target.checked) vis.forEach((it) => st.libSel.add(it.id));
    else vis.forEach((it) => st.libSel.delete(it.id));
    renderLib();
  });
  $("more-btn").addEventListener("click", () => {
    st.shown += PAGE;
    renderLib();
  });
  $("open-btn").addEventListener("click", () => openItems(selectedItems()));
  $("delete-btn").addEventListener("click", () => deleteItems([...st.libSel]));
  $("group-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = $("folder-menu");
    if (!menu.hidden && menu.dataset.kind === "group") return closeMenu(true);
    menu.dataset.kind = "group";
    const opt = (v, ic, text) =>
      `<button type="button" data-group-pick="${v}" aria-checked="${st.groupBy === v}">${icon(ic, 18)}<span class="m-label">${text}</span><span class="m-count">${st.groupBy === v ? icon("check", 16) : ""}</span></button>`;
    menu.innerHTML = opt("site", "globe", "По сайтам") + opt("batch", "clock", "По сборам — что собрано за раз") + opt("none", "list", "Без групп");
    placeMenu(e.currentTarget);
  });
  $("mark-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    showMarkMenu(e.currentTarget, [...st.libSel]);
  });
  $("folder-btn").setAttribute("aria-expanded", "false");
  $("folder-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const menu = $("folder-menu");
    menu.hidden || menu.dataset.kind !== "folders" ? showFolderMenu(e.currentTarget) : closeMenu();
  });
  // меню с клавиатуры: стрелки вверх/вниз, Esc — закрыть и вернуться к кнопке
  $("folder-menu").addEventListener("keydown", (e) => {
    const btns = [...$("folder-menu").querySelectorAll("button")];
    const i = btns.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = i < 0 ? (e.key === "ArrowDown" ? 0 : btns.length - 1) : (i + (e.key === "ArrowDown" ? 1 : -1) + btns.length) % btns.length;
      btns[next].focus();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(true);
    } else if (e.key === "Tab") {
      closeMenu(true); // меню закрывается, фокус — на его кнопку, дальше Tab идёт от неё
    }
  });
  $("folder-menu").addEventListener("click", async (e) => {
    const fp = e.target.closest("[data-folder-pick]");
    if (fp) {
      closeMenu(true);
      let id = fp.dataset.folderPick;
      if (id === "new") {
        const name = await askName("Новая папка");
        if (!name) return;
        id = (await addFolder(name)).id;
        await reloadItems();
      }
      st.filter = { type: "folder", id };
      st.shown = PAGE;
      st.libSel.clear();
      renderLib();
      return;
    }
    const mk = e.target.closest("[data-mark]");
    if (mk) {
      closeMenu(true);
      const mark = mk.dataset.mark || null;
      const ids = markTarget.slice();
      await patchItems(ids, { mark });
      await reloadItems();
      renderLib();
      if (ids.length > 1) toast(mark ? `Отмечено «${MARK_NAV[mark]}»: ${nLinksAcc(ids.length)}` : `Отметка снята: ${nLinksAcc(ids.length)}`);
      return;
    }
    const mf = e.target.closest("[data-mark-filter]");
    if (mf) {
      closeMenu(true);
      st.filter = { type: "mark", mark: mf.dataset.markFilter };
      st.shown = PAGE;
      st.libSel.clear();
      renderLib();
      return;
    }
    const gp = e.target.closest("[data-group-pick]");
    if (gp) {
      closeMenu(true);
      st.groupBy = gp.dataset.groupPick;
      st.libHtml = "";
      renderLib();
      await saveSettings({ groupBy: st.groupBy });
      return;
    }
    const pick = e.target.closest("[data-site-pick]");
    if (pick) {
      closeMenu(true);
      st.filter = pick.dataset.sitePick ? { type: "site", site: pick.dataset.sitePick } : { type: "all" };
      st.shown = PAGE;
      st.libSel.clear();
      renderLib();
      return;
    }
    const b = e.target.closest("[data-folder]");
    if (!b) return;
    closeMenu(true);
    let fid = b.dataset.folder || null;
    if (fid === "new") {
      const name = await askName("Новая папка");
      if (!name) return;
      fid = (await addFolder(name)).id;
    }
    const ids = [...st.libSel];
    await patchItems(ids, { folder: fid });
    await reloadItems();
    renderLib();
    const f = st.folders.find((x) => x.id === fid);
    toast(f ? `В папку «${f.name}»: ${nLinksAcc(ids.length)}` : `Убрано из папки: ${nLinksAcc(ids.length)}`);
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#folder-menu")) closeMenu();
  });
  $("send-btn").addEventListener("click", () =>
    openSend(selectedItems(), async () => {
      await reloadItems();
      renderLib();
    })
  );
  $("enrich-line").addEventListener("click", (e) => {
    if (e.target.id === "retry-enrich") {
      e.preventDefault();
      retryFailed(st.items.filter((it) => it.enrich === "failed" && !it.description).map((it) => it.id)).catch(() => {});
    }
  });
}

// ---------------------------------------------------------------- общее

// подсказка в поиске — под ширину поля, без обрезания на полуслове
function placeholder() {
  const q = $("q");
  const w = q.clientWidth;
  const full = st.view === "open" ? "Поиск по открытым вкладкам" : "Поиск по названию, сайту, описанию";
  const mid = st.view === "open" ? "Поиск по вкладкам" : "Поиск по ссылкам";
  q.placeholder = w > full.length * 9.5 ? full : w > mid.length * 9.5 ? mid : "Поиск";
}

function render() {
  for (const v of ["open", "library"]) {
    $(`view-${v}`).hidden = st.view !== v;
    document.querySelector(`[data-view="${v}"]`).setAttribute("aria-selected", String(st.view === v));
  }
  placeholder();
  renderOpen();
  renderLib();
}

let tabsTimer = null;
let shotsTimer = null;
let shotsSince = 0;
function onTabsChanged() {
  clearTimeout(tabsTimer);
  tabsTimer = setTimeout(async () => {
    await reloadTabs();
    renderOpen();
    if (st.view === "library") renderLib(); // «● открыта» у собранных (скрытый раздел нарисуется при переходе)
  }, 250);
  // фон снимает страницу ~через секунду после перехода — тогда и обновим миниатюры (и в панели)
  // откладываем, но не дольше ~6 с: вкладка с мигающим заголовком не должна мешать обновлению снимков
  if (shotsTimer && Date.now() - shotsSince > 6000) return;
  clearTimeout(shotsTimer);
  if (!shotsTimer) shotsSince = Date.now();
  shotsTimer = setTimeout(async () => {
    shotsTimer = null;
    if (await refreshShots()) {
      st.openHtml = st.libHtml = "";
      renderOpen();
      renderLib();
    }
  }, 2500);
}

// заголовок, иконка, звук, загрузка — важно; остальное (миллион событий при загрузке) — нет
const TAB_KEYS = ["url", "title", "favIconUrl", "discarded", "audible", "pinned", "status"];
function onTabUpdated(id, change) {
  if (TAB_KEYS.some((k) => k in change) && (!("status" in change) || change.status === "complete" || Object.keys(change).length > 1)) onTabsChanged();
}

let itemsTimer = null;
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local" || !(ch.folders || Object.keys(ch).some(isItemKey))) return;
  clearTimeout(itemsTimer);
  itemsTimer = setTimeout(async () => {
    await reloadItems();
    renderLib();
    // ссылки, добавленные меню значка или из копии, тоже уточняем
    if (st.items.some((it) => it.enrich === "pending")) runEnrich();
  }, 150);
});

// значок нажали с другой вкладки, когда сборщик уже открыт: «текущая» — новая
chrome.storage.session.onChanged.addListener(async (ch) => {
  if (!ch.fromTab) return;
  st.fromTab = ch.fromTab.newValue ?? null;
  if (st.fromTab != null) st.openSel.delete(st.fromTab);
  renderOpen();
});

async function init() {
  hydrateIcons();
  new ResizeObserver(() => document.documentElement.style.setProperty("--top-h", `${document.querySelector(".top").offsetHeight}px`)).observe(
    document.querySelector(".top")
  );
  try {
    st.fromTab = (await chrome.storage.session.get("fromTab")).fromTab ?? null;
  } catch (e) {
    /* нет — не страшно */
  }
  await migrateKeys().catch(() => {}); // раз за версию правил; обычно — одно чтение настроек
  await reloadItems();
  applyTheme(st.settings.theme || "auto");
  applyScale(scaleOf(st.settings));
  await reloadTabs();
  await refreshShots();

  document.querySelectorAll("[data-view]").forEach((b) =>
    b.addEventListener("click", () => {
      st.view = b.dataset.view;
      history.replaceState(null, "", st.view === "library" ? "#library" : "#");
      render();
    })
  );
  window.addEventListener("hashchange", () => {
    st.view = location.hash === "#library" ? "library" : "open";
    render();
  });
  const q = $("q");
  q.addEventListener("input", () => {
    st.q = q.value.trim();
    st.shown = PAGE;
    st.libSel.clear();
    st.openSel.clear(); // «Собрать» — только то, что видно
    renderOpen();
    renderLib();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "/" && !/INPUT|TEXTAREA/.test(document.activeElement.tagName) && !document.querySelector("dialog[open]")) {
      e.preventDefault();
      q.focus();
    } else if (e.key === "Escape") {
      closeMenu();
      if (document.activeElement === q && q.value) {
        q.value = "";
        q.dispatchEvent(new Event("input"));
      }
    }
  });
  // панель ↔ вкладка
  $("to-tab").addEventListener("click", async () => {
    const r = await chrome.runtime.sendMessage({ type: "open-app", view: st.view, windowId: st.myWindowId }).catch(() => null);
    if (r && r.ok) window.close(); // боковую панель закрываем — сборщик теперь во вкладке
    else toast("Не получилось открыть вкладку сборщика");
  });
  $("to-panel").addEventListener("click", async () => {
    // открыть панель можно только в ответ на щелчок — делаем это сразу, без ожиданий
    chrome.sidePanel.open({ windowId: st.myWindowId }).then(
      // вкладку сборщика закрываем через API: window.close() во вкладке с историей не сработает
      () => setTimeout(() => (st.myTabId != null ? chrome.tabs.remove(st.myTabId) : window.close()), 300),
      () => toast("Не получилось открыть боковую панель")
    );
  });
  $("settings-btn").addEventListener("click", () =>
    openSettings(async () => {
      await reloadItems();
      renderLib();
    })
  );

  bindOpen();
  bindLib();
  st.layout = { open: st.settings.layoutOpen || "tiles", lib: st.settings.layoutLib || "tiles" };
  st.groupBy = GROUP_LABEL[st.settings.groupBy] ? st.settings.groupBy : "site";
  applyLayout();
  document.querySelectorAll("[data-layout]").forEach((b) =>
    b.addEventListener("click", async () => {
      st.layout[b.dataset.for] = b.dataset.layout;
      applyLayout();
      render();
      await saveSettings({ [b.dataset.for === "open" ? "layoutOpen" : "layoutLib"]: b.dataset.layout });
    })
  );
  // иконка сайта не загрузилась — значок «глобус» вместо пустого квадрата
  document.addEventListener(
    "error",
    (e) => {
      const img = e.target;
      if (img.tagName === "IMG" && (img.classList.contains("fav-img") || img.classList.contains("favimg"))) img.replaceWith(document.createRange().createContextualFragment(icon("globe", 18)));
    },
    true
  );
  bindPeek($("lib-list"), ".card", (c) => {
    const it = st.items.find((x) => x.id === c.dataset.id);
    if (!it) return null;
    const folder = it.folder && st.folders.find((f) => f.id === it.folder);
    return {
      ...it,
      site: siteLabel(it),
      shotKey: st.shotKeys.has(it.nkey) ? it.nkey : "",
      foot: [esc(dateText(it.addedAt)), folder ? esc(`папка «${folder.name}»`) : "", it.sentAt ? `<span class="c-sent">✓ в Telegram${it.sentCategory ? ` · ${esc(it.sentCategory)}` : ""}</span>` : ""]
        .filter(Boolean)
        .join(" · "),
    };
  });
  bindPeek($("open-list"), ".row", (row) => {
    const t = st.tabs.find((x) => x.id === Number(row.dataset.tab));
    if (!t) return null;
    const r = recognize(t.url);
    const key = normalizeUrl(t.url);
    const saved = st.items.find((it) => it.nkey === key); // уже собиралась — у неё есть описание
    return {
      title: (saved && saved.title) || t.title,
      url: t.url,
      kind: saved ? saved.kind : r.kind,
      kindLabel: saved ? saved.kindLabel : r.kind !== "page" ? r.kindLabel : "",
      icon: saved ? saved.icon : r.icon,
      site: r.site,
      meta: saved ? saved.meta : "",
      description: saved ? saved.description : "",
      image: saved ? saved.image : "",
      shotKey: st.shotKeys.has(key) ? key : "",
      foot: [t.discarded ? "усыплена" : "", saved ? "уже есть в «Собранных»" : "", "двойной щелчок — перейти"].filter(Boolean).join(" · "),
    };
  });
  // вернулись на страницу сборщика — могли появиться новые снимки
  document.addEventListener("visibilitychange", async () => {
    if (document.hidden) return;
    if (await refreshShots()) {
      st.openHtml = st.libHtml = "";
      renderOpen();
      renderLib();
    }
    // вернулись на страницу — продолжить уточнение описаний, если его бросили в фоне
    if (st.items.some((it) => it.enrich === "pending")) runEnrich();
  });
  window.addEventListener("resize", placeholder);

  for (const ev of ["onCreated", "onRemoved", "onMoved", "onAttached", "onDetached", "onReplaced", "onActivated"]) chrome.tabs[ev].addListener(onTabsChanged);
  chrome.tabs.onUpdated.addListener(onTabUpdated);
  onEnrichState((left) => {
    st.enrichLeft = left;
    const line = $("enrich-line");
    if (left && !line.hidden) line.textContent = `Уточняю описания у сайтов: осталось ${left}`;
    else renderLib();
  });
  render();
  // уборка недостёртых записей — после отрисовки, чтобы панель открывалась сразу
  setTimeout(() => cleanOrphans().catch(() => {}), 1500);
  runEnrich();
  setInterval(() => {
    if (!document.hidden && st.items.some((it) => it.enrich === "pending")) runEnrich();
  }, 30000);
}

init();
