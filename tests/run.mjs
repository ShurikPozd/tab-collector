// Автопроверки чистых модулей (без Chrome): node tests/run.mjs
import assert from "node:assert/strict";
import { recognize, normalizeUrl, siteOf, collectable, kindFromOgType, searchOf, siteLabel, providerForSite, siteTitle } from "../core/url.js";
import { itemText, listParts, payload, batches, botError, linksWord, EACH_BATCH, BODY_MAX, bodySize, descLimit, clip } from "../core/format.js";
import { stripBB, shikiPatch, jikanPatch, anilistPatch, githubPatch, safeToFetch } from "../core/enrich.js";
import { anilibriaPatch, mangalibPatch, mangalibMetaPatch, webtoonPatch, rutubePatch, hhPagePatch, metaTags, jsonLd, decodeEntities, duration } from "../core/enrich.js";
import { sendable } from "../core/bot.js";
import { findDuplicates } from "../core/dups.js";
import { markLabel } from "../core/marks.js";
import { batchKey } from "../core/format.js";
import { readFileSync } from "node:fs";

// образцы настоящих ответов сайтов (снятые один раз, обрезанные) — тесты работают без сети
const fixture = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), "utf8");
const fixtureJSON = (f) => JSON.parse(fixture(f));

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
  assert.equal(recognize("https://www.youtube.com/@veritasium").kind, "channel");
  // вкладки канала — отдельные страницы (сбор не закроет одну как дубль другой)
  assert.notEqual(normalizeUrl("https://www.youtube.com/@veritasium/videos"), normalizeUrl("https://www.youtube.com/@veritasium/community"));
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

t("дубли: разные страницы не сливаются (сбор закрывает вкладки-дубли)", () => {
  assert.notEqual(normalizeUrl("https://mail.google.com/mail/u/0/#inbox/AAA"), normalizeUrl("https://mail.google.com/mail/u/0/#inbox/BBB"));
  assert.notEqual(normalizeUrl("https://web.telegram.org/k/#@durov"), normalizeUrl("https://web.telegram.org/k/#@telegram"));
  assert.notEqual(normalizeUrl("https://web.telegram.org/a/#-100123"), normalizeUrl("https://web.telegram.org/a/#-100456"));
  assert.notEqual(normalizeUrl("https://bit.ly/AbC"), normalizeUrl("https://bit.ly/abc"));
  assert.notEqual(normalizeUrl("https://example.com/#/page1"), normalizeUrl("https://example.com/#/page2"));
  assert.notEqual(normalizeUrl("https://ru.wikipedia.org/wiki/MASH"), normalizeUrl("https://ru.wikipedia.org/wiki/Mash"));
  assert.notEqual(normalizeUrl("https://www.youtube.com/channel/UCabc"), normalizeUrl("https://www.youtube.com/channel/UCABC"));
  // а это — одна страница
  assert.equal(normalizeUrl("https://www.example.com/a/#comments"), normalizeUrl("https://example.com/a"));
  assert.equal(normalizeUrl("https://Example.COM/A?utm_source=x"), normalizeUrl("https://example.com/A"));
  assert.equal(normalizeUrl("https://www.youtube.com/@Veritasium"), normalizeUrl("https://www.youtube.com/@veritasium"));
});
t("адрес Википедии с неэкранированным % не роняет страницу", () => {
  const r = recognize("https://en.wikipedia.org/wiki/100%_cotton");
  assert.equal(r.provider, "wikipedia");
  assert.equal(r.ref.title, "100%_cotton");
  assert.ok(normalizeUrl("https://en.wikipedia.org/wiki/100%_cotton"));
});
t("повторно не запрашиваем частные адреса и «опасные» страницы", () => {
  assert.ok(safeToFetch("https://habr.com/ru/articles/1/"));
  for (const u of ["http://localhost:3000/", "http://192.168.1.1/", "http://10.0.0.5/x", "https://router.local/", "https://site.ru/logout", "https://site.ru/unsubscribe?id=1", "https://site.ru/x?token=abc", "file:///C:/a.html"])
    assert.ok(!safeToFetch(u), u);
});
t("в бота уходят только веб-адреса до 2048 символов", () => {
  assert.ok(sendable({ url: "https://x.ru/a" }));
  assert.ok(!sendable({ url: "file:///C:/a.html" }));
  assert.ok(!sendable({ url: "ftp://x.ru/a" }));
  assert.ok(!sendable({ url: "https://x.ru/" + "a".repeat(2100) }));
});

