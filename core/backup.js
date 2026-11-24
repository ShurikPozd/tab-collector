// Автокопия списка в Telegram-бота: раз в сутки и после крупного сбора список ссылок и папок
// (без настроек и секрета) уходит файлом в чат с ботом — если Chrome после сбоя потеряет
// данные, список можно восстановить из этого файла («Настройки → Загрузить копию»).
// Бот: POST /api/backup?app=tab-collector (тот же, что у «Сводки комментариев YouTube»).

import { exportData, loadSettings, update } from "./store.js";
import { botSettings } from "./bot.js";

export const DAY = 24 * 3600 * 1000;

async function gzip(text) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Blob([await new Response(stream).arrayBuffer()], { type: "application/gzip" });
}

async function remember(patch) {
  await update((d) => {
    d.settings = { ...d.settings, backup: { ...(d.settings.backup || {}), ...patch } };
  });
}

/**
 * Отправить копию. manual — по кнопке (бот подпишет «по кнопке»).
 * Возвращает { ok, text } — понятный итог на «вы».
 */
export function sendBackup(opts = {}) {
  // одна копия за раз (будильник, «после сбора» и кнопка могут совпасть)
  return navigator.locks.request("tc-backup", { ifAvailable: true }, (lock) => (lock ? sendBackupNow(opts) : { ok: true, text: "Копия уже отправляется." }));
}

async function sendBackupNow({ manual = false } = {}) {
  const s = await botSettings();
  if (!s.token) return { ok: false, text: "Впишите секрет бота — без него копию не отправить." };
  const data = await exportData();
  if (!data.items.length && !manual) return { ok: true, text: "Список пуст — копировать нечего." };
  const ver = chrome.runtime.getManifest().version;
  const q = new URLSearchParams({ app: "tab-collector", ver, links: String(data.items.length), folders: String(data.folders.length), manual: manual ? "1" : "0" });
  let r;
  // бот на Render может просыпаться до минуты — не даём фону уснуть, пока ждём ответа
  const keep = setInterval(() => chrome.runtime.getPlatformInfo().catch(() => {}), 20000);
  try {
    r = await fetch(`${s.baseUrl}/api/backup?${q}`, {
      method: "POST",
      headers: { "Content-Type": "application/gzip", "X-Sec-Token": s.token },
      body: await gzip(JSON.stringify(data)),
      signal: AbortSignal.timeout(90000),
    });
  } catch (e) {
    await remember({ lastError: "нет связи с ботом", lastTryAt: Date.now() });
    return { ok: false, text: "Нет связи с ботом — копия не отправлена, попробую позже." };
  } finally {
    clearInterval(keep);
  }
  if (r.ok) {
    await remember({ lastAt: Date.now(), lastLinks: data.items.length, lastError: "", lastTryAt: Date.now() });
    return { ok: true, text: `Копия отправлена в Telegram: ${data.items.length} ссылок.` };
  }
  let body = null;
  try {
    body = await r.json();
  } catch (e) {
    /* не JSON */
  }
  const why =
    r.status === 403 ? "бот не принял секрет" : r.status === 429 ? "бот просит подождать минуту" : r.status === 404 ? "бот пока не умеет принимать копии" : (body && body.error) || `ошибка ${r.status}`;
  await remember({ lastError: why, lastTryAt: Date.now() });
  return { ok: false, text: `Копия не отправлена: ${why}.` };
}

/** Пора ли автокопии: включена и с прошлой удачной копии прошло больше minGap. */
export async function backupDue(minGap = DAY - 3600 * 1000) {
  const st = await loadSettings();
  if (st.autoBackup === false) return false;
  const b = st.backup || {};
  // после неудачи — не чаще раза в час
  if (b.lastTryAt && Date.now() - b.lastTryAt < 3600 * 1000 && b.lastError) return false;
  return !b.lastAt || Date.now() - b.lastAt > minGap;
}
