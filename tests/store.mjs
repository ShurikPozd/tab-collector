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

const { load, addItems, patchItems, removeItems, restoreItems, makeItem, importData, cleanOrphans, migrateKeys } = await import("../core/store.js");

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

await t("копия сохраняет отметку «хочу / смотрю / готово»", async () => {
  await importData({ items: [{ url: "https://m.ru/1", title: "M", mark: "done" }, { url: "https://m.ru/2", title: "M2", mark: "<b>" }], folders: [] });
  const d = await load();
  assert.equal(d.items.find((i) => i.url === "https://m.ru/1").mark, "done");
  assert.equal(d.items.find((i) => i.url === "https://m.ru/2").mark, undefined);
});

await t("копия сохраняет пометку сбора (batch)", async () => {
  const n = await importData({ items: [{ url: "https://c.ru/1", title: "C", addedAt: 1000, batch: 1000 }], folders: [] });
  assert.equal(n, 1);
  assert.equal((await load()).items.find((i) => i.url === "https://c.ru/1").batch, 1000);
});

await t("новые сайты: старые записи распознаются заново (ключ, тип, описание)", async () => {
  const url = "https://rutube.ru/video/0123456789abcdef0123456789abcdef/";
  const it = makeItem({ url, title: "Видео" }, {}, 1);
  await addItems([it]);
  await patchItems([it.id], () => ({ provider: null, ref: null, kind: "page", nkey: "rutube.ru/video/0123456789abcdef0123456789abcdef", enrich: "done" }));
  mem.settings = { ...(mem.settings || {}), keysVersion: 3 };
  assert.ok((await migrateKeys()) > 0);
  const got = (await load()).items.find((x) => x.id === it.id);
  assert.equal(got.provider, "rutube");
  assert.equal(got.nkey, it.nkey);
  assert.equal(got.enrich, "pending");
  assert.equal(await migrateKeys(), 0); // второй раз — ничего
  await removeItems([it.id]);
});

await t("миграция склеивает зеркала с одним ключом (spb.hh.ru и hh.ru)", async () => {
  const a = makeItem({ url: "https://hh.ru/vacancy/123", title: "Вакансия" }, {}, 1);
  const b = makeItem({ url: "https://spb.hh.ru/vacancy/123?query=x", title: "Вакансия" }, {}, 1);
  b.nkey = "spb.hh.ru/vacancy/123"; // как у записи, собранной до 0.5.2
  a.nkey = "hh.ru/vacancy/123";
  await addItems([a, b]);
  await patchItems([a.id], () => ({ provider: null, kind: "page", nkey: "hh.ru/vacancy/123" }));
  await patchItems([b.id], () => ({ provider: null, kind: "page", nkey: "spb.hh.ru/vacancy/123", mark: "want", sentAt: 5 }));
  mem.settings = { ...(mem.settings || {}), keysVersion: 3 };
  await migrateKeys();
  const left = (await load()).items.filter((x) => x.id === a.id || x.id === b.id);
  assert.equal(left.length, 1);
  assert.equal(left[0].mark, "want");
  assert.equal(left[0].sentAt, 5);
  await removeItems(left.map((x) => x.id));
});

await t("копия сохраняет тип страницы и место прокрутки", async () => {
  await importData({ items: [{ url: "https://blog.example/post-1", title: "Пост", kind: "article", scrollY: 500 }, { url: "https://blog.example/post-2", kind: "<x>" }], folders: [{ id: "f-1", name: "  " }] });
  const all = (await load()).items;
  const a = all.find((i) => i.url === "https://blog.example/post-1");
  assert.equal(a.kind, "article");
  assert.equal(a.scrollY, 500);
  assert.equal(all.find((i) => i.url === "https://blog.example/post-2").kind, "page");
  assert.ok(!(await load()).folders.some((f) => f.id === "f-1")); // пустое имя папки не берём
});

await t("часть списка без ответа бота повторяется слово в слово", async () => {
  const sess = {};
  chrome.storage.session = {
    async get(k) {
      return k in sess ? { [k]: structuredClone(sess[k]) } : {};
    },
    async set(o) {
      Object.assign(sess, structuredClone(o));
    },
    async remove(k) {
      delete sess[k];
    },
  };
  mem.settings = { ...(mem.settings || {}), token: "t", baseUrl: "http://127.0.0.1:9" };
  const bodies = [];
  let status = 500;
  globalThis.fetch = async (_u, init) => {
    bodies.push(JSON.parse(init.body));
    return { status, json: async () => (status === 200 ? { ok: true, status: "saved" } : {}) };
  };
  const { sendLinks } = await import("../core/bot.js");
  const items = [0, 1, 2].map((i) => ({ ...makeItem({ url: `https://ex.ru/p${i}`, title: `P${i}` }, {}, 1), id: `u${i}` }));
  const r1 = await sendLinks(items, "list", { title: "Подборка" });
  assert.ok(r1.error);
  // описания уточнились, заголовок не вписали заново — запрос тот же, ключ тот же
  const later = items.map((it) => ({ ...it, description: "Длинное описание ".repeat(10) }));
  status = 200;
  const r2 = await sendLinks(later, "list", { title: "" });
  assert.equal(r2.saved, 3);
  assert.deepEqual(bodies[1], bodies[0]);
  // подтверждено — дальше обычный запрос
  await sendLinks(later.map((it) => ({ ...it, sentAt: 7 })), "list", { title: "" });
  assert.notEqual(bodies[2].batchKey, bodies[0].batchKey); // уже отправлены — новый пост
  assert.ok(bodies[2].items[0].description);
  // бот отклонил запрос (4xx) — поста точно нет, слово в слово не повторяем
  status = 400;
  await sendLinks(items, "list", { title: "X" });
  status = 200;
  await sendLinks(later, "list", { title: "X" });
  assert.ok(bodies[4].items[0].description);
});

console.log(`${ok} OK, ${fail} FAIL (хранилище)`);
process.exit(fail ? 1 : 0);
