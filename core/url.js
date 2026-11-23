// Распознавание адресов: какой сайт, что за страница (аниме, манга, видео, репозиторий…)
// и чем её дополнительно описать (provider + ключ для API). Без chrome.* и без сети —
// модуль проверяется в node (tests/run.mjs).

export const KINDS = {
  anime: { icon: "🎬", label: "Аниме" },
  manga: { icon: "📖", label: "Манга" },
  ranobe: { icon: "📚", label: "Ранобэ" },
  character: { icon: "👤", label: "Персонаж" },
  person: { icon: "🧑", label: "Человек" },
  video: { icon: "▶️", label: "Видео" },
  short: { icon: "▶️", label: "Shorts" },
  playlist: { icon: "🎞️", label: "Плейлист" },
  channel: { icon: "📺", label: "Канал" },
  repo: { icon: "📦", label: "Репозиторий" },
  issue: { icon: "🐞", label: "Issue" },
  pr: { icon: "🔀", label: "Pull request" },
  user: { icon: "🧑‍💻", label: "Профиль" },
  wiki: { icon: "📘", label: "Википедия" },
  search: { icon: "🔎", label: "Поиск" },
  article: { icon: "📰", label: "Статья" },
  news: { icon: "🗞️", label: "Новость" },
  product: { icon: "🛒", label: "Товар" },
  book: { icon: "📕", label: "Книга" },
  page: { icon: "🔗", label: "Страница" },
};

export const SITE_NAMES = {
  shikimori: "Shikimori",
  mal: "MyAnimeList",
  anilist: "AniList",
  youtube: "YouTube",
  github: "GitHub",
  wikipedia: "Википедия",
  habr: "Хабр",
};

const SHIKI_HOSTS = new Set(["shikimori.one", "shikimori.me", "shikimori.org", "shikimori.io", "shiki.one"]);
const SHIKI_KIND = { animes: "anime", mangas: "manga", ranobe: "ranobe", characters: "character", people: "person" };
const GH_RESERVED = new Set([
  "settings", "marketplace", "explore", "topics", "trending", "notifications", "issues", "pulls", "login",
  "logout", "join", "features", "pricing", "orgs", "organizations", "sponsors", "about", "search", "new",
  "codespaces", "collections", "events", "apps", "security", "enterprise", "customer-stories", "readme",
  "site", "team", "home", "dashboard", "stars", "watching",
]);
// метки отслеживания — не часть адреса (дубли с ними склеиваются)
// si/feature/pp — метки только YouTube (там ссылка склеивается по id видео), на других сайтах не трогаем
const TRACKING = /^(utm_[a-z]+|fbclid|gclid|yclid|ysclid|_openstat|ref_src|igshid|mc_[a-z]+)$/i;

/** Хост без www. и m. — им группируются вкладки. */
export function siteOf(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return u.protocol.replace(":", "");
    return u.hostname.replace(/^(www|m)\./, "");
  } catch (e) {
    return "";
  }
}

/** Можно ли собирать вкладку (обычные страницы; не служебные и не само расширение). */
export function collectable(url) {
  return /^(https?|file|ftp):/i.test(url || "");
}

/**
 * Ключ для склейки дублей — осторожно, чтобы разные страницы не слились (сбор закрывает
 * вкладки-дубли!): убираются только метки отслеживания, www/m., хвостовой «/» и простой
 * якорь-закладка (#comments). Регистр пути и параметров сохраняется (bit.ly/AbC ≠ bit.ly/abc);
 * якорь-маршрут (#inbox/AAA в почте, #@user в Telegram, #/page, #!, числа) — часть адреса.
 * У известных сайтов — по id (shikimori.one/animes/52991-frieren и /animes/52991 — одно).
 */
const ANCHOR = /^#(|top|comments?|respond|reply[\w-]*|comment-\d+|content|main|section[\w-]*|toc[\w-]*|cite[\w-]*|h-[\w-]*|:~:text=.*)$/i;
function decodeHash(h) {
  try {
    return decodeURIComponent(h);
  } catch (e) {
    return h;
  }
}

export function normalizeUrl(url) {
  const r = recognize(url);
  if (r.key) return r.key;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return url;
    const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k));
    params.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const q = params.length ? "?" + new URLSearchParams(params).toString() : "";
    const path = u.pathname.replace(/\/+$/, "") || "";
    // убираем только явные закладки на странице; #inbox и #sent в почте — разные адреса
    const hash = u.hash && !ANCHOR.test(decodeHash(u.hash)) ? u.hash : "";
    return `${u.hostname.replace(/^(www|m)\./, "")}${u.port ? ":" + u.port : ""}${path}${q}${hash}`;
  } catch (e) {
    return url;
  }
}

