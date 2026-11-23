// Подробности о ссылке: открытые API известных сайтов и метатеги страницы.
// Работает на странице расширения (нужны fetch с host_permissions и DOMParser).
// Разбор ответов (shikiPatch, jikanPatch…) — чистые функции, проверяются в node.

import { kindFromOgType, kindMeta } from "./url.js";
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

const GAP = { shikimori: 350, mal: 1100, anilist: 800, github: 400, wikipedia: 150, youtube: 150, page: 250, habr: 300 };
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

async function pageMeta(url) {
  if (!safeToFetch(url)) return { doc: null, meta: {} };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 12000);
  try {
    // без ваших куки: страницу запрашиваем как гость
    const r = await fetch(url, { credentials: "omit", signal: ctl.signal, headers: { Accept: "text/html" } });
    if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
    // гостя перекинуло на другой сайт (вход в Google, Notion, Jira) — это не та страница
    if (r.redirected && new URL(r.url).hostname.replace(/^www\./, "") !== new URL(url).hostname.replace(/^www\./, "")) return { doc: null, meta: {} };
    const type = r.headers.get("content-type") || "";
    if (!/html/.test(type)) return { doc: null, meta: {} };
    const text = (await r.text()).slice(0, 600000);
    const doc = new DOMParser().parseFromString(text, "text/html");
    return { doc, meta: parseMeta(doc) };
  } finally {
    clearTimeout(t);
  }
}

const ANILIST_Q = {
  media: `query($id:Int){Media(id:$id){title{romaji english}format episodes volumes chapters status seasonYear startDate{year}averageScore genres description(asHtml:false)coverImage{large}}}`,
  character: `query($id:Int){Character(id:$id){name{full native}description(asHtml:false)image{large}media(perPage:1){nodes{title{romaji}}}}}`,
  staff: `query($id:Int){Staff(id:$id){name{full native}primaryOccupations description(asHtml:false)image{large}}}`,
};

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
      const { meta } = await pageMeta(item.url);
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
  const hasTitle = item.title && item.title !== item.url;
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
