// Хранилище списка: chrome.storage.local (unlimitedStorage).
//   it:<id> — каждая собранная ссылка отдельно (см. makeItem): изменение одной ссылки
//             не перезаписывает весь список (важно при тысячах ссылок)
//   order   — порядок ссылок [id, …] (новые — сверху)
//   folders — свои папки [{id, name}]
//   settings — адрес бота, секрет, тема, масштаб
// Все записи — через update(): прочитать → изменить → записать только изменившееся.
// Старый формат (весь список одним ключом items) переносится при первой записи.

import { normalizeUrl, recognize, kindFromOgType, kindMeta } from "./url.js";

const area = () => chrome.storage.local;

export function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Новая запись из вкладки (tab) и того, что успели прочитать со страницы (grab). */
export function makeItem(tab, grab = {}, now = Date.now()) {
  let r = recognize(tab.url);
  // сайт без своего распознавания: тип — по og:type страницы (статья, видео, товар…)
  if (r.kind === "page" && grab.ogType) r = { ...r, ...kindMeta(kindFromOgType(grab.ogType)) };
  const desc = (grab.description || "").trim();
  const known = r.provider && r.provider !== "page";
  const search = r.kind === "search" && r.ref;
  return {
    id: uid(),
    url: tab.url,
    nkey: normalizeUrl(tab.url),
    title: search ? `«${search.q}»` : (grab.title || tab.title || tab.url).trim(),
    favicon: tab.favIconUrl && /^https?:|^data:image\//.test(tab.favIconUrl) ? tab.favIconUrl : "",
    site: r.site,
    siteName: grab.siteName || "",
    provider: r.provider,
    ref: r.ref,
    kind: r.kind,
    icon: r.icon,
    kindLabel: r.kindLabel,
    kindLocked: r.kind !== "page",
    meta: search ? `Поиск в ${search.engine}` : "",
    description: desc.slice(0, 600),
    image: grab.image && /^https:\/\//.test(grab.image) ? grab.image : "",
    scrollY: Math.max(0, Math.round(grab.scrollY || 0)),
    folder: null,
    addedAt: now,
    sentAt: null,
    sentCategory: "",
    // известные сайты — уточняем через API; остальные — если страница не отдала описания
    enrich: (known || !desc) && !search && /^https?:/.test(tab.url) ? "pending" : "done",
  };
}

const IT = "it:";
export const isItemKey = (k) => k === "order" || k.startsWith(IT) || k === "items";

async function readAll() {
  const all = await area().get(null);
  const byId = new Map();
  for (const [k, v] of Object.entries(all)) if (k.startsWith(IT) && v && v.id) byId.set(v.id, v);
  let items;
  if (Array.isArray(all.order)) {
    items = all.order.map((id) => byId.get(id)).filter(Boolean);
    // записи без места в порядке (сбой посреди записи) не теряем — в конец
    if (items.length < byId.size) {
      const seen = new Set(all.order);
      for (const [id, it] of byId) if (!seen.has(id)) items.push(it);
    }
  } else items = Array.isArray(all.items) ? all.items : []; // старый формат
  return { all, d: { items, folders: all.folders || [], settings: all.settings || {} } };
}

export async function load() {
  return (await readAll()).d;
}

/** Только настройки — без чтения всего списка. */
export async function loadSettings() {
  return (await area().get("settings")).settings || {};
}

/**
 * Изменения по одному: прочитать → изменить → записать. Замок navigator.locks общий для
 * фона и всех страниц расширения — иначе страница (уточнение описаний) и фон (сбор из меню
 * значка) затирали бы записи друг друга. Пишутся только изменившиеся ссылки.
 */
export function update(fn) {
  return navigator.locks.request("tc-store", async () => {
    const { all, d } = await readAll();
    const legacy = !Array.isArray(all.order);
    const before = new Map(d.items.map((it) => [it.id, JSON.stringify(it)]));
    const foldersBefore = JSON.stringify(d.folders);
    const settingsBefore = JSON.stringify(d.settings);
    const res = await fn(d);

    const set = {};
    const ids = [];
    for (const it of d.items) {
      ids.push(it.id);
      const j = JSON.stringify(it);
      if (legacy || before.get(it.id) !== j) set[IT + it.id] = it;
    }
    const keep = new Set(ids);
    const drop = [...before.keys()].filter((id) => !keep.has(id)).map((id) => IT + id);
    if (legacy || ids.length !== before.size || ids.some((id, i) => id !== (all.order || [])[i])) set.order = ids;
    if (JSON.stringify(d.folders) !== foldersBefore || legacy) set.folders = d.folders;
    if (JSON.stringify(d.settings) !== settingsBefore) set.settings = d.settings;
    if (Object.keys(set).length) await area().set(set);
    // старый ключ и удалённые ссылки убираем только после того, как новое записалось
    if (legacy && "items" in all) drop.push("items");
    if (drop.length) await area().remove(drop.filter((k) => k !== IT + "undefined"));
    return res;
  });
}

