// Автопроверки чистых модулей (без Chrome): node tests/run.mjs
import assert from "node:assert/strict";
import { recognize, normalizeUrl, siteOf, collectable, kindFromOgType } from "../core/url.js";
import { itemText, listParts, payload, batches, botError, linksWord, EACH_BATCH, BODY_MAX, bodySize, descLimit } from "../core/format.js";
import { stripBB, shikiPatch, jikanPatch, anilistPatch, githubPatch } from "../core/enrich.js";

let ok = 0;
let fail = 0;
function t(name, fn) {
  try {
    fn();
    ok++;
  } catch (e) {
    fail++;
    console.log(`FAIL ${name}\n  ${e.message}`);
  }
}

// ---------------------------------------------------------------- распознавание
t("shikimori аниме", () => {
  const r = recognize("https://shikimori.one/animes/52991-sousou-no-frieren");
  assert.equal(r.provider, "shikimori");
  assert.equal(r.kind, "anime");
  assert.equal(r.kindLabel, "Аниме");
  assert.deepEqual(r.ref, { section: "animes", id: "52991", origin: "https://shikimori.one" });
});
t("shikimori z-id, манга, ранобэ, персонаж, человек", () => {
  assert.equal(recognize("https://shikimori.one/animes/z52991-x").ref.id, "52991");
  assert.equal(recognize("https://shikimori.one/mangas/2-berserk").kind, "manga");
  assert.equal(recognize("https://shikimori.one/ranobe/9115-x").kind, "ranobe");
  assert.equal(recognize("https://shikimori.one/characters/422-guts").kind, "character");
  assert.equal(recognize("https://shikimori.one/people/1868").kind, "person");
});
t("shikimori: прочие страницы — обычные", () => {
  const r = recognize("https://shikimori.one/forum");
  assert.equal(r.kind, "page");
  assert.equal(r.provider, null);
});
t("shikimori: дубли склеиваются по id (и зеркала)", () => {
  assert.equal(normalizeUrl("https://shikimori.one/animes/52991-sousou-no-frieren"), normalizeUrl("https://shikimori.one/animes/52991"));
  assert.equal(normalizeUrl("https://shikimori.one/animes/52991-a#comments"), normalizeUrl("https://shikimori.me/animes/52991"));
});
t("MAL и AniList", () => {
  assert.equal(recognize("https://myanimelist.net/anime/52991/Sousou_no_Frieren").provider, "mal");
  assert.equal(recognize("https://myanimelist.net/people/1868/x").kind, "person");
  assert.equal(recognize("https://anilist.co/anime/154587/Sousou-no-Frieren/").kind, "anime");
  assert.equal(recognize("https://anilist.co/staff/95269").kind, "person");
});
t("YouTube", () => {
  assert.equal(recognize("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10").ref.id, "dQw4w9WgXcQ");
  assert.equal(recognize("https://youtu.be/dQw4w9WgXcQ").key, "youtube:dQw4w9WgXcQ");
  assert.equal(recognize("https://www.youtube.com/shorts/dQw4w9WgXcQ").kind, "short");
  assert.equal(recognize("https://www.youtube.com/@veritasium/videos").kind, "channel");
  assert.equal(recognize("https://www.youtube.com/playlist?list=PL123").kind, "playlist");
  assert.equal(normalizeUrl("https://m.youtube.com/watch?v=dQw4w9WgXcQ"), normalizeUrl("https://youtu.be/dQw4w9WgXcQ"));
});
t("GitHub", () => {
  const r = recognize("https://github.com/yt-dlp/yt-dlp");
  assert.equal(r.kind, "repo");
  assert.deepEqual(r.ref, { owner: "yt-dlp", repo: "yt-dlp" });
  assert.equal(recognize("https://github.com/yt-dlp/yt-dlp/issues/123").kind, "issue");
  assert.equal(recognize("https://github.com/yt-dlp/yt-dlp/pull/45").kind, "pr");
  assert.equal(recognize("https://github.com/torvalds").kind, "user");
  assert.equal(recognize("https://github.com/settings/profile").kind, "page");
  assert.equal(recognize("https://github.com/yt-dlp/yt-dlp/tree/master").kind, "page");
});
t("Википедия", () => {
  const r = recognize("https://ru.wikipedia.org/wiki/%D0%A4%D1%80%D0%B8%D1%80%D0%B5%D0%BD");
  assert.equal(r.provider, "wikipedia");
  assert.equal(r.ref.lang, "ru");
  assert.equal(r.ref.title, "Фрирен");
  assert.equal(recognize("https://ru.wikipedia.org/wiki/Служебная:Поиск").provider, "page");
  assert.equal(recognize("https://en.wikipedia.org/wiki/Category:Anime").provider, "page");
});
t("Хабр", () => {
  assert.equal(recognize("https://habr.com/ru/articles/812345/").kind, "article");
  assert.equal(recognize("https://habr.com/ru/companies/yandex/articles/812345/").key, "habr:812345");
  assert.equal(recognize("https://habr.com/ru/news/812346/").kind, "news");
});
t("обычные сайты и служебные", () => {
  assert.equal(recognize("https://example.com/a?utm_source=x").provider, "page");
  assert.equal(siteOf("https://www.example.com/x"), "example.com");
  assert.equal(normalizeUrl("https://www.example.com/a/?utm_source=x&b=2&a=1#top"), "example.com/a?a=1&b=2");
  assert.ok(collectable("https://x.ru"));
  assert.ok(!collectable("chrome://settings"));
  assert.ok(!collectable("chrome-extension://abc/app.html"));
  assert.equal(kindFromOgType("article"), "article");
  assert.equal(kindFromOgType("video.movie"), "video");
  assert.equal(kindFromOgType("website"), "page");
});

