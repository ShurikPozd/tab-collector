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
const TRACKING = /^(utm_[a-z]+|fbclid|gclid|yclid|ysclid|_openstat|ref_src|si|feature|pp|igshid|mc_[a-z]+)$/i;

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
 * Ключ для склейки дублей: без #якоря, меток отслеживания, www/m., хвостового «/»;
 * у известных сайтов — по id (shikimori.one/animes/52991-frieren и /animes/52991 — одно).
 */
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
    return `${u.hostname.replace(/^(www|m)\./, "")}${path}${q}`.toLowerCase();
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
      return { ...base, site: "youtube.com", ...kindInfo("channel"), provider: "page", key: `youtube:${m[1].toLowerCase()}` };
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
    const title = decodeURIComponent(path.slice(6));
    const service = /^(special|служебная|category|категория|file|файл|talk|обсуждение|help|справка|portal|портал|wikipedia|википедия|template|шаблон|user|участник)(_talk)?:/i;
    if (title && !service.test(title)) {
      return {
        ...base,
        ...kindInfo("wiki"),
        provider: "wikipedia",
        ref: { lang: m[1], title },
        key: `wikipedia:${m[1]}:${title.replace(/ /g, "_")}`.toLowerCase(),
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
  return (item.provider && SITE_NAMES[item.provider]) || item.siteName || item.site || "";
}
