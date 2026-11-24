// Хранилище без Chrome: подменяем chrome.storage.local и navigator.locks в памяти.
import assert from "node:assert/strict";

const mem = {};
const writes = [];
globalThis.chrome = {
  storage: {
    local: {
      async get(keys) {
        if (keys === null || keys === undefined) return structuredClone(mem);
        const list = typeof keys === "string" ? [keys] : keys;
        return Object.fromEntries(list.filter((k) => k in mem).map((k) => [k, structuredClone(mem[k])]));
      },
      async set(obj) {
        writes.push(Object.keys(obj));
        Object.assign(mem, structuredClone(obj));
      },
      async remove(keys) {
        for (const k of [].concat(keys)) delete mem[k];
      },
    },
  },
};
let chain = Promise.resolve();
Object.defineProperty(globalThis, "navigator", {
  value: { locks: { request: (_n, fn) => (chain = chain.then(fn, fn)) } },
  configurable: true,
});

const { load, addItems, patchItems, removeItems, restoreItems, makeItem, importData, cleanOrphans } = await import("../core/store.js");

let ok = 0;
let fail = 0;
async function t(name, fn) {
  try {
    await fn();
    ok++;
  } catch (e) {
    fail++;
    console.log(`FAIL ${name}\n  ${e.message}`);
  }
}

const tab = (url, title = "T") => ({ url, title });

await t("старый формат переносится без потерь", async () => {
  mem.items = [makeItem(tab("https://a.ru/1")), makeItem(tab("https://a.ru/2"))];
  mem.settings = { theme: "dark" };
  await patchItems([], {}); // любая запись запускает перенос
  assert.ok(!("items" in mem));
  assert.equal(mem.order.length, 2);
  const d = await load();
  assert.deepEqual(d.items.map((i) => i.url), ["https://a.ru/1", "https://a.ru/2"]);
  assert.equal(d.settings.theme, "dark");
});

await t("изменение одной ссылки пишет только её", async () => {
  const { items } = await load();
  writes.length = 0;
  await patchItems([items[1].id], { meta: "★ 9" });
  assert.deepEqual(writes, [[`it:${items[1].id}`]]);
});

await t("добавление: новые сверху, дубль склеивается", async () => {
  const r = await addItems([makeItem(tab("https://a.ru/3")), makeItem(tab("https://a.ru/1#comments"))]);
  assert.equal(r.added, 1);
  assert.equal(r.merged, 1);
  const d = await load();
  assert.deepEqual(d.items.map((i) => i.url), ["https://a.ru/3", "https://a.ru/1", "https://a.ru/2"]);
});

await t("удаление и «Вернуть» — на прежние места", async () => {
  const { items } = await load();
  const removed = await removeItems([items[1].id]);
  assert.ok(!(`it:${items[1].id}` in mem));
  assert.equal((await load()).items.length, 2);
  await restoreItems(removed);
  assert.deepEqual((await load()).items.map((i) => i.url), ["https://a.ru/3", "https://a.ru/1", "https://a.ru/2"]);
});

await t("недостёртая удалённая ссылка не «воскресает» и убирается", async () => {
  const ghost = makeItem(tab("https://a.ru/ghost"));
  mem[`it:${ghost.id}`] = ghost; // как будто remove не успел пройти
  mem.items = []; // и старый ключ после переноса остался
  assert.ok(!(await load()).items.some((i) => i.url === "https://a.ru/ghost"));
  await patchItems([], {}); // обычная запись уже убирает оставшийся старый ключ items
  assert.ok(!("items" in mem));
  assert.ok(!(await load()).items.some((i) => i.url === "https://a.ru/ghost"));
  const n = await cleanOrphans(); // а недостёртую ссылку — уборка при запуске страницы
  assert.equal(n, 1);
  assert.ok(!(`it:${ghost.id}` in mem) && !("items" in mem));
});

await t("загрузка копии: только веб-адреса, без чужого HTML в id", async () => {
  const n = await importData({
    items: [
      { url: "https://b.ru/1", title: "B", id: '"><img src=x>' },
      { url: "javascript:alert(1)", title: "X" },
      { url: "https://b.ru/1", title: "дубль внутри файла" },
    ],
    folders: [{ id: "f1", name: "Папка" }, { id: 5, name: "битая" }],
  });
  assert.equal(n, 1);
  const d = await load();
  const b = d.items.find((i) => i.url === "https://b.ru/1");
  assert.match(b.id, /^[\w-]+$/);
  assert.deepEqual(d.folders.map((f) => f.id), ["f1"]);
});

await t("копия сохраняет пометку сбора (batch)", async () => {
  const n = await importData({ items: [{ url: "https://c.ru/1", title: "C", addedAt: 1000, batch: 1000 }], folders: [] });
  assert.equal(n, 1);
  assert.equal((await load()).items.find((i) => i.url === "https://c.ru/1").batch, 1000);
});

console.log(`${ok} OK, ${fail} FAIL (хранилище)`);
process.exit(fail ? 1 : 0);