// ---------------------------------------------------------------- описания
t("BB-коды Shikimori", () => {
  assert.equal(stripBB("Эльф [character=184947]Фрирен[/character] и [[Химмель]]. [spoiler=x]тайна[/spoiler]Конец"), "Эльф Фрирен и Химмель. Конец");
});
t("shikiPatch аниме", () => {
  const p = shikiPatch(
    "animes",
    {
      name: "Sousou no Frieren", russian: "Провожающая в последний путь Фрирен", kind: "tv", episodes: 28, status: "released",
      aired_on: "2023-09-29", score: "9.1", genres: [{ russian: "Приключения" }, { russian: "Драма" }, { russian: "Фэнтези" }, { russian: "Сёнэн" }],
      studios: [{ name: "Madhouse" }], description: "Эльфийка [character=1]Фрирен[/character] идёт.", image: { original: "/system/animes/original/52991.jpg?1" },
    },
    "https://shikimori.one"
  );
  assert.equal(p.title, "Провожающая в последний путь Фрирен");
  assert.equal(p.meta, "2023 · TV-сериал, 28 эп. · вышло · Madhouse · ★ 9.1 · приключения, драма, фэнтези");
  assert.equal(p.description, "Эльфийка Фрирен идёт.");
  assert.equal(p.image, "https://shikimori.one/system/animes/original/52991.jpg?1");
});
t("shikiPatch манга и персонаж", () => {
  const m = shikiPatch("mangas", { name: "Berserk", russian: "Берсерк", kind: "manga", volumes: 41, chapters: 380, status: "ongoing", aired_on: "1989-08-25", score: "9.47", genres: [] }, "https://shikimori.one");
  assert.equal(m.meta, "1989 · манга, 41 т., 380 гл. · выходит · ★ 9.5");
  const c = shikiPatch("characters", { name: "Guts", russian: "Гатс", mangas: [{ russian: "Берсерк" }], image: { original: "/assets/globals/missing_original.jpg" } }, "https://shikimori.one");
  assert.equal(c.title, "Гатс");
  assert.equal(c.meta, "Guts · из «Берсерк»");
  assert.equal(c.image, "");
});
t("jikan, anilist, github", () => {
  const j = jikanPatch("anime", { title: "Sousou no Frieren", title_english: "Frieren", type: "TV", episodes: 28, status: "Finished Airing", year: 2023, score: 9.3, genres: [{ name: "Adventure" }] });
  assert.equal(j.meta, "2023 · TV, 28 эп. · вышло · ★ 9.3 · Adventure");
  const a = anilistPatch("anime", { title: { romaji: "Sousou no Frieren", english: "Frieren" }, format: "TV", episodes: 28, status: "FINISHED", seasonYear: 2023, averageScore: 91, genres: ["Adventure"], description: "A<br>b" });
  assert.equal(a.meta, "2023 · TV, 28 эп. · вышло · ★ 9.1 · adventure");
  const g = githubPatch("repo", { full_name: "yt-dlp/yt-dlp", stargazers_count: 120345, language: "Python", topics: ["youtube"], description: "A feature-rich downloader" });
  assert.equal(g.meta, "★ 120 тыс. · Python · youtube");
});