function kindInfo(kind) {
  const k = KINDS[kind] || KINDS.page;
  return { kind, icon: k.icon, kindLabel: k.label };
}

/**
 * Что за страница. Возвращает:
 * { site, provider|null, kind, icon, kindLabel, key|null, ref|null }
 * provider — у кого спрашивать подробности (shikimori/mal/anilist/youtube/github/wikipedia/habr),
 * ref — данные для запроса (id, тип, origin…), key — постоянный ключ для склейки дублей.
 */
export function recognize(url) {
  const base = { site: siteOf(url), provider: null, key: null, ref: null, ...kindInfo("page") };
  let u;
  try {
    u = new URL(url);
  } catch (e) {
    return base;
  }
  const host = u.hostname.replace(/^(www|m)\./, "").toLowerCase();
  const path = u.pathname;
  let m;

  if (SHIKI_HOSTS.has(host)) {
    m = path.match(/^\/(animes|mangas|ranobe|characters|people)\/[a-z]*(\d+)/);
    if (m) {
      const kind = SHIKI_KIND[m[1]];
      return {
        ...base,
        ...kindInfo(kind),
        provider: "shikimori",
        ref: { section: m[1], id: m[2], origin: u.origin },
        key: `shikimori:${m[1]}:${m[2]}`,
      };
    }
    return { ...base, provider: null };
  }

  if (host === "myanimelist.net") {
    m = path.match(/^\/(anime|manga|character|people)\/(\d+)/);
    if (m) {
      const kind = { anime: "anime", manga: "manga", character: "character", people: "person" }[m[1]];
      return { ...base, ...kindInfo(kind), provider: "mal", ref: { section: m[1], id: m[2] }, key: `mal:${m[1]}:${m[2]}` };
    }
  }

  if (host === "anilist.co") {
    m = path.match(/^\/(anime|manga|character|staff)\/(\d+)/);
    if (m) {
      const kind = { anime: "anime", manga: "manga", character: "character", staff: "person" }[m[1]];
      return {
        ...base,
        ...kindInfo(kind),
        provider: "anilist",
        ref: { section: m[1], id: m[2] },
        key: `anilist:${m[1]}:${m[2]}`,
      };
    }
  }

  if (host === "youtube.com" || host === "music.youtube.com" || host === "youtu.be") {
    let id = null;
    let kind = "video";
    if (host === "youtu.be") id = path.slice(1).split("/")[0];
    else if (path === "/watch") id = u.searchParams.get("v");
    else if ((m = path.match(/^\/(shorts|live|embed)\/([\w-]{11})/))) {
      id = m[2];
      if (m[1] === "shorts") kind = "short";
    }
    if (id && /^[\w-]{11}$/.test(id)) {
      return { ...base, site: "youtube.com", ...kindInfo(kind), provider: "youtube", ref: { id }, key: `youtube:${id}` };
    }
    if (path === "/playlist" && u.searchParams.get("list")) {
      const list = u.searchParams.get("list");
      return { ...base, site: "youtube.com", ...kindInfo("playlist"), provider: "page", key: `youtube:list:${list}` };
    }
    if ((m = path.match(/^\/(@[^/]+|channel\/[\w-]+|c\/[^/]+|user\/[^/]+)/))) {
      // @имя — без учёта регистра, /channel/UC… — с учётом
      const ch = m[1].startsWith("@") ? m[1].toLowerCase() : m[1];
      return { ...base, site: "youtube.com", ...kindInfo("channel"), provider: "page", key: `youtube:${ch}` };
    }
    return base;
  }

  if (host === "github.com") {
    const parts = path.split("/").filter(Boolean);
    if (parts.length >= 1 && !GH_RESERVED.has(parts[0].toLowerCase())) {
      const [owner, repo, section, num] = parts;
      if (repo && (section === "issues" || section === "pull") && /^\d+$/.test(num || "")) {
        const kind = section === "pull" ? "pr" : "issue";
        return {
          ...base,
          ...kindInfo(kind),
          provider: "github",
          ref: { owner, repo, num, section },
          key: `github:${owner}/${repo}#${num}`.toLowerCase(),
        };
      }
      if (repo && !section) {
        return {
          ...base,
          ...kindInfo("repo"),
          provider: "github",
          ref: { owner, repo: repo.replace(/\.git$/, "") },
          key: `github:${owner}/${repo.replace(/\.git$/, "")}`.toLowerCase(),
        };
      }
      if (!repo) {
        return { ...base, ...kindInfo("user"), provider: "github", ref: { owner }, key: `github:${owner}`.toLowerCase() };
      }
    }
    return { ...base, provider: "page" };
  }

  if ((m = host.match(/^([a-z-]+)\.wikipedia\.org$/)) && path.startsWith("/wiki/")) {
    let title = path.slice(6);
    try {
      title = decodeURIComponent(title);
    } catch (e) {
      /* «100%_cotton» — неэкранированный %, берём как есть */
    }
    const service = /^(special|служебная|category|категория|file|файл|talk|обсуждение|help|справка|portal|портал|wikipedia|википедия|template|шаблон|user|участник)(_talk)?:/i;
    if (title && !service.test(title)) {
      return {
        ...base,
        ...kindInfo("wiki"),
        provider: "wikipedia",
        ref: { lang: m[1], title },
        key: `wikipedia:${m[1]}:${title.replace(/ /g, "_")}`, // заголовки чувствительны к регистру
      };
    }
  }

  if (host === "habr.com") {
    m = path.match(/\/(articles|post|news|companies\/[^/]+\/articles|companies\/[^/]+\/news)\/(\d+)/);
    if (m) {
      const kind = /news/.test(m[1]) ? "news" : "article";
      return { ...base, ...kindInfo(kind), provider: "habr", key: `habr:${m[2]}` };
    }
  }

  const sq = searchOf(url);
  if (sq) {
    // разные запросы — разные ссылки; один и тот же запрос — одна
    // «cats», «Картинки: cats» и «cats, стр. 2» — разные вкладки: значимые параметры — в ключе
    const extra = SEARCH_PARAMS.filter((p) => u.searchParams.get(p)).map((p) => `${p}=${u.searchParams.get(p)}`).join("&");
    return { ...base, ...kindInfo("search"), provider: null, ref: sq, key: `search:${host}:${sq.q.toLowerCase().replace(/\s+/g, " ")}${extra ? "|" + extra : ""}` };
  }

  if (/^https?:$/.test(u.protocol)) return { ...base, provider: "page" };
  return base;
}

