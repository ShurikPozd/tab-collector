// Страница сборщика: «Открытые» (выбор вкладок по сайтам → собрать/усыпить)
// и «Собранные» (список с папками, поиском, открытием и отправкой в Telegram).

import { hydrateIcons, icon } from "./icons.js";
import { load, removeItems, restoreItems, patchItems, addFolder, renameFolder, deleteFolder, saveSettings } from "../core/store.js";
import { collectTabs, sleepTabs, untouchable } from "../core/collect.js";
import { recognize, siteOf, siteLabel, normalizeUrl, KINDS } from "../core/url.js";
import { hasShots } from "../core/shots.js";
import { bindPeek, shotUrl, forgetShots } from "./peek.js";
import { runEnrich, onEnrichState, retryFailed } from "./enricher.js";
import { openSend } from "./send.js";
import { openSettings, applyTheme } from "./settings.js";
import { askName, confirmDlg, esc } from "./ui.js";

const EXT = chrome.runtime.getURL("");
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
};

async function refreshShots() {
  const keys = new Set(st.items.map((it) => it.nkey));
  for (const t of st.tabs) keys.add(normalizeUrl(t.url));
  try {
    st.shotKeys = new Set(await hasShots([...keys]));
  } catch (e) {
    st.shotKeys = new Set();
  }
}

/** Подставить снимки страниц в миниатюры (после отрисовки). */
function fillShots(root) {
  root.querySelectorAll("img[data-shot]").forEach(async (img) => {
    const u = await shotUrl(img.dataset.shot);
    if (u) img.src = u;
    else img.closest(".thumb")?.classList.add("no-shot");
  });
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

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
const nTabs = (n) => `${n} ${plural(n, "вкладка", "вкладки", "вкладок")}`;
const nTabsAcc = (n) => `${n} ${plural(n, "вкладку", "вкладки", "вкладок")}`;
const nLinks = (n) => `${n} ${plural(n, "ссылка", "ссылки", "ссылок")}`;
const nLinksAcc = (n) => `${n} ${plural(n, "ссылку", "ссылки", "ссылок")}`;
const nSites = (n) => `${n} ${plural(n, "сайте", "сайтах", "сайтах")}`;

function favImg(url, site) {
  if (url) return `<img src="${esc(url)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`;
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
}

async function reloadTabs() {
  const me = await chrome.tabs.getCurrent();
  st.myTabId = me && me.id;
  const q = st.scope === "window" && me ? { windowId: me.windowId } : {};
  st.tabs = await chrome.tabs.query(q);
  const live = new Set(st.tabs.map((t) => t.id));
  for (const id of st.openSel) if (!live.has(id)) st.openSel.delete(id);
}

// ---------------------------------------------------------------- «Открытые»

function tabState(t) {
  if (t.id === st.myTabId) return "self";
  const u = untouchable(t, EXT);
  if (u) return u;
  if (t.id === st.fromTab) return "current";
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

  list.innerHTML = groups
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
              return `<label class="row${s ? " off" : ""}" data-tab="${t.id}">
                <span class="chk"><input type="checkbox" ${st.openSel.has(t.id) ? "checked" : ""} ${s ? "disabled" : ""} /><span class="box"></span></span>
                <span class="fav">${favImg(t.favIconUrl)}</span>
                <span class="r-text"><span class="r-title">${hl(t.title || t.url, st.q)}</span><span class="r-url">${hl(path, st.q)}</span></span>
                <span class="tags">${tags}</span>
              </label>`;
            })
            .join("")
        : "";
      return `<section class="group${isOpen ? " open" : ""}" data-site="${esc(site)}">
        <div class="g-head" role="button" aria-expanded="${isOpen}">
          <span class="chk g-chk"><input type="checkbox" ${pick.length && nSel === pick.length ? "checked" : ""} ${pick.length ? "" : "disabled"} data-ind="${nSel > 0 && nSel < pick.length ? 1 : 0}" aria-label="Выбрать все вкладки ${esc(site)}" /><span class="box"></span></span>
          <span class="fav">${favImg((tabs.find((t) => t.favIconUrl) || {}).favIconUrl)}</span>
          <span class="g-name"><span class="g-title">${esc(site || "без адреса")}</span>${kindsText ? `<span class="g-kinds">${esc(kindsText)}</span>` : ""}</span>
          <span class="g-count">${nSel ? `${nSel} из ${pick.length}` : tabs.length}</span>
          <span class="chev">${icon("chevron", 20)}</span>
        </div>
        <div class="g-rows">${rows}</div>
      </section>`;
    })
    .join("");
  list.querySelectorAll('input[data-ind="1"]').forEach((i) => (i.indeterminate = true));

  const sel = st.openSel.size;
  const all = $("open-all");
  all.checked = total > 0 && sel >= total;
  all.indeterminate = sel > 0 && sel < total;
  all.disabled = total === 0;
  $("open-summary").innerHTML = sel
    ? `Выбрано <b>${sel}</b> из ${total}`
    : `${esc(nTabs(total))} на ${esc(nSites(groups.length))}`;
  $("collect-btn").disabled = !sel || !!st.collecting;
  $("sleep-btn").disabled = !sel || !!st.collecting;
}