// ---------------------------------------------------------------- сообщение
const frieren = {
  id: "1", url: "https://shikimori.one/animes/52991", site: "shikimori.one", kind: "anime", kindLabel: "Аниме", icon: "🎬",
  title: "Фрирен", meta: "2023 · TV-сериал", description: "Эльфийка-маг ".repeat(30), image: "https://shikimori.one/x.jpg",
};
t("текст ссылки как у бота", () => {
  const s = itemText({ ...frieren, description: "Коротко." });
  assert.equal(s, "🎬 Аниме · Фрирен\n2023 · TV-сериал\nКоротко.\nhttps://shikimori.one/animes/52991");
  assert.equal(itemText({ url: "https://x.ru", title: "", kindLabel: "Страница", icon: "🔗" }), "🔗 Страница · https://x.ru\nhttps://x.ru");
});
t("список: заголовок, части ≤4096", () => {
  const one = listParts([frieren], "Зима");
  assert.equal(one.length, 1);
  assert.ok(one[0].startsWith("🔗 Зима\n1 ссылка\n\n🎬 Аниме · Фрирен"));
  const many = listParts(Array.from({ length: 80 }, (_, i) => ({ ...frieren, url: frieren.url + i })), "");
  assert.ok(many.length > 1);
  assert.ok(many.every((p) => p.length <= 4096));
  assert.ok(many[0].startsWith(`🔗 Список ссылок · часть 1/${many.length}\n80 ссылок`));
});
t("тело запроса: поля контракта, лимиты, картинка только в each", () => {
  const b = payload("each", [{ ...frieren, extra: 1 }]);
  assert.deepEqual(Object.keys(b.items[0]).sort(), ["description", "icon", "image", "kind", "kindLabel", "meta", "site", "title", "url"]);
  assert.ok(b.items[0].description.length <= 600);
  const l = payload("list", [frieren], "Т");
  assert.equal(l.title, "Т");
  assert.equal(l.items[0].image, undefined);
  assert.ok(l.items[0].description.length <= 140);
});
t("пачки: each по 5, list влезает в 64 КБ", () => {
  const items = Array.from({ length: 23 }, (_, i) => ({ ...frieren, id: String(i), description: "ж".repeat(600), title: "т".repeat(300), meta: "м".repeat(300) }));
  assert.deepEqual(batches("each", items).map((b) => b.length), [5, 5, 5, 5, 3]);
  assert.equal(EACH_BATCH, 5);
  const big = Array.from({ length: 100 }, (_, i) => ({ ...items[0], id: String(i) }));
  const parts = batches("list", big);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => bodySize(payload("list", p, "x".repeat(120))) <= BODY_MAX));
  assert.equal(parts.flat().length, 100);
});
t("подробность описания", () => {
  assert.equal(descLimit("each", "none"), 0);
  assert.equal(descLimit("each", "short"), 140);
  assert.equal(descLimit("each", "full"), 600);
  assert.equal(descLimit("list", "full"), 140);
  assert.equal(payload("each", [frieren], "", "none").items[0].description, "");
  assert.ok(payload("each", [frieren], "", "short").items[0].description.length <= 140);
  assert.ok(!itemText(frieren, { descMax: 0 }).includes("Эльфийка"));
  assert.ok(!listParts([frieren], "", 0)[0].includes("Эльфийка"));
});
t("ошибки бота — по-русски", () => {
  assert.match(botError(404, null), /Обновите бота/);
  assert.match(botError(403, { code: "forbidden" }), /секрет/);
  assert.match(botError(0, null), /Нет связи/);
  assert.equal(linksWord(1), "1 ссылка");
  assert.equal(linksWord(3), "3 ссылки");
  assert.equal(linksWord(11), "11 ссылок");
  assert.equal(linksWord(22), "22 ссылки");
});

console.log(`\n${ok} OK, ${fail} FAIL`);
process.exit(fail ? 1 : 0);