/** Добавить записи, склеивая дубли по nkey. Возвращает {added, merged}. */
export function addItems(newItems) {
  return update((d) => {
    const byKey = new Map(d.items.map((it) => [it.nkey, it]));
    let added = 0;
    let merged = 0;
    const fresh = [];
    for (const it of newItems) {
      const old = byKey.get(it.nkey);
      if (old) {
        merged++;
        // дубль: оставляем старую запись на её месте, дополняем пустые поля
        for (const k of ["description", "image", "favicon", "siteName"]) if (!old[k] && it[k]) old[k] = it[k];
        if (it.scrollY) old.scrollY = it.scrollY;
        continue;
      }
      byKey.set(it.nkey, it);
      fresh.push(it);
      added++;
    }
    d.items = fresh.concat(d.items);
    return { added, merged, ids: fresh.map((it) => it.id) };
  });
}

export function patchItems(ids, patch) {
  const set = new Set(ids);
  return update((d) => {
    for (const it of d.items) if (set.has(it.id)) Object.assign(it, typeof patch === "function" ? patch(it) : patch);
  });
}

/** Удалить; возвращает удалённые записи с их местами (для «Вернуть»). */
export function removeItems(ids) {
  const set = new Set(ids);
  return update((d) => {
    const removed = [];
    d.items.forEach((it, i) => set.has(it.id) && removed.push({ it, i }));
    d.items = d.items.filter((it) => !set.has(it.id));
    return removed;
  });
}

export function restoreItems(removed) {
  return update((d) => {
    const keys = new Set(d.items.map((it) => it.nkey));
    for (const { it, i } of removed.slice().sort((a, b) => a.i - b.i)) {
      if (keys.has(it.nkey)) continue;
      d.items.splice(Math.min(i, d.items.length), 0, it);
    }
  });
}

export function saveSettings(patch) {
  return update((d) => {
    d.settings = { ...d.settings, ...patch };
  });
}

export function addFolder(name) {
  return update((d) => {
    const f = { id: uid(), name: name.trim().slice(0, 60) };
    d.folders.push(f);
    return f;
  });
}

export function renameFolder(id, name) {
  return update((d) => {
    const f = d.folders.find((x) => x.id === id);
    if (f) f.name = name.trim().slice(0, 60);
  });
}

/** Папку удаляем, ссылки из неё остаются в списке (без папки). */
export function deleteFolder(id) {
  return update((d) => {
    d.folders = d.folders.filter((x) => x.id !== id);
    for (const it of d.items) if (it.folder === id) it.folder = null;
  });
}

/** Резервная копия и восстановление (слиянием, без потери текущих записей). */
export async function exportData() {
  const { items, folders } = await load();
  return { app: "tab-collector", version: 1, savedAt: new Date().toISOString(), items, folders };
}

export function importData(data) {
  return update((d) => {
    if (!data || !Array.isArray(data.items)) throw new Error("Это не копия списка вкладок");
    const keys = new Set(d.items.map((it) => it.nkey));
    const folderIds = new Set(d.folders.map((f) => f.id));
    for (const f of data.folders || []) {
      if (!f || typeof f.id !== "string" || typeof f.name !== "string" || folderIds.has(f.id)) continue;
      d.folders.push({ id: f.id.slice(0, 40), name: f.name.slice(0, 60) });
      folderIds.add(f.id);
    }
    const ids = new Set(d.items.map((it) => it.id));
    let added = 0;
    for (const raw of data.items) {
      // из файла берём только обычные адреса и пересобираем запись по полям — чужой HTML не пройдёт
      if (!raw || typeof raw.url !== "string" || !/^https?:\/\//i.test(raw.url)) continue;
      const key = normalizeUrl(raw.url);
      if (keys.has(key)) continue;
      const it = makeItem({ url: raw.url, title: String(raw.title || ""), favIconUrl: String(raw.favicon || "") }, {}, Number(raw.addedAt) || Date.now());
      for (const k of ["title", "meta", "description", "siteName", "sentCategory"]) if (typeof raw[k] === "string" && raw[k]) it[k] = raw[k].slice(0, 600);
      if (typeof raw.image === "string" && /^https:\/\//.test(raw.image)) it.image = raw.image;
      if (raw.sentAt) it.sentAt = Number(raw.sentAt) || null;
      if (typeof raw.folder === "string" && folderIds.has(raw.folder)) it.folder = raw.folder;
      if (raw.enrich === "done") it.enrich = "done";
      if (typeof raw.id === "string" && /^[\w-]{4,40}$/.test(raw.id) && !ids.has(raw.id)) it.id = raw.id;
      ids.add(it.id);
      keys.add(key);
      d.items.push(it);
      added++;
    }
    return added;
  });
}