t("разные поиски не склеиваются (сбор закрыл бы вторую вкладку)", () => {
  const k = (u) => normalizeUrl(u);
  assert.notEqual(k("https://www.google.com/search?q=cats"), k("https://www.google.com/search?q=cats&tbm=isch"));
  assert.notEqual(k("https://www.google.com/search?q=cats"), k("https://www.google.com/search?q=cats&udm=2"));
  assert.notEqual(k("https://www.google.com/search?q=cats"), k("https://www.google.com/search?q=cats&start=10"));
  assert.notEqual(k("https://yandex.ru/search/?text=x"), k("https://yandex.ru/search/?text=x&p=2"));
  assert.equal(k("https://www.google.com/search?q=cats&ei=1&sca_esv=2"), k("https://google.com/search?q=Cats"));
  // якорь из одного слова в почте — тоже разные страницы
  assert.notEqual(k("https://mail.google.com/mail/u/0/#inbox"), k("https://mail.google.com/mail/u/0/#sent"));
  assert.equal(k("https://example.com/post#comments"), k("https://example.com/post"));
  // si/feature — метки YouTube, на других сайтах это обычные параметры
  assert.notEqual(k("https://shop.ru/item?si=1"), k("https://shop.ru/item?si=2"));
});
t("подстраницы — не дубли главной (правка в Википедии, файлы PR, рецензии)", () => {
  const k = (u) => normalizeUrl(u);
  assert.notEqual(k("https://ru.wikipedia.org/wiki/X?action=edit"), k("https://ru.wikipedia.org/wiki/X"));
  assert.notEqual(k("https://github.com/torvalds?tab=repositories"), k("https://github.com/torvalds?tab=stars"));
  assert.notEqual(k("https://github.com/o/r/pull/5/files"), k("https://github.com/o/r/pull/5"));
  assert.notEqual(k("https://shikimori.one/animes/1-a/reviews"), k("https://shikimori.one/animes/1-a"));
  assert.notEqual(k("https://habr.com/ru/articles/5/comments/"), k("https://habr.com/ru/articles/5/"));
  // а главная — по-прежнему одна
  assert.equal(k("https://shikimori.one/animes/52991-frieren"), k("https://shikimori.io/animes/52991"));
  assert.equal(k("https://myanimelist.net/anime/52991/Sousou_no_Frieren"), k("https://myanimelist.net/anime/52991"));
  assert.equal(recognize("https://github.com/o/r/pull/5").kind, "pr");
  assert.equal(k("https://x.ru/a?utm_source_platform=tg"), k("https://x.ru/a"));
});
t("служебные параметры не мешают распознаванию (GitHub, Википедия, YouTube)", () => {
  const k = (u) => normalizeUrl(u);
  assert.equal(recognize("https://github.com/o/r?tab=readme-ov-file").kind, "repo");
  assert.equal(k("https://github.com/o/r?tab=readme-ov-file"), k("https://github.com/o/r"));
  assert.equal(recognize("https://github.com/o/r/issues/5?notification_referrer_id=NT_x").kind, "issue");
  assert.equal(recognize("https://github.com/torvalds?tab=stars").kind, "page");
  assert.equal(recognize("https://ru.wikipedia.org/wiki/X?wprov=sfla1").provider, "wikipedia");
  assert.equal(recognize("https://ru.m.wikipedia.org/wiki/X").provider, "wikipedia");
  assert.equal(k("https://ru.m.wikipedia.org/wiki/X"), k("https://ru.wikipedia.org/wiki/X"));
  assert.equal(recognize("https://www.youtube.com/@veritasium/featured").kind, "channel");
});
t("известный сайт — по адресу (группы и меню называются одинаково)", () => {
  assert.equal(providerForSite("shikimori.io"), "shikimori");
  assert.equal(providerForSite("ru.m.wikipedia.org"), "wikipedia");
  assert.equal(providerForSite("youtube.com"), "youtube");
  assert.equal(providerForSite("example.com"), null);
  assert.equal(siteTitle("youtube.com"), "YouTube");
  assert.equal(siteTitle("example.com"), "example.com");
  assert.equal(siteTitle("file"), "Файлы на компьютере");
});
t("поиск Google и Яндекса", () => {
  const r = recognize("https://www.google.com/search?q=%D1%84%D1%80%D0%B8%D1%80%D0%B5%D0%BD+%D0%B0%D0%BD%D0%B8%D0%BC%D0%B5&sca_esv=1");
  assert.equal(r.kind, "search");
  assert.deepEqual(r.ref, { q: "фрирен аниме", engine: "Google" });
  assert.equal(normalizeUrl("https://www.google.com/search?q=Frieren&ei=1"), normalizeUrl("https://google.com/search?q=frieren&ei=2"));
  assert.notEqual(normalizeUrl("https://google.com/search?q=a"), normalizeUrl("https://google.com/search?q=b"));
  assert.equal(searchOf("https://ya.ru/search/?text=погода").engine, "Яндекс");
  assert.equal(searchOf("https://yandex.ru/search/?text=x").q, "x");
  assert.equal(searchOf("https://www.google.com/maps"), null);
  assert.equal(siteLabel({ site: "file" }), "Файлы на компьютере");
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

// ---------------------------------------------------------------- новые сайты: адреса
t("AniLibria / AniLiberty: тайтл, старые адреса и зеркала склеиваются по коду", () => {
  const r = recognize("https://aniliberty.top/anime/releases/toaru-anbu-no-item");
  assert.equal(r.provider, "anilibria");
  assert.equal(r.kind, "anime");
  assert.deepEqual(r.ref, { alias: "toaru-anbu-no-item", api: "https://aniliberty.top" });
  assert.equal(recognize("https://anilibria.top/anime/releases/toaru-anbu-no-item").ref.api, "https://anilibria.top");
  // .wtf и старый anilibria.tv своего API не имеют — спрашиваем aniliberty.top
  assert.equal(recognize("https://anilibria.tv/release/toaru-anbu-no-item.html").ref.api, "https://aniliberty.top");
  const k = normalizeUrl("https://aniliberty.top/anime/releases/toaru-anbu-no-item");
  assert.equal(k, "anilibria:toaru-anbu-no-item");
  for (const u of [
    "https://anilibria.top/anime/releases/release/toaru-anbu-no-item",
    "https://www.anilibria.wtf/anime/releases/toaru-anbu-no-item/",
    "https://anilibria.tv/release/toaru-anbu-no-item.html",
    "https://aniliberty.top/anime/releases/Toaru-Anbu-no-Item?utm_source=tg",
  ])
    assert.equal(normalizeUrl(u), k, u);
  assert.equal(siteTitle("aniliberty.top"), "AniLibria");
  assert.equal(providerForSite("anilibria.top"), "anilibria");
});
t("AniLibria: серия — отдельно от тайтла; списки и подстраницы — обычные страницы", () => {
  const e = recognize("https://aniliberty.top/anime/video/episode/a2f90072-763b-4e24-8e6a-f5074c420e80");
  assert.equal(e.kind, "anime");
  assert.equal(e.kindLabel, "Серия аниме");
  assert.equal(e.ref.episode, "a2f90072-763b-4e24-8e6a-f5074c420e80");
  assert.notEqual(e.key, recognize("https://aniliberty.top/anime/releases/toaru-anbu-no-item").key);
  for (const u of ["https://aniliberty.top/anime/releases/latest", "https://aniliberty.top/anime/catalog", "https://aniliberty.top/anime/schedule", "https://aniliberty.top/anime/releases/x/torrents", "https://aniliberty.top/anime/releases/x?page=2"]) {
    const r = recognize(u);
    assert.equal(r.kind, "page", u);
    assert.equal(r.provider, "page", u);
  }
});
t("MangaLib: тайтл по номеру, главы и вкладки — отдельно", () => {
  const r = recognize("https://mangalib.org/ru/manga/1773--wind-breaker");
  assert.equal(r.provider, "mangalib");
  assert.equal(r.kind, "manga");
  assert.deepEqual(r.ref, { slug: "1773--wind-breaker" });
  assert.equal(normalizeUrl("https://mangalib.me/ru/manga/1773--wind-breaker?section=info"), normalizeUrl("https://mangalib.org/ru/manga/1773--wind-breaker/"));
  assert.equal(recognize("https://mangalib.org/ru/manga/1773--wind-breaker?section=chapters").kind, "page");
  assert.equal(recognize("https://mangalib.org/ru/1773--wind-breaker/read/v1/c1").kind, "page");
  assert.notEqual(normalizeUrl("https://mangalib.org/ru/1773--wind-breaker/read/v1/c1"), normalizeUrl("https://mangalib.org/ru/1773--wind-breaker/read/v1/c2"));
  assert.equal(siteTitle("mangalib.me"), "MangaLib");
});
t("Webtoons: тайтл и эпизод, Canvas отдельно", () => {
  const r = recognize("https://www.webtoons.com/en/fantasy/tower-of-god/list?title_no=95");
  assert.equal(r.provider, "webtoons");
  assert.equal(r.kind, "manga");
  assert.equal(r.kindLabel, "Вебтун");
  assert.equal(r.key, "webtoons:original:95");
  assert.equal(normalizeUrl("https://m.webtoons.com/en/fantasy/tower-of-god/list?title_no=95"), r.key);
  const e = recognize("https://www.webtoons.com/en/fantasy/tower-of-god/season-1-ep-0/viewer?title_no=95&episode_no=1");
  assert.equal(e.kindLabel, "Вебтун · эпизод");
  assert.equal(e.key, "webtoons:original:95:1");
  assert.deepEqual(e.ref, { lang: "en", genre: "fantasy", slug: "tower-of-god", no: "95", ep: "1" });
  assert.notEqual(e.key, recognize("https://www.webtoons.com/en/fantasy/tower-of-god/season-1-ep-1/viewer?title_no=95&episode_no=2").key);
  assert.equal(recognize("https://www.webtoons.com/en/canvas/my-comic/list?title_no=95").key, "webtoons:canvas:95");
  // страница 2 списка эпизодов, жанры, поиск — обычные страницы
  assert.equal(recognize("https://www.webtoons.com/en/fantasy/tower-of-god/list?title_no=95&page=2").kind, "page");
  assert.equal(recognize("https://www.webtoons.com/en/genres/fantasy").kind, "page");
});
t("Rutube: видео, shorts, канал", () => {
  const r = recognize("https://rutube.ru/video/c6cc4d620b1d4338901770a44b3e82f4/?r=wd");
  assert.equal(r.provider, "rutube");
  assert.equal(r.kind, "video");
  assert.equal(r.key, "rutube:c6cc4d620b1d4338901770a44b3e82f4");
  assert.equal(normalizeUrl("https://rutube.ru/play/embed/c6cc4d620b1d4338901770a44b3e82f4"), r.key);
  assert.equal(recognize("https://rutube.ru/shorts/c6cc4d620b1d4338901770a44b3e82f4/").kind, "short");
  assert.equal(recognize("https://rutube.ru/channel/23704195/").kind, "channel");
  assert.equal(recognize("https://rutube.ru/channel/23704195/videos/").kind, "page");
  assert.equal(recognize("https://rutube.ru/video/private/c6cc4d620b1d4338901770a44b3e82f4/?p=abc").kind, "page");
});
t("hh.ru: вакансия по номеру (регионы и параметры поиска — та же)", () => {
  const r = recognize("https://hh.ru/vacancy/137636505");
  assert.equal(r.provider, "hh");
  assert.equal(r.kind, "vacancy");
  assert.equal(r.kindLabel, "Вакансия");
  assert.equal(r.icon, "💼");
  assert.equal(normalizeUrl("https://spb.hh.ru/vacancy/137636505?query=python&hhtmFrom=vacancy_search_list"), r.key);
  assert.equal(recognize("https://hh.ru/search/vacancy?text=python").kind, "page");
  assert.equal(recognize("https://hh.ru/vacancy/137636505/response").kind, "page");
  assert.equal(siteTitle("spb.hh.ru"), "hh.ru");
});
t("Ozon: товар по номеру", () => {
  const r = recognize("https://www.ozon.ru/product/smartfon-apple-iphone-15-128gb-chernyy-1234567890/?advert=abc&avtc=1");
  assert.equal(r.provider, "ozon");
  assert.equal(r.kind, "product");
  assert.equal(r.key, "ozon:1234567890");
  assert.equal(normalizeUrl("https://ozon.ru/product/1234567890/"), r.key);
  assert.equal(recognize("https://www.ozon.ru/product/1234567890/reviews/").kind, "page");
  assert.equal(recognize("https://www.ozon.ru/category/smartfony-15502/").kind, "page");
  assert.equal(siteTitle("ozon.ru"), "Ozon");
});
t("прежние сайты распознаются как раньше", () => {
  assert.equal(recognize("https://shikimori.one/animes/52991-frieren").kind, "anime");
  assert.equal(recognize("https://www.youtube.com/watch?v=dQw4w9WgXcQ").kind, "video");
  assert.equal(recognize("https://github.com/o/r").kind, "repo");
  assert.equal(providerForSite("example.com"), null);
});

// ---------------------------------------------------------------- новые сайты: разбор ответов
t("разбор HTML без DOM: метатеги, сущности, schema.org", () => {
  assert.equal(decodeEntities("a&mdash;b &amp; &#39;c&#x27; &laquo;д&raquo; &unknown;"), "a—b & 'c' «д» &unknown;");
  const m = metaTags(`<head><title> A &amp; B </title><meta property="og:title" content="T1"><meta content='D' name=description><meta property="og:title" content="T2"></head>`);
  assert.equal(m.title, "A & B");
  assert.equal(m["og:title"], "T1");
  assert.equal(m.description, "D");
  assert.deepEqual(jsonLd(`<script type="application/ld+json">{"@graph":[{"@type":"A"}]}</script><script type="application/ld+json">{битый</script>`).map((o) => o["@type"] || "graph"), ["graph", "A"]);
  assert.equal(duration(3725), "1:02:05");
  assert.equal(duration(65), "1:05");
  assert.equal(duration(0), "");
});
t("AniLiberty API: тайтл и серия (образец ответа)", () => {
  const p = anilibriaPatch(fixtureJSON("anilibria-release.json"), "https://aniliberty.top");
  assert.equal(p.title, "Некий ITEM тёмной стороны");
  assert.equal(p.meta, "осень 2026 · ТВ, 7 эп. · выходит · ★ 7.7 · фантастика, экшен");
  assert.ok(p.description.startsWith("История разворачивается в Академии-сити"));
  assert.ok(p.description.length <= 600);
  assert.equal(p.image, "https://aniliberty.top/storage/releases/posters/10329/HkOfY3XFdQytm3vAzpaQDoSX1vOQt1Hv.jpg");
  const e = fixtureJSON("anilibria-episode.json");
  const s = anilibriaPatch(e.release, "https://anilibria.top", e);
  assert.equal(s.title, "Некий ITEM тёмной стороны — серия 1");
  assert.ok(s.meta.startsWith("«ITEM» · осень 2026"));
  assert.ok(s.image.startsWith("https://anilibria.top/storage/"));
});
t("MangaLib API и запасные метатеги (образцы)", () => {
  const p = mangalibPatch(fixtureJSON("mangalib-title.json").data);
  assert.equal(p.title, "Ветролом");
  assert.equal(p.meta, "2013 · манхва, 561 гл. · выпуск прекращён · JO Yongseok · боевик, драма, комедия");
  assert.ok(p.description.startsWith("Манхва «Ветролом» — драма"));
  assert.equal(p.image, "https://cover.mangalib.me/uploads/cover/wind-breaker/cover/1879304e-ac22-4ab9-a41c-69a4dbcecfd8.jpg");
  const f = mangalibMetaPatch(metaTags(fixture("mangalib-page.html")));
  assert.equal(f.title, "Ветролом / Wind Breaker");
  assert.ok(f.description.startsWith("Манхва «Ветролом»"));
  assert.ok(f.image.endsWith(".jpg"));
});
t("Webtoons: страница тайтла и эпизода (образцы)", () => {
  const p = webtoonPatch(fixture("webtoons-title.html"), { genre: "fantasy" });
  assert.equal(p.title, "Tower of God");
  assert.equal(p.meta, "SIU · фэнтези · 1.3B просмотров · 4.2M подписчиков");
  assert.ok(p.description.includes("Whatever you desire—it's here."));
  assert.ok(p.image.startsWith("https://swebtoon-phinf.pstatic.net/"));
  const e = webtoonPatch(fixture("webtoons-episode.html"), { genre: "fantasy", ep: "1" });
  assert.equal(e.title, "Tower of God - [Season 1] Ep. 0");
  assert.equal(e.meta, "эпизод 1 · SIU · фэнтези");
  assert.equal(webtoonPatch("<html></html>", { genre: "slice-of-life" }).meta, "повседневность");
});
t("Rutube API (образец по схеме ответа)", () => {
  const p = rutubePatch(fixtureJSON("rutube-video.json"));
  assert.equal(p.title, "Как устроен космический телескоп «Джеймс Уэбб»");
  assert.equal(p.meta, "Научпоп · 1:02:05 · 15 тыс. просмотров · 2024 · Наука");
  assert.equal(p.description, "Рассказываем, как устроен телескоп и что он уже увидел.");
  assert.equal(rutubePatch({ title: "Эфир", is_livestream: true }).meta, "трансляция");
});
t("hh.ru: страница вакансии (образцы; API гостям закрыт)", () => {
  const a = hhPagePatch(fixture("hh-vacancy.html"));
  assert.equal(a.title, "Python разработчик");
  assert.equal(a.meta, "Газпром информ · Санкт-Петербург · опыт 3–6 лет"); // «не указана» и «на месте» не пишем
  assert.ok(a.description.startsWith('ООО "Газпром информ" - аккредитованная IT компания'));
  assert.ok(!/[<>]/.test(a.description));
  const b = hhPagePatch(fixture("hh-vacancy-remote.html"));
  assert.equal(b.title, "Middle+/Senior Python Developer (FastAPI)");
  assert.equal(b.meta, "evrone.ru · до 300 000 ₽ за месяц · Москва · удалённо · опыт более 6 лет");
  // без schema.org — по og:title
  const c = hhPagePatch('<meta property="og:title" content="Вакансия Курьер в Казани, работа в компании Ромашка"><meta property="og:description" content="Зарплата: от 50000 до 80000 ₽ за месяц. Казань.">');
  assert.equal(c.title, "Курьер");
  assert.equal(c.meta, "Ромашка · от 50 000 до 80 000 ₽ за месяц");
  // проверка «вы не робот» / вход — не вакансия
  assert.equal(hhPagePatch("<html><head><title>Похоже, нет соединения</title></head><body></body></html>"), null);
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
t("эмодзи не режутся пополам (бот и Telegram не принимают «половинки»)", () => {
  const s = "a".repeat(138) + "😀😀😀";
  const c = clip(s, 140);
  assert.ok(c.isWellFormed ? c.isWellFormed() : !/[\ud800-\udbff](?![\udc00-\udfff])/.test(c), "в обрезке нет половинки эмодзи");
  const body = JSON.stringify(payload("list", [{ url: "https://x.ru", title: "т", description: s, kindLabel: "К", icon: "🎬" }]));
  assert.ok(!/\\ud83d(?!\\ud)/i.test(body), "в запросе нет одиночного суррогата");
  assert.ok(!sendable({ url: "https://x.ru/a b" }), "адрес с пробелом — не отправляем");
});
t("пачки списка на 5000 ссылок считаются быстро", () => {
  const big = Array.from({ length: 5000 }, (_, i) => ({ id: String(i), url: "https://x.ru/" + i, title: "т".repeat(80), description: "ж".repeat(300), kindLabel: "К", icon: "🔗" }));
  const t0 = Date.now();
  const parts = batches("list", big);
  assert.ok(Date.now() - t0 < 600, `долго: ${Date.now() - t0} мс`);
  assert.equal(parts.flat().length, 5000);
  assert.ok(parts.every((p) => bodySize(payload("list", p, "x".repeat(120))) <= BODY_MAX));
});
t("дубли открытых вкладок: остаётся закреплённая, активная или последняя", () => {
  const tabs = [
    { id: 1, url: "https://shikimori.one/animes/52991-frieren", lastAccessed: 10 },
    { id: 2, url: "https://shikimori.io/animes/52991", lastAccessed: 30 },
    { id: 3, url: "https://shikimori.one/animes/52991#comments", lastAccessed: 20 },
    { id: 4, url: "https://x.ru/a", pinned: true, lastAccessed: 1 },
    { id: 5, url: "https://x.ru/a", lastAccessed: 99 },
    { id: 6, url: "https://y.ru/", lastAccessed: 5 },
  ];
  const { close, groups } = findDuplicates(tabs, normalizeUrl);
  assert.equal(groups, 2);
  assert.deepEqual(close.map((t) => t.id).sort(), [1, 3, 5]); // осталась последняя (2) и закреплённая (4)
  const act = findDuplicates([{ id: 7, url: "https://z.ru", active: true, lastAccessed: 1 }, { id: 8, url: "https://z.ru", lastAccessed: 9 }], normalizeUrl);
  assert.deepEqual(act.close.map((t) => t.id), [8]); // активную не закрываем
});
t("отметки: подписи по типу страницы", () => {
  assert.equal(markLabel("doing", "anime"), "Смотрю");
  assert.equal(markLabel("done", "manga"), "Прочитал");
  assert.equal(markLabel("done", "repo"), "Готово");
  assert.equal(markLabel("want", "video"), "Хочу");
});
t("ключ пачки списка: тот же список — тот же ключ, другой — другой", () => {
  const a = payload("list", [{ url: "https://a.ru", title: "A" }, { url: "https://b.ru", title: "B" }], "Зима");
  const b = payload("list", [{ url: "https://a.ru", title: "A2" }, { url: "https://b.ru", title: "B2" }], "Зима");
  const c = payload("list", [{ url: "https://a.ru", title: "A" }], "Зима");
  assert.equal(a.batchKey, b.batchKey); // описания уточнились — список тот же
  assert.notEqual(a.batchKey, c.batchKey);
  assert.equal(payload("each", [{ url: "https://a.ru" }]).batchKey, undefined);
  assert.match(batchKey(["https://a.ru"]), /^tc-[0-9a-z]+$/);
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
