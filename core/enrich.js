// Подробности о ссылке: открытые API известных сайтов и метатеги страницы.
// Работает на странице расширения (нужны fetch с host_permissions и DOMParser).
// Разбор ответов (shikiPatch, jikanPatch…) — чистые функции, проверяются в node.

import { kindFromOgType, kindMeta, siteOf } from "./url.js";
import { clip } from "./format.js";

const SHIKI_KIND = {
  tv: "TV-сериал", movie: "фильм", ova: "OVA", ona: "ONA", special: "спешл", tv_special: "TV-спешл",
  music: "клип", pv: "проморолик", cm: "реклама",
  manga: "манга", manhwa: "манхва", manhua: "маньхуа", one_shot: "ваншот", doujin: "додзинси",
  light_novel: "ранобэ", novel: "новелла",
};
const SHIKI_STATUS = { anons: "анонс", ongoing: "выходит", released: "вышло", paused: "на паузе", discontinued: "прекращено" };

/** BB-коды и [[ссылки]] Shikimori → чистый текст. */
export function stripBB(s) {
  return String(s || "")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/\[(character|anime|manga|ranobe|person|url)[^\]]*\]([^[]*)\[\/\1\]/gi, "$2")
    .replace(/\[(spoiler|quote)[^\]]*\][\s\S]*?\[\/\1\]/gi, "")
    .replace(/\[\/?[a-z_]+(=[^\]]*)?\]/gi, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function joinMeta(parts) {
  return parts.filter((p) => p && String(p).trim()).join(" · ");
}

function year(s) {
  const m = String(s || "").match(/(\d{4})/);
  return m ? m[1] : "";
}

function score(v) {
  const n = Number(v);
  return n > 0 ? `★ ${n.toFixed(n >= 10 ? 0 : 1).replace(/\.0$/, "")}` : "";
}

function count(n, word) {
  return n ? `${n} ${word}` : "";
}

export function shikiPatch(section, d, origin) {
  const img = d.image && d.image.original && !/missing/.test(d.image.original) ? new URL(d.image.original, origin).href : "";
  const desc = clip(stripBB(d.description || d.description_html || ""), 600);
  if (section === "characters") {
    const from = (d.animes && d.animes[0]) || (d.mangas && d.mangas[0]);
    const src = from ? `из «${from.russian || from.name}»` : "";
    return { title: d.russian || d.name, meta: joinMeta([d.russian && d.name !== d.russian ? d.name : "", src]), description: desc, image: img };
  }
  if (section === "people") {
    return { title: d.russian || d.name, meta: joinMeta([d.russian && d.name, d.job_title]), description: desc, image: img };
  }
  const isAnime = section === "animes";
  const len = isAnime
    ? count(d.episodes || d.episodes_aired, "эп.")
    : joinMeta([count(d.volumes, "т."), count(d.chapters, "гл.")]).replace(" · ", ", ");
  const kind = [SHIKI_KIND[d.kind] || "", len].filter(Boolean).join(", ");
  const genres = (d.genres || [])
    .map((g) => (g.russian || g.name || "").toLowerCase())
    .filter(Boolean)
    .slice(0, 3)
    .join(", ");
  const studio = isAnime ? ((d.studios || [])[0] || {}).name : ((d.publishers || [])[0] || {}).name;
  return {
    title: d.russian || d.name,
    meta: joinMeta([year(d.aired_on || d.released_on), kind, SHIKI_STATUS[d.status], studio, score(d.score), genres]),
    description: desc,
    image: img,
  };
}

const JIKAN_STATUS = {
  "Finished Airing": "вышло", "Currently Airing": "выходит", "Not yet aired": "анонс",
  Finished: "вышло", Publishing: "выходит", "On Hiatus": "на паузе", Discontinued: "прекращено",
};

