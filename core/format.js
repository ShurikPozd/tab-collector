// Текст ссылки для Telegram и тело запроса к боту (POST /api/save-links).
// Формат — как в контракте (side-session-notes/tab-collector.md), чтобы предпросмотр
// в расширении совпадал с тем, что пришлёт бот. Без chrome.* — проверяется в node.

export const TG_LIMIT = 4096;
export const EACH_BATCH = 5; // mode=each: ссылок за запрос (бот сохраняет по одной с ИИ — запрос идёт долго)
export const LIST_MAX = 100; // mode=list: ссылок в одном посте-списке
export const BODY_MAX = 60000; // бот принимает тело до 64 КБ (кириллица — 2 байта на букву)
const LIST_DESC = 140;

/** Насколько подробно описание: none — без него, short — ~140 символов, full — до 600 (только each). */
export const DESC = { none: 0, short: LIST_DESC, full: 600 };
export function descLimit(mode, desc) {
  const n = DESC[desc] ?? (mode === "list" ? DESC.short : DESC.full);
  return mode === "list" ? Math.min(n, LIST_DESC) : n;
}

const LIMITS = { url: 2048, site: 100, kind: 32, kindLabel: 40, icon: 8, title: 300, meta: 300, description: 600, image: 2048 };

export function clip(s, n) {
  s = String(s || "").replace(/\s+/g, " ").trim();
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)).replace(/[\s,.;:—-]+$/, "") + "…";
}

/** Без «https://» и «www.» — как в превью (короче, Telegram всё равно делает ссылкой). */
export function shortUrl(url) {
  return String(url || "").replace(/^https?:\/\/(www\.)?/, "");
}

/** Строки одной ссылки (пустые опущены). short — для списка; descMax — предел описания (0 — без него). */
export function itemLines(item, { short = false, descMax } = {}) {
  const head = [item.icon, [item.kindLabel, item.title || item.url].filter(Boolean).join(" · ")]
    .filter(Boolean)
    .join(" ");
  const max = descMax ?? (short ? LIST_DESC : LIMITS.description);
  const desc = max ? clip(item.description, max) : "";
  return [head, clip(item.meta, LIMITS.meta), desc, item.url].filter((s) => s && String(s).trim());
}

export function itemText(item, opts) {
  return itemLines(item, opts).join("\n");
}

function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

export function linksWord(n) {
  return `${n} ${plural(n, "ссылка", "ссылки", "ссылок")}`;
}

/** Пост-список — так же, как его соберёт бот (savelinks.list_parts): заголовок «🔗 …»,
 *  «N ссылок», ссылки через пустую строку; длинный — частями ≤4096 с «часть k/N». */
export function listParts(items, title = "", descMax = LIST_DESC) {
  const n = items.length;
  const name = title ? `🔗 ${clip(title, 120)}` : "🔗 Список ссылок";
  const header = (k, total) => (total === 1 ? `${name}\n${linksWord(n)}` : `${name} · часть ${k}/${total}\n${linksWord(n)}`);
  const room = TG_LIMIT - header(99, 99).length - 2;
  const groups = [];
  let cur = [];
  let size = 0;
  for (const it of items) {
    const b = itemText(it, { short: true, descMax }).slice(0, TG_LIMIT - 200);
    let add = b.length + (cur.length ? 2 : 0);
    if (cur.length && size + add > room) {
      groups.push(cur);
      cur = [];
      size = 0;
      add = b.length;
    }
    cur.push(b);
    size += add;
  }
  if (cur.length) groups.push(cur);
  return groups.map((g, i) => `${header(i + 1, groups.length)}\n\n${g.join("\n\n")}`);
}

/** Одна ссылка в теле запроса — только поля контракта, обрезанные по лимитам. */
export function payloadItem(item, mode = "each", desc) {
  const out = {
    url: String(item.url).slice(0, LIMITS.url),
    site: clip(item.siteLabel || item.site, LIMITS.site),
    kind: clip(item.kind || "page", LIMITS.kind),
    kindLabel: clip(item.kindLabel, LIMITS.kindLabel),
    icon: String(item.icon || "").slice(0, LIMITS.icon),
    title: clip(item.title || item.url, LIMITS.title),
    meta: clip(item.meta, LIMITS.meta),
    // в списке бот всё равно показывает ~140 символов — не раздуваем запрос
    description: descLimit(mode, desc) ? clip(item.description, descLimit(mode, desc)) : "",
  };
  if (mode === "each" && item.image && /^https:\/\//.test(item.image) && item.image.length <= LIMITS.image) out.image = item.image;
  return out;
}

export function payload(mode, items, title = "", desc) {
  const body = { mode, items: items.map((it) => payloadItem(it, mode, desc)) };
  if (mode === "list" && title) body.title = clip(title, 120);
  return body;
}

export function bodySize(body) {
  return new TextEncoder().encode(JSON.stringify(body)).length;
}

/** Пачки: each — по EACH_BATCH; list — по LIST_MAX, но так, чтобы тело влезло в BODY_MAX. */
export function batches(mode, items) {
  const out = [];
  if (mode === "each") {
    for (let i = 0; i < items.length; i += EACH_BATCH) out.push(items.slice(i, i + EACH_BATCH));
    return out;
  }
  let cur = [];
  for (const it of items) {
    const next = cur.concat(it);
    if (cur.length && (next.length > LIST_MAX || bodySize(payload("list", next, "x".repeat(120))) > BODY_MAX)) {
      out.push(cur);
      cur = [it];
    } else cur = next;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Ответ/ошибка бота → понятный текст на «вы». */
export function botError(status, data) {
  const code = data && data.code;
  if (status === 0) return "Нет связи с ботом. Проверьте интернет или адрес бота в настройках.";
  if (status === 403 || code === "forbidden") return "Бот не принял секрет. Проверьте его в настройках.";
  if (status === 404 || status === 405) return "Обновите бота: он пока не умеет принимать ссылки.";
  if (status === 413 || code === "too_large") return "Слишком большой запрос — отправьте меньше ссылок за раз.";
  if (status === 429 || code === "rate") return "Бот просит подождать: слишком много ссылок подряд.";
  if (code === "no_owner") return "Бот не знает владельца архива (OWNER_ID).";
  if (code === "tg_offline") return "Бот сейчас не подключён к Telegram — попробуйте позже.";
  if (code === "tg_send") return "Telegram не принял сообщение — попробуйте ещё раз позже.";
  if (status === 400 || code === "bad_request") return "Бот не принял ссылки: в них что-то не так. Попробуйте отправить меньше или другие.";
  if (status === 502 || status === 503) return "Бот просыпается или недоступен — попробуйте через минуту.";
  return (data && data.error) || `Ошибка бота (${status}).`;
}
