// Хранилище списка: chrome.storage.local (unlimitedStorage).
//   items   — собранные ссылки (см. makeItem)
//   folders — свои папки [{id, name}]
//   settings — адрес бота, секрет, тема
// Все записи — через update(): прочитать → изменить → записать одним set().

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
  return {
    id: uid(),
    url: tab.url,
    nkey: normalizeUrl(tab.url),
    title: (grab.title || tab.title || tab.url).trim(),
    favicon: tab.favIconUrl && /^https?:|^data:image\//.test(tab.favIconUrl) ? tab.favIconUrl : "",
    site: r.site,
    siteName: grab.siteName || "",
    provider: r.provider,
    ref: r.ref,
    kind: r.kind,
    icon: r.icon,
    kindLabel: r.kindLabel,
    kindLocked: r.kind !== "page",
    meta: "",
    description: desc.slice(0, 600),
    image: grab.image && /^https:\/\//.test(grab.image) ? grab.image : "",
    scrollY: Math.max(0, Math.round(grab.scrollY || 0)),
    folder: null,
    addedAt: now,
    sentAt: null,
    sentCategory: "",
    // известные сайты — уточняем через API; остальные — если страница не отдала описания
    enrich: known || !desc ? "pending" : "done",
  };
}

export async function load() {
  const d = await area().get(["items", "folders", "settings"]);
  return { items: d.items || [], folders: d.folders || [], settings: d.settings || {} };
}

let chain = Promise.resolve();
/** Последовательные изменения (без гонок между вызовами на одной странице). */
export function update(fn) {
  const run = chain.then(async () => {
    const d = await load();
    const res = await fn(d);
    await area().set({ items: d.items, folders: d.folders, settings: d.settings });
    return res;
  });
  chain = run.catch(() => {});
  return run;
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
        // дубль: оставляем старую запись, дополняем пустые поля и поднимаем наверх
        for (const k of ["description", "image", "favicon", "siteName"]) if (!old[k] && it[k]) old[k] = it[k];
        if (it.scrollY) old.scrollY = it.scrollY;
        old.addedAt = it.addedAt;
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
    for (const f of data.folders || []) if (f && f.id && !folderIds.has(f.id)) d.folders.push(f);
    let added = 0;
    for (const it of data.items) {
      if (!it || !it.url || keys.has(it.nkey || normalizeUrl(it.url))) continue;
      d.items.push({ ...it, nkey: it.nkey || normalizeUrl(it.url), id: it.id || uid() });
      keys.add(it.nkey);
      added++;
    }
    return added;
  });
}