export function jikanPatch(section, d) {
  const img = (d.images && d.images.jpg && (d.images.jpg.large_image_url || d.images.jpg.image_url)) || "";
  if (section === "character" || section === "people") {
    return { title: d.name, meta: joinMeta([d.name_kanji || d.given_name]), description: clip(d.about, 600), image: img };
  }
  const len = section === "anime" ? count(d.episodes, "эп.") : joinMeta([count(d.volumes, "т."), count(d.chapters, "гл.")]).replace(" · ", ", ");
  const genres = (d.genres || []).map((g) => g.name).slice(0, 3).join(", ");
  return {
    title: d.title_english && d.title_english !== d.title ? `${d.title} (${d.title_english})` : d.title,
    meta: joinMeta([d.year || year(d.aired && d.aired.from) || year(d.published && d.published.from), [d.type, len].filter(Boolean).join(", "), JIKAN_STATUS[d.status], score(d.score), genres]),
    description: clip(d.synopsis, 600),
    image: img,
  };
}

const ANILIST_STATUS = { FINISHED: "вышло", RELEASING: "выходит", NOT_YET_RELEASED: "анонс", CANCELLED: "отменено", HIATUS: "на паузе" };

export function anilistPatch(section, d) {
  if (section === "character" || section === "staff") {
    const from = d.media && d.media.nodes && d.media.nodes[0];
    return {
      title: d.name.full,
      meta: joinMeta([d.name.native, from ? `из «${from.title.romaji}»` : (d.primaryOccupations || []).join(", ")]),
      description: clip(stripBB(d.description), 600),
      image: (d.image && d.image.large) || "",
    };
  }
  const len = section === "anime" ? count(d.episodes, "эп.") : joinMeta([count(d.volumes, "т."), count(d.chapters, "гл.")]).replace(" · ", ", ");
  const t = d.title || {};
  return {
    title: t.english && t.english !== t.romaji ? `${t.romaji} (${t.english})` : t.romaji || t.english,
    meta: joinMeta([d.seasonYear || (d.startDate && d.startDate.year), [d.format, len].filter(Boolean).join(", "), ANILIST_STATUS[d.status], d.averageScore ? `★ ${(d.averageScore / 10).toFixed(1)}` : "", (d.genres || []).slice(0, 3).join(", ").toLowerCase()]),
    description: clip(stripBB(d.description), 600),
    image: (d.coverImage && d.coverImage.large) || "",
  };
}

function kFormat(n) {
  n = Number(n) || 0;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, "")} тыс.`;
  return String(n);
}

export function githubPatch(kind, d) {
  if (kind === "repo") {
    return {
      title: d.full_name,
      meta: joinMeta([`★ ${kFormat(d.stargazers_count)}`, d.language, (d.topics || []).slice(0, 3).join(", "), d.archived ? "в архиве" : ""]),
      description: clip(d.description, 600),
    };
  }
  if (kind === "issue" || kind === "pr") {
    const state = d.pull_request && d.pull_request.merged_at ? "слит" : d.state === "open" ? "открыт" : "закрыт";
    return {
      title: `${d.title} #${d.number}`,
      meta: joinMeta([state, d.comments ? `${d.comments} комм.` : "", d.user && d.user.login]),
      description: clip(String(d.body || "").replace(/[#*`>_]/g, " "), 600),
    };
  }
  return {
    title: d.name ? `${d.name} (${d.login})` : d.login,
    meta: joinMeta([d.public_repos ? `${d.public_repos} репоз.` : "", d.followers ? `${kFormat(d.followers)} подписчиков` : "", d.location]),
    description: clip(d.bio, 600),
  };
}

// ---------------------------------------------------------------- HTML без DOM (проверяется в node)

const ENT = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…", laquo: "«", raquo: "»",
  rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", bull: "•", middot: "·", copy: "©", reg: "®", trade: "™", times: "×",
};

/** &amp; &mdash; &#39; &#x27; → символы. */
export function decodeEntities(s) {
  return String(s || "").replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
    }
    return ENT[e.toLowerCase()] ?? all;
  });
}

