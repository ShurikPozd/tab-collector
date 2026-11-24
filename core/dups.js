// Дубли среди открытых вкладок: одна и та же страница открыта несколько раз.
// Оставляем одну копию — закреплённую, активную или ту, где вы были последним. Без chrome.*.

/**
 * tabs — вкладки, которые можно трогать (без служебных и самого сборщика); keyOf(tab) — ключ страницы.
 * Возвращает { close: [вкладки, которые закрыть], groups: число страниц с дублями }.
 */
export function findDuplicates(tabs, keyOf) {
  const byKey = new Map();
  for (const t of tabs) {
    if (!t || !t.url) continue;
    const k = keyOf(t.url);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(t);
  }
  const close = [];
  let groups = 0;
  for (const list of byKey.values()) {
    if (list.length < 2) continue;
    groups++;
    const keep = list.slice().sort((a, b) => score(b) - score(a))[0];
    for (const t of list) if (t !== keep && !t.pinned && !t.active && !t.audible) close.push(t);
  }
  return { close, groups };
}

// что важнее оставить: закреплённую, активную, со звуком, потом — где были последним
function score(t) {
  return (t.pinned ? 4e15 : 0) + (t.active ? 2e15 : 0) + (t.audible ? 1e15 : 0) + (t.lastAccessed || 0);
}
