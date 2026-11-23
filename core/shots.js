// Снимки страниц для предпросмотра: небольшой JPEG (≤640 px), снятый, когда вы
// переходите на вкладку. Хранятся только в этом браузере (IndexedDB), ключ — normalizeUrl.

const DB = "tc-shots";
const STORE = "shots";
const KEEP = 3000; // больше — старые удаляются

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE).createIndex("ts", "ts");
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

let dbp = null;
const db = () => (dbp ||= open());

function tx(mode, fn) {
  return db().then(
    (d) =>
      new Promise((res, rej) => {
        const t = d.transaction(STORE, mode);
        const out = fn(t.objectStore(STORE));
        t.oncomplete = () => res(out && "result" in out ? out.result : undefined);
        t.onerror = () => rej(t.error);
      })
  );
}

export function putShot(key, blob) {
  return tx("readwrite", (s) => s.put({ blob, ts: Date.now() }, key));
}

export async function getShot(key) {
  const v = await tx("readonly", (s) => s.get(key));
  return v ? v.blob : null;
}

export async function hasShots(keys) {
  const all = await tx("readonly", (s) => s.getAllKeys());
  const set = new Set(all);
  return keys.filter((k) => set.has(k));
}

/** ключ → время снимка (без чтения самих картинок): видно и новые снимки, и пересъёмку. */
export async function shotStamps() {
  const d = await db();
  return new Promise((res, rej) => {
    const out = new Map();
    const t = d.transaction(STORE, "readonly");
    t.objectStore(STORE).index("ts").openKeyCursor().onsuccess = (ev) => {
      const cur = ev.target.result;
      if (!cur) return;
      out.set(cur.primaryKey, cur.key);
      cur.continue();
    };
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
  });
}

export function clearShots() {
  return tx("readwrite", (s) => s.clear());
}

export async function countShots() {
  return tx("readonly", (s) => s.count());
}

/** Оставить KEEP самых свежих. */
export async function pruneShots() {
  const n = await countShots();
  if (n <= KEEP) return;
  let drop = n - KEEP;
  await tx("readwrite", (s) => {
    s.index("ts").openCursor().onsuccess = (e) => {
      const c = e.target.result;
      if (!c || drop <= 0) return;
      c.delete();
      drop--;
      c.continue();
    };
  });
}

/** Уменьшить снимок экрана (dataURL) до ширины ≤640 px, JPEG. Работает и в фоне (OffscreenCanvas). */
export async function shrink(dataUrl, width = 640) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, width / bmp.width);
  const w = Math.round(bmp.width * k);
  const h = Math.round(Math.min(bmp.height * k, w * 0.75)); // верх страницы, не выше 4:3
  const c = new OffscreenCanvas(w, h);
  c.getContext("2d").drawImage(bmp, 0, 0, bmp.width * k, bmp.height * k);
  bmp.close();
  return c.convertToBlob({ type: "image/jpeg", quality: 0.72 });
}