/** Тип по og:type страницы — для сайтов без отдельного распознавания. */
export function kindFromOgType(ogType) {
  const t = String(ogType || "").toLowerCase();
  if (/^video/.test(t)) return "video";
  if (/article|blog/.test(t)) return "article";
  if (/product/.test(t)) return "product";
  if (/book/.test(t)) return "book";
  if (/profile/.test(t)) return "user";
  return "page";
}

export function kindMeta(kind) {
  return kindInfo(KINDS[kind] ? kind : "page");
}

/** Подпись сайта: «Shikimori», «Хабр» или хост. */
export function siteLabel(item) {
  if (item.site === "file") return "Файлы на компьютере";
  return (item.provider && SITE_NAMES[item.provider]) || item.siteName || item.site || "";
}

/** Подпись группы вкладок по хосту. */
export function hostLabel(site) {
  return site === "file" ? "Файлы на компьютере" : site || "без адреса";
}

// поисковые страницы: хост → [путь, параметр запроса, название поисковика]
const SEARCH = [
  [/^google\.[a-z.]+$/, /^\/search$/, "q", "Google"],
  [/^(yandex\.[a-z.]+|ya\.ru)$/, /^\/search\/?$/, "text", "Яндекс"],
  [/^bing\.com$/, /^\/search$/, "q", "Bing"],
  [/^duckduckgo\.com$/, /^\/$/, "q", "DuckDuckGo"],
];

const SEARCH_PARAMS = ["tbm", "udm", "tbs", "start", "p", "ia", "iax", "lr", "type", "first"];

/** Страница поиска: {q, engine} или null. */
export function searchOf(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www|m)\./, "");
    for (const [h, p, param, engine] of SEARCH) {
      const q = u.searchParams.get(param);
      if (h.test(host) && p.test(u.pathname) && q && q.trim()) return { q: q.trim(), engine };
    }
  } catch (e) {
    /* не адрес */
  }
  return null;
}
