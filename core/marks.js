// Отметки у собранных ссылок: «хочу / смотрю (читаю) / готово». Подписи зависят от типа
// страницы: аниме и видео — «смотрю / посмотрел», манга и статьи — «читаю / прочитал».
// Без chrome.* — проверяется в node.

export const MARKS = ["want", "doing", "done"];

const WATCH = new Set(["anime", "video", "short", "playlist", "channel"]);
const READ = new Set(["manga", "ranobe", "article", "news", "wiki", "book"]);

export const MARK_ICON = { want: "⭐", doing: "▶️", done: "✅" };

/** Подпись отметки для конкретной ссылки. */
export function markLabel(mark, kind) {
  if (mark === "want") return "Хочу";
  if (mark === "doing") return WATCH.has(kind) ? "Смотрю" : READ.has(kind) ? "Читаю" : "В процессе";
  if (mark === "done") return WATCH.has(kind) ? "Посмотрел" : READ.has(kind) ? "Прочитал" : "Готово";
  return "";
}

/** Подпись раздела слева (для всех типов сразу). */
export const MARK_NAV = { want: "Хочу", doing: "В процессе", done: "Готово" };