function visibleSelectable() {
  return openGroups().flatMap(([, ts]) => ts.filter(selectable));
}

function bindOpen() {
  $("open-list").addEventListener("click", (e) => {
    const head = e.target.closest(".g-head");
    if (head) {
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
    const row = e.target.closest(".row");
    if (row && !row.classList.contains("off")) {
      e.preventDefault();
      const id = Number(row.dataset.tab);
      st.openSel.has(id) ? st.openSel.delete(id) : st.openSel.add(id);
      renderOpen();
    }
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
      res = await collectTabs(tabs, { onProgress: (d, n) => progress(d / n) });
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
    const extra = res.merged ? ` (${res.merged} уже были в списке)` : "";
    toast(`Собрано: ${nTabs(tabs.length)}${extra}`, async () => {
      // «Вернуть»: открыть вкладки обратно (усыплёнными) и убрать только что добавленные записи
      await chrome.runtime.sendMessage({ type: "open", items: tabs.map((t) => ({ url: t.url })), lazy: true, background: true });
      await removeItems(res.ids);
      await reloadItems();
      await reloadTabs();
      render();
    });
    runEnrich();
  });

  $("sleep-btn").addEventListener("click", async () => {
    const tabs = st.tabs.filter((t) => st.openSel.has(t.id) && selectable(t));
    const n = await sleepTabs(tabs);
    st.openSel.clear();
    await reloadTabs();
    renderOpen();
    const skipped = tabs.length - n;
    toast(`Усыплено: ${nTabs(n)}${skipped ? `. ${skipped} — уже спали или активные в своих окнах` : ""}`);
  });
}

// ---------------------------------------------------------------- «Собранные»

function inFilter(it, f = st.filter) {
  if (f.type === "unsent") return !it.sentAt;
  if (f.type === "sent") return !!it.sentAt;
  if (f.type === "folder") return it.folder === f.id;
  if (f.type === "site") return it.site === f.site && (!f.kind || it.kind === f.kind);
  return true;
}

function libVisible() {
  return st.items.filter((it) => inFilter(it) && matches(st.q, it.title, it.description, it.meta, it.url, it.siteName, it.kindLabel));
}

function navItem(f, label, count, lead = "", sub = false) {
  const cur =
    st.filter.type === f.type &&
    (f.type !== "folder" || st.filter.id === f.id) &&
    (f.type !== "site" || (st.filter.site === f.site && (st.filter.kind || "") === (f.kind || "")));
  return `<button type="button" class="nav-item${sub ? " sub" : ""}" aria-current="${cur}" data-f='${esc(JSON.stringify(f))}'>
    ${lead || "<span></span>"}<span class="n-label">${esc(label)}</span><span class="n-count">${count}</span></button>`;
}

function renderSide() {
  const items = st.items;
  const sent = items.filter((it) => it.sentAt).length;
  let h = "";
  h += navItem({ type: "all" }, "Все ссылки", items.length, `<span class="nav-emoji">${icon("list", 18)}</span>`);
  h += navItem({ type: "unsent" }, "Не отправлены", items.length - sent, `<span class="nav-emoji">${icon("inbox", 18)}</span>`);
  h += navItem({ type: "sent" }, "В Telegram", sent, `<span class="nav-emoji">${icon("send", 18)}</span>`);

  h += `<div class="side-h"><span>Папки</span><button type="button" class="icon-btn" id="folder-new" title="Новая папка" aria-label="Новая папка">${icon("plus", 18)}</button></div>`;
  if (!st.folders.length) h += `<p class="side-empty">Пока нет. Выберите ссылки и нажмите «В папку».</p>`;
  for (const f of st.folders) {
    h += navItem({ type: "folder", id: f.id }, f.name, items.filter((it) => it.folder === f.id).length, `<span class="nav-emoji">${icon("folder", 18)}</span>`);
  }

  const sites = new Map();
  for (const it of items) {
    if (!sites.has(it.site)) sites.set(it.site, { n: 0, kinds: new Map(), sample: it });
    const s = sites.get(it.site);
    s.n++;
    s.kinds.set(it.kind, (s.kinds.get(it.kind) || 0) + 1);
    if (!s.sample.favicon && it.favicon) s.sample = it;
  }
  if (sites.size) h += `<div class="side-h"><span>Сайты</span></div>`;
  for (const [site, s] of [...sites.entries()].sort((a, b) => b[1].n - a[1].n)) {
    const lead = `<span class="fav">${favImg(s.sample.favicon || siteFav(s.sample.url))}</span>`;
    h += navItem({ type: "site", site }, siteLabel(s.sample) || site, s.n, lead);
    if (st.filter.type === "site" && st.filter.site === site && s.kinds.size > 1) {
      for (const [kind, n] of [...s.kinds.entries()].sort((a, b) => b[1] - a[1])) {
        const k = KINDS[kind] || KINDS.page;
        h += navItem({ type: "site", site, kind }, k.label, n, `<span class="nav-emoji">${k.icon}</span>`, true);
      }
    }
  }
  $("side-nav").innerHTML = h;
}

function card(it) {
  const folder = it.folder && st.folders.find((f) => f.id === it.folder);
  const thumb = it.image
    ? `<span class="thumb${["anime", "manga", "ranobe", "character", "person"].includes(it.kind) ? " poster" : ""}"><img class="cover" src="${esc(it.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" /></span>`
    : st.shotKeys.has(it.nkey)
      ? `<span class="thumb shot"><img class="cover" data-shot="${esc(it.nkey)}" alt="" /></span>`
      : `<span class="thumb"><img class="favimg" src="${esc(it.favicon || siteFav(it.url))}" alt="" loading="lazy" /></span>`;
  const foot = [
    `<span>${esc(dateText(it.addedAt))}</span>`,
    folder ? `<span>${icon("folder", 14).replace("<svg", '<svg style="display:inline;vertical-align:-2px;margin-right:4px"')}${esc(folder.name)}</span>` : "",
    it.sentAt ? `<span class="c-sent">✓ в Telegram${it.sentCategory ? ` · ${esc(it.sentCategory)}` : ""}</span>` : "",
    it.enrich === "pending" ? `<span class="c-pending">уточняю описание…</span>` : "",
  ].join("");
  return `<article class="card${st.libSel.has(it.id) ? " sel" : ""}" data-id="${esc(it.id)}">
    <label class="chk"><input type="checkbox" ${st.libSel.has(it.id) ? "checked" : ""} aria-label="Выбрать" /><span class="box"></span></label>
    ${thumb}
    <div class="c-body">
      <div class="c-kicker"><span class="tag kind">${esc(it.icon)} ${esc(it.kindLabel)}</span><span>${esc(siteLabel(it))}</span></div>
      <a class="c-title" href="${esc(it.url)}" data-open>${hl(it.title || it.url, st.q)}</a>
      ${it.meta ? `<div class="c-meta">${hl(it.meta, st.q)}</div>` : ""}
      ${it.description ? `<div class="c-desc">${hl(it.description, st.q)}</div>` : ""}
      <div class="c-foot">${foot}</div>
    </div>
    <div class="c-actions">
      <button type="button" class="icon-btn" data-act="open" title="Открыть" aria-label="Открыть">${icon("external", 18)}</button>
      <button type="button" class="icon-btn" data-act="del" title="Убрать из списка" aria-label="Убрать из списка">${icon("trash", 18)}</button>
    </div>
  </article>`;
}

function renderLib() {
  renderSide();
  const vis = libVisible();
  $("lib-count").textContent = String(st.items.length || "");
  $("lib-list").innerHTML = vis.slice(0, st.shown).map(card).join("");
  fillShots($("lib-list"));
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
  $("lib-summary").innerHTML = sel ? `Выбрано <b>${sel}</b>` : esc(nLinks(vis.length));
  for (const id of ["open-btn", "folder-btn", "delete-btn", "send-btn"]) $(id).disabled = !sel;
  $("folder-tools").hidden = st.filter.type !== "folder";

  const line = $("enrich-line");
  const failed = st.items.filter((it) => it.enrich === "failed").length;
  if (st.enrichLeft) {
    line.hidden = false;
    line.textContent = `Уточняю описания у сайтов: осталось ${st.enrichLeft}`;
  } else if (failed) {
    line.hidden = false;
    line.innerHTML = `${esc(nLinks(failed))} без описания — сайт не ответил. <a href="#" id="retry-enrich">Попробовать ещё раз</a>`;
  } else line.hidden = true;
}

function selectedItems() {
  return st.items.filter((it) => st.libSel.has(it.id));
}

async function openItems(items) {
  if (items.length >= 20 && !(await confirmDlg(`Открыть ${nLinksAcc(items.length)}?`, "Откроются в новых вкладках справа; все, кроме первой, — усыплёнными, чтобы не грузить компьютер.", "Открыть"))) return;
  await chrome.runtime.sendMessage({ type: "open", items: items.map((it) => ({ url: it.url, scrollY: it.scrollY || 0 })), lazy: true });
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

function closeMenu() {
  $("folder-menu").hidden = true;
}

function showFolderMenu(anchor) {
  const menu = $("folder-menu");
  menu.innerHTML =
    st.folders.map((f) => `<button type="button" data-folder="${esc(f.id)}">${icon("folder", 18)}<span>${esc(f.name)}</span></button>`).join("") +
    (st.folders.length ? "<hr />" : "") +
    `<button type="button" data-folder="">${icon("close", 18)}<span>Убрать из папки</span></button>
     <button type="button" data-folder="new">${icon("folderPlus", 18)}<span>Новая папка…</span></button>`;
  menu.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  menu.style.left = `${Math.max(16, Math.min(r.left, innerWidth - w - 16))}px`;
  const below = r.bottom + 6;
  menu.style.top = below + menu.offsetHeight > innerHeight - 16 ? `${Math.max(16, r.top - menu.offsetHeight - 6)}px` : `${below}px`;
  menu.querySelector("button").focus();
}

function bindLib() {
  $("side-nav").addEventListener("click", async (e) => {
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
    const c = e.target.closest(".card");
    if (!c) return;
    const id = c.dataset.id;
    const it = st.items.find((x) => x.id === id);
    if (e.target.closest("[data-open]")) {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1) return; // как обычная ссылка
      e.preventDefault();
      return openItems([it]);
    }
    const act = e.target.closest("[data-act]");
    if (act) {
      if (act.dataset.act === "open") return openItems([it]);
      if (act.dataset.act === "del") return deleteItems([id]);
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
  $("folder-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    $("folder-menu").hidden ? showFolderMenu(e.currentTarget) : closeMenu();
  });
  $("folder-menu").addEventListener("click", async (e) => {
    const b = e.target.closest("[data-folder]");
    if (!b) return;
    closeMenu();
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
      retryFailed();
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
function onTabsChanged() {
  clearTimeout(tabsTimer);
  tabsTimer = setTimeout(async () => {
    await reloadTabs();
    renderOpen();
  }, 250);
}

let itemsTimer = null;
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local" || !(ch.items || ch.folders)) return;
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
  await reloadItems();
  applyTheme(st.settings.theme || "auto");
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
  $("settings-btn").addEventListener("click", () =>
    openSettings(async () => {
      await reloadItems();
      renderLib();
    })
  );

  bindOpen();
  bindLib();
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
    return {
      title: t.title,
      url: t.url,
      kind: r.kind,
      kindLabel: r.kind !== "page" ? r.kindLabel : "",
      icon: r.icon,
      site: r.site,
      shotKey: st.shotKeys.has(key) ? key : "",
      description: st.shotKeys.has(key) ? "" : "Снимка этой вкладки пока нет: он появится, когда вы на неё перейдёте.",
      foot: t.discarded ? "усыплена" : "",
    };
  });
  // вернулись на страницу сборщика — могли появиться новые снимки
  document.addEventListener("visibilitychange", async () => {
    if (document.hidden) return;
    forgetShots();
    await refreshShots();
    renderLib();
  });
  window.addEventListener("resize", placeholder);
  // лента разделов на узком экране листается колесом мыши
  document.querySelector(".side").addEventListener(
    "wheel",
    (e) => {
      const el = e.currentTarget;
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
    },
    { passive: false }
  );
  for (const ev of ["onCreated", "onRemoved", "onUpdated", "onMoved", "onAttached", "onDetached", "onReplaced"]) chrome.tabs[ev].addListener(onTabsChanged);
  onEnrichState((left) => {
    st.enrichLeft = left;
    const line = $("enrich-line");
    if (left && !line.hidden) line.textContent = `Уточняю описания у сайтов: осталось ${left}`;
    else renderLib();
  });
  render();
  runEnrich();
}

init();
