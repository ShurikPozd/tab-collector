// Фоновое уточнение описаний, пока открыта страница сборщика: по очереди спрашивает
// API сайтов (Shikimori, MyAnimeList, AniList, YouTube, GitHub, Википедия) и метатеги
// страниц. Изменения копятся и записываются пачкой раз в ~1,5 с.

import { fetchDetails } from "../core/enrich.js";
import { load, update } from "../core/store.js";

const FIELDS = ["title", "meta", "description", "image", "siteName", "kind", "icon", "kindLabel"];
let running = false;
// запрошенные, но ещё не записанные ссылки: чтобы не спросить дважды. После записи — убираем,
// поэтому «Попробовать ещё раз» снова их уточнит.
const seen = new Set();
let left = 0;
let onState = () => {};

export function onEnrichState(fn) {
  onState = fn;
}

export function enrichLeft() {
  return running ? left : 0;
}

async function flush(patches) {
  if (!patches.size) return;
  const batch = new Map(patches);
  patches.clear();
  await update((d) => {
    for (const it of d.items) {
      const p = batch.get(it.id);
      if (!p) continue;
      if (it.enrich !== "pending") continue; // другая страница уже уточнила — не затираем
      for (const k of FIELDS) if (p[k]) it[k] = p[k];
      it.enrich = p.enrich;
    }
  });
  for (const id of batch.keys()) seen.delete(id);
}

// Уточняет только одна страница (вкладка или любая из панелей): замок общий для всех —
// иначе запросы к сайтам удваивались бы и упирались в их лимиты.
export function runEnrich() {
  if (running) return Promise.resolve();
  return navigator.locks.request("tc-enrich", { ifAvailable: true }, (lock) => (lock ? enrichLoop() : null));
}

async function enrichLoop() {
  if (running) return;
  running = true;
  const patches = new Map();
  let timer = null;
  let writing = Promise.resolve();
  try {
    for (;;) {
      // вкладка сборщика ушла в фон — отпускаем работу видимой странице (панели), в фоне таймеры медленные
      if (document.hidden) break;
      await writing;
      const { items } = await load();
      const todo = items.filter((it) => it.enrich === "pending" && !patches.has(it.id) && !seen.has(it.id));
      if (!todo.length) break;
      left = todo.length;
      onState(left);
      let i = 0;
      const worker = async () => {
        while (i < todo.length && !document.hidden) {
          const it = todo[i++];
          seen.add(it.id);
          let p;
          try {
            p = { ...(await fetchDetails(it)), enrich: "done" };
          } catch (e) {
            p = { enrich: "failed" };
          }
          patches.set(it.id, p);
          left = Math.max(0, left - 1);
          onState(left);
          if (!timer) timer = setTimeout(() => ((timer = null), (writing = flush(patches))), 3000);
        }
      };
      // разные сайты идут параллельно, один и тот же — с паузами (см. polite в enrich.js)
      await Promise.all([worker(), worker(), worker(), worker()]);
      clearTimeout(timer);
      timer = null;
      await writing;
      await flush(patches);
    }
  } finally {
    running = false;
    left = 0;
    onState(0);
  }
}

/** Повторить неудачные (например, сайт был недоступен). */
export async function retryFailed(ids) {
  const set = ids ? new Set(ids) : null;
  await update((d) => {
    for (const it of d.items) if (it.enrich === "failed" && (!set || set.has(it.id))) it.enrich = "pending";
  });
  return runEnrich();
}