const stripTags = (s) =>
  String(s || "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/?(p|div|li|br|ul|ol|h\d)\b[^>]*>/gi, " ")
    .replace(/<\/?[a-z][^>]*>/gi, "");

/** HTML → чистый текст (описание вакансии и т.п.). Дважды: разметка бывает заэкранирована ещё раз. */
export function htmlText(s) {
  return stripTags(decodeEntities(stripTags(s)))
    .replace(/\s+/g, " ")
    .trim();
}

/** Метатеги страницы из текста HTML: {"og:title": …, "description": …, title: <title>}. */
export function metaTags(html) {
  const head = String(html || "").slice(0, 300000);
  const out = {};
  for (const tag of head.match(/<meta\b[^>]*>/gi) || []) {
    const attr = (n) => {
      const m = tag.match(new RegExp(`\\s${n}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
      return m ? (m[1] ?? m[2] ?? m[3]) : null;
    };
    const k = attr("property") || attr("name") || attr("itemprop");
    const v = attr("content");
    if (k && v != null && !(k.toLowerCase() in out)) out[k.toLowerCase()] = decodeEntities(v).trim();
  }
  const t = head.match(/<title[^>]*>([^<]*)<\/title>/i);
  if (t) out.title = decodeEntities(t[1]).replace(/\s+/g, " ").trim();
  return out;
}

/** Объекты schema.org из <script type="application/ld+json"> (с @graph и массивами — плоским списком). */
export function jsonLd(html) {
  const out = [];
  const re = /<script[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      out.push(v);
      if (v["@graph"]) walk(v["@graph"]);
    }
  };
  let m;
  while ((m = re.exec(String(html || "")))) {
    try {
      walk(JSON.parse(m[1].trim()));
    } catch (e) {
      /* битый JSON на странице — пропускаем */
    }
  }
  return out;
}

const ldOf = (list, type) => list.find((o) => [].concat(o["@type"] || []).some((t) => String(t).toLowerCase() === type));

// ---------------------------------------------------------------- AniLibria / AniLiberty

const ALIB_TYPE = { TV: "ТВ", ONA: "ONA", OVA: "OVA", WEB: "web", MOVIE: "фильм", SPECIAL: "спешл", DORAMA: "дорама" };

/** Ответ api/v1/anime/releases/<код> (или release внутри серии) → поля записи. ep — серия, если ссылка на неё. */
export function anilibriaPatch(d, api, ep) {
  d = d || {};
  const name = d.name || {};
  const total = d.episodes_total || (Array.isArray(d.episodes) ? d.episodes.length : 0);
  const type = (d.type && (ALIB_TYPE[d.type.value] || d.type.description || d.type.value)) || "";
  const season = d.season && d.season.description ? `${d.season.description.toLowerCase()} ${d.year || ""}`.trim() : d.year;
  const status = d.is_ongoing ? "выходит" : d.is_in_production ? "анонс" : total ? "вышло" : "";
  const rating = d.shikimori && d.shikimori.rating ? score(d.shikimori.rating) : "";
  const genres = (d.genres || []).map((g) => String((g && g.name) || "").toLowerCase()).filter(Boolean).slice(0, 3).join(", ");
  const poster = d.poster && (d.poster.src || d.poster.preview);
  const image = poster ? new URL(poster, api).href : "";
  const meta = joinMeta([season, [type, count(total, "эп.")].filter(Boolean).join(", "), status, rating, genres]);
  const description = clip(htmlText(d.description), 600);
  const title = name.main || name.english || "";
  if (ep) {
    // без названия тайтла или номера серии название вкладки лучше, чем « — серия undefined»
    const epTitle = title && ep.ordinal != null && ep.ordinal !== "" ? `${title} — серия ${ep.ordinal}` : "";
    return { title: epTitle, meta: joinMeta([ep.name ? `«${ep.name}»` : "", meta]), description, image };
  }
  return { title, meta, description, image };
}

// ---------------------------------------------------------------- MangaLib

/** Описание MangaLib — документ редактора ({type:"doc", content:[…]}) или строка. */
function docText(n) {
  if (!n) return "";
  if (typeof n === "string") return n;
  if (Array.isArray(n)) return n.map(docText).join(" ");
  return [n.text || "", docText(n.content)].join(" ");
}

/** Ответ api2.mangalib.me/api/manga/<id--slug> → поля записи. */
export function mangalibPatch(d) {
  d = d || {};
  const ch = d.items_count && d.items_count.uploaded;
  const kind = [d.type && String(d.type.label || "").toLowerCase(), count(ch, "гл.")].filter(Boolean).join(", ");
  const author = (d.authors || []).map((a) => a && (a.rus_name || a.name)).filter(Boolean)[0];
  const genres = (d.genres || []).map((g) => String((g && g.name) || "").toLowerCase()).filter(Boolean).slice(0, 3).join(", ");
  const rating = d.rating && (d.rating.averageFormated || d.rating.average);
  return {
    title: d.rus_name || d.eng_name || d.name,
    meta: joinMeta([year(d.releaseDate), kind, d.status && String(d.status.label || "").toLowerCase(), author, score(rating), genres]),
    description: clip(htmlText(docText(d.summary)), 600),
    image: (d.cover && (d.cover.default || d.cover.md)) || "",
  };
}

/** Метатеги страницы MangaLib (если API не отдал тайтл гостю, например 18+). */
export function mangalibMetaPatch(tags) {
  return {
    title: String(tags["og:title"] || "").replace(/\s+читать\s+[а-яё]+\s+онлайн\s*$/i, "").trim(),
    description: clip(String(tags["og:description"] || "").replace(/^Читать [^.]*?онлайн на русском\.\s*/i, ""), 600),
    image: tags["og:image"] || "",
  };
}

// ---------------------------------------------------------------- Webtoons

const WT_GENRE = {
  action: "экшен", romance: "романтика", fantasy: "фэнтези", comedy: "комедия", drama: "драма", thriller: "триллер",
  horror: "хоррор", "slice-of-life": "повседневность", sf: "научная фантастика", "sci-fi": "научная фантастика",
  supernatural: "сверхъестественное", mystery: "детектив", sports: "спорт", historical: "история", heartwarming: "трогательное",
  superhero: "супергерои", "romantic-fantasy": "романтическое фэнтези", "graphic-novel": "графический роман",
  informative: "познавательное", school: "школа", "martial-arts": "боевые искусства", "time-slip": "путешествия во времени",
  "web-novel": "веб-новелла", canvas: "Canvas", challenge: "Canvas",
};

/** Страница Webtoons (метатеги + счётчики) → поля записи. ref — из recognize. */
export function webtoonPatch(html, ref = {}) {
  const tags = metaTags(html);
  const author = tags["com-linewebtoon:webtoon:author"] || tags["com-linewebtoon:episode:author"] || "";
  const genre = WT_GENRE[String(ref.genre || "").toLowerCase()] || String(ref.genre || "").replace(/-/g, " ");
  const cnt = (cls) => {
    const m = String(html).match(new RegExp(`class="${cls}"[^>]*>[^<]*</span>\\s*<em class="cnt">([^<]+)</em>`));
    return m ? m[1].trim() : "";
  };
  const views = cnt("ico_view");
  const subs = cnt("ico_subscribe");
  return {
    title: tags["og:title"] || "",
    meta: joinMeta([ref.ep ? `эпизод ${ref.ep}` : "", author, genre, views ? `${views} просмотров` : "", subs ? `${subs} подписчиков` : ""]),
    description: clip(tags["og:description"], 600),
    image: tags["og:image"] || "",
  };
}

// ---------------------------------------------------------------- Rutube

export function duration(sec) {
  sec = Math.round(Number(sec) || 0);
  if (!sec) return "";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = String(sec % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** Ответ rutube.ru/api/video/<id>/ → поля записи. */
export function rutubePatch(d) {
  d = d || {};
  const hits = Number(d.hits) || 0;
  return {
    title: d.title || "",
    meta: joinMeta([
      d.author && d.author.name,
      d.is_livestream ? "трансляция" : duration(d.duration),
      hits ? `${kFormat(hits)} просмотров` : "",
      year(d.publication_ts || d.created_ts),
      d.category && d.category.name,
    ]),
    description: clip(htmlText(d.description), 600),
    image: d.thumbnail_url || "",
  };
}

// ---------------------------------------------------------------- hh.ru

// API hh.ru (api.hh.ru/vacancies/<id>) гостям закрыт (403 forbidden) — всё берём со страницы вакансии:
// schema.org JobPosting (должность, компания, город, описание) и метатеги (зарплата, опыт).
const thousands = (s) => String(s).replace(/\d{4,}/g, (n) => n.replace(/\B(?=(\d{3})+(?!\d))/g, " "));

/** Страница вакансии hh.ru → поля записи. null — это не страница вакансии (вход, проверка). */
export function hhPagePatch(html) {
  const tags = metaTags(html);
  const j = ldOf(jsonLd(html), "jobposting");
  const og = String(tags["og:description"] || tags.description || "").replace(/\s+/g, " "); // неразрывные пробелы — обычными
  const part = (name) => {
    const m = og.match(new RegExp(`${name}:\\s*([^.]+)\\.`));
    return m ? m[1].trim() : "";
  };
  const salary = part("Зарплата");
  const exp = part("Требуемый опыт");
  // «Формат работы: удалённо / гибрид» — в разметке страницы; «на месте работодателя» не пишем
  const fm = String(html).match(/Формат работы:\s*(?:<[^>]+>\s*)*([^<]+)</);
  const fmText = fm ? decodeEntities(fm[1]).replace(/\s+/g, " ").trim() : "";
  const format = /на месте/i.test(fmText) ? "" : fmText;
  let title = j ? decodeEntities(j.title || "") : "";
  let company = j && j.hiringOrganization ? decodeEntities(j.hiringOrganization.name || "") : "";
  let city = "";
  if (j) {
    const loc = [].concat(j.jobLocation || [])[0] || {};
    const addr = loc.address || {};
    city = typeof addr === "string" ? addr : addr.addressLocality || "";
  }
  if (!title) {
    // «Вакансия Python разработчик в Москве, работа в компании Х». Город — с заглавной и последним
    // перед запятой, иначе «Менеджер в отдел продаж в Москве» обрезалось бы до «Менеджер».
    const m = String(tags["og:title"] || "").match(
      /^Вакансия\s+(.+?)(?:\s+в\s+[А-ЯЁA-Z][^,\s]*(?:[\s-]+[А-ЯЁA-Z][^,\s]*)*)?,\s+работа в компании\s+(.+)$/
    );
    if (!m) return null;
    [, title, company] = m;
  }
  return {
    title,
    meta: joinMeta([
      company,
      salary && !/не указана/i.test(salary) ? thousands(salary) : "",
      city,
      format,
      exp ? `опыт ${exp}` : "",
    ]),
    description: clip(htmlText(j && j.description), 600),
  };
}

/** Метатеги из HTML (og:*, description, twitter:*). */
export function parseMeta(doc) {
  const pick = (...sels) => {
    for (const s of sels) {
      const el = doc.querySelector(s);
      const v = el && (el.getAttribute("content") || el.textContent);
      if (v && v.trim()) return v.trim();
    }
    return "";
  };
  return {
    title: pick('meta[property="og:title"]', 'meta[name="twitter:title"]', "title"),
    description: pick('meta[property="og:description"]', 'meta[name="description"]', 'meta[name="twitter:description"]'),
    image: pick('meta[property="og:image"]', 'meta[name="twitter:image"]'),
    ogType: pick('meta[property="og:type"]'),
    siteName: pick('meta[property="og:site_name"]'),
  };
}

// ---------------------------------------------------------------- сеть

const GAP = {
  shikimori: 350, mal: 1100, anilist: 800, github: 400, wikipedia: 150, youtube: 150, page: 250, habr: 300,
  anilibria: 400, mangalib: 600, webtoons: 500, rutube: 300, hh: 1000,
};
const lastHit = new Map();

async function polite(key, gap) {
  const now = Date.now();
  const at = Math.max(now, (lastHit.get(key) || 0) + gap);
  lastHit.set(key, at);
  if (at > now) await new Promise((r) => setTimeout(r, at - now));
}

async function getJSON(url, init = {}, timeout = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { ...init, signal: ctl.signal });
    if (r.status === 429) throw Object.assign(new Error("rate"), { retry: true });
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// Адреса, которые не запрашиваем повторно: локальные и частные сети, выход/отписка/токены
// (повторный GET мог бы что-то сделать от вашего имени).
export function safeToFetch(url) {
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return false;
  }
  if (!/^https?:$/.test(u.protocol)) return false;
  const h = u.hostname;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h === "[::1]") return false;
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
  if (/logout|log-out|signout|sign-out|unsubscribe|confirm|verify|activate|delete|token=|code=|key=|auth=|session=/i.test(u.pathname + u.search)) return false;
  return true;
}

/** Текст HTML-страницы, запрошенной гостем, или "" (увело на другой сайт, не HTML, опасный адрес). */
async function pageHtml(url) {
  if (!safeToFetch(url)) return "";
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  try {
    // без ваших куки: страницу запрашиваем как гость
    const r = await fetch(url, { credentials: "omit", signal: ctl.signal, headers: { Accept: "text/html" } });
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
    // гостя перекинуло на другой сайт (вход в Google, Notion, Jira) — это не та страница
    if (r.redirected && siteOf(r.url) !== siteOf(url)) return "";
    const type = r.headers.get("content-type") || "";
    if (!/html/.test(type)) return "";
    return (await r.text()).slice(0, 600000);
  } finally {
    clearTimeout(t);
  }
}

async function pageMeta(url) {
  const text = await pageHtml(url);
  if (!text) return { doc: null, meta: {} };
  const doc = new DOMParser().parseFromString(text, "text/html");
  return { doc, meta: parseMeta(doc) };
}

const ANILIST_Q = {
  media: `query($id:Int){Media(id:$id){title{romaji english}format episodes volumes chapters status seasonYear startDate{year}averageScore genres description(asHtml:false)coverImage{large}}}`,
  character: `query($id:Int){Character(id:$id){name{full native}description(asHtml:false)image{large}media(perPage:1){nodes{title{romaji}}}}}`,
  staff: `query($id:Int){Staff(id:$id){name{full native}primaryOccupations description(asHtml:false)image{large}}}`,
};

// поля, которые API MangaLib принимает (неизвестное поле — ошибка 422 на весь запрос)
const MANGALIB_FIELDS = ["summary", "genres", "authors", "releaseDate", "format", "chap_count"];

/** Подробности для одной ссылки. rec — результат recognize(); возвращает поля для записи. */
export async function fetchDetails(item) {
  const ref = item.ref || {};
  const p = item.provider;
  if (p === "shikimori") {
    await polite("shikimori", GAP.shikimori);
    const d = await getJSON(`${ref.origin}/api/${ref.section}/${ref.id}`);
    return shikiPatch(ref.section, d, ref.origin);
  }
  if (p === "mal") {
    await polite("mal", GAP.mal);
    const sec = ref.section === "people" ? "people" : ref.section === "character" ? "characters" : ref.section;
    const d = await getJSON(`https://api.jikan.moe/v4/${sec}/${ref.id}`);
    return jikanPatch(ref.section, d.data || {});
  }
  if (p === "anilist") {
    await polite("anilist", GAP.anilist);
    const q = ref.section === "character" ? ANILIST_Q.character : ref.section === "staff" ? ANILIST_Q.staff : ANILIST_Q.media;
    const d = await getJSON("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ query: q, variables: { id: Number(ref.id) } }),
    });
    const data = (d.data && (d.data.Media || d.data.Character || d.data.Staff)) || {};
    return anilistPatch(ref.section, data);
  }
  if (p === "youtube") {
    await polite("youtube", GAP.youtube);
    const d = await getJSON(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(item.url)}`);
    const out = { title: d.title, meta: joinMeta([d.author_name]), image: `https://i.ytimg.com/vi/${ref.id}/hqdefault.jpg` };
    try {
      // полный адрес, а не youtu.be: короткая ссылка перенаправляет на другой хост
      const { meta } = await pageMeta(`https://www.youtube.com/watch?v=${ref.id}`);
      if (meta.description) out.description = clip(meta.description, 600);
    } catch (e) {
      /* описание — не обязательно */
    }
    return out;
  }
  if (p === "github") {
    await polite("github", GAP.github);
    const api =
      item.kind === "repo"
        ? `https://api.github.com/repos/${ref.owner}/${ref.repo}`
        : item.kind === "user"
          ? `https://api.github.com/users/${ref.owner}`
          : `https://api.github.com/repos/${ref.owner}/${ref.repo}/issues/${ref.num}`;
    try {
      const d = await getJSON(api, { headers: { Accept: "application/vnd.github+json" } });
      return githubPatch(item.kind, d);
    } catch (e) {
      if (e.status !== 403 && e.status !== 429 && !e.retry) throw e;
      // без ключа GitHub даёт 60 запросов в час — дальше берём метатеги страницы
    }
  }
  if (p === "wikipedia") {
    await polite("wikipedia", GAP.wikipedia);
    const d = await getJSON(`https://${ref.lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(ref.title)}`);
    return {
      title: d.title,
      meta: joinMeta([d.description]),
      description: clip(d.extract, 600),
      image: (d.thumbnail && d.thumbnail.source) || "",
    };
  }
  if (p === "anilibria") {
    await polite("anilibria", GAP.anilibria);
    if (ref.episode) {
      const e = await getJSON(`${ref.api}/api/v1/anime/releases/episodes/${ref.episode}`);
      return anilibriaPatch(e.release || {}, ref.api, e);
    }
    const d = await getJSON(`${ref.api}/api/v1/anime/releases/${encodeURIComponent(ref.alias)}`);
    return anilibriaPatch(d, ref.api);
  }
  if (p === "mangalib") {
    await polite("mangalib", GAP.mangalib);
    try {
      const fields = MANGALIB_FIELDS.map((f) => `fields[]=${f}`).join("&");
      const d = await getJSON(`https://api2.mangalib.me/api/manga/${encodeURIComponent(ref.slug)}?${fields}`);
      if (d.data && (d.data.rus_name || d.data.name)) return mangalibPatch(d.data);
    } catch (e) {
      if (e.retry) throw e;
      // тайтлы 18+ API гостю не показывает (404) — берём метатеги страницы
    }
    await polite("mangalib", GAP.mangalib);
    const html = await pageHtml(item.url);
    return html ? mangalibMetaPatch(metaTags(html)) : {};
  }
  if (p === "webtoons") {
    await polite("webtoons", GAP.webtoons);
    const html = await pageHtml(item.url);
    return html ? webtoonPatch(html, ref) : {};
  }
  if (p === "rutube") {
    await polite("rutube", GAP.rutube);
    try {
      const d = await getJSON(`https://rutube.ru/api/video/${ref.id}/?format=json`);
      if (d && d.title) return rutubePatch(d);
    } catch (e) {
      if (e.retry || e.status === 404) throw e;
      // API не ответил — ниже метатеги самой страницы видео
    }
  }
  if (p === "hh") {
    await polite("hh", GAP.hh);
    // сама вакансия, без параметров поиска (spb.hh.ru/vacancy/1?query=… — та же страница)
    const html = await pageHtml(`https://hh.ru/vacancy/${ref.id}`);
    return (html && hhPagePatch(html)) || {};
  }
  if (p === "ozon") {
    // Ozon гостю (без ваших куки) отдаёт проверку антибота с кодом 403, а не товар — не запрашиваем:
    // остаются название, описание и картинка, прочитанные с открытой вкладки при сборе
    return {};
  }
  // Хабр и любые другие сайты — метатеги страницы
  let host = "";
  try {
    host = new URL(item.url).host;
  } catch (e) {
    /* пусто */
  }
  await polite(`page:${host}`, p === "habr" ? GAP.habr : GAP.page);
  const { doc, meta } = await pageMeta(item.url);
  // название, которое вы видели во вкладке, не заменяем тем, что страница отдала гостю
  // у недогруженной вкладки «названием» бывает сам адрес (без https:// и www) — его заменяем
  const bare = (s) => String(s || "").replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/+$/, "");
  const hasTitle = item.title && bare(item.title) !== bare(item.url);
  const out = {
    title: hasTitle ? "" : meta.title,
    description: clip(meta.description, 600),
    image: meta.image && /^https?:/.test(meta.image) ? meta.image : meta.image ? new URL(meta.image, item.url).href : "",
    siteName: meta.siteName,
  };
  if (p === "habr" && doc) {
    const t = (s) => ((doc.querySelector(s) || {}).textContent || "").trim();
    out.title = (meta.title || item.title).replace(/\s*\/\s*Хабр$/, "");
    out.meta = joinMeta([t(".tm-user-info__username"), t(".tm-article-reading-time__label")]);
  } else if (!item.kindLocked) {
    // тип известен только по og:type (статья, видео, товар…)
    Object.assign(out, kindMeta(kindFromOgType(meta.ogType)));
  }
  return out;
}
