// Связь с ботом-архивом (@SaveandSort_bot): POST /api/save-links с секретом X-Sec-Token.
// Секрет — в настройках расширения или в local-config.js (файл не попадает в git).

import { DEFAULTS } from "../config.js";
import { loadSettings } from "./store.js";
import { payload, batches, botError } from "./format.js";

let localCfg = null;
async function localConfig() {
  if (localCfg) return localCfg;
  localCfg = {};
  try {
    const r = await fetch(chrome.runtime.getURL("local-config.js"));
    if (r.ok) {
      const src = (await r.text()).replace(/^\s*\/\/.*$/gm, "");
      for (const key of ["token", "baseUrl"]) {
        const m = src.match(new RegExp(`\\b${key}\\s*:\\s*["'\`]([^"'\`]*)["'\`]`));
        if (m) localCfg[key] = m[1];
      }
    }
  } catch (e) {
    /* файла нет — секрет в настройках */
  }
  return localCfg;
}

export async function botSettings() {
  const settings = await loadSettings();
  // local-config.js читаем, только если в настройках чего-то нет (файла может и не быть)
  const lc = settings.token && settings.baseUrl ? {} : await localConfig();
  return {
    baseUrl: (settings.baseUrl || lc.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, ""),
    token: settings.token || lc.token || "",
    tokenFromFile: !settings.token && !!lc.token,
  };
}

// запрос each идёт долго: бот сохраняет ссылки по одной и ждёт ИИ (до минут при лимитах Groq).
// signal — «Остановить» прерывает и сам запрос, а не только ожидание между пачками.
async function post(path, body, s, timeout = 6 * 60000, signal) {
  const signals = [AbortSignal.timeout(timeout)];
  if (signal) signals.push(signal);
  const t0 = Date.now();
  try {
    const r = await fetch(s.baseUrl + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sec-Token": s.token },
      body: JSON.stringify(body),
      signal: AbortSignal.any(signals),
    });
    let data = null;
    try {
      data = await r.json();
    } catch (e) {
      /* не JSON */
    }
    return { status: r.status, data, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, data: null, ms: Date.now() - t0, aborted: !!(signal && signal.aborted) };
  }
}

/** Проверка связи: бот проснулся и принимает секрет (пустой запрос → 400, а не 403). */
export async function ping() {
  const s = await botSettings();
  if (!s.token) return { ok: false, text: "Впишите секрет бота." };
  const r = await post("/api/save-links", { mode: "each", items: [] }, s, 60000);
  if (r.status === 400) return { ok: true, text: "Бот на связи и принимает секрет." };
  if (r.status === 200) return { ok: true, text: "Бот на связи." };
  return { ok: false, text: botError(r.status, r.data) };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAX_WAIT = 12 * 60; // ждём сами не дольше 12 минут
const QUICK = 5000; // сбой быстрее 5 с — бот не успел ничего сохранить, можно повторить

/** Бот примет только обычные адреса до 2048 символов — остальные не отправляем. */
export function sendable(item) {
  if (!/^https?:\/\//i.test(item.url || "") || item.url.length > 2048 || /\s/.test(item.url)) return false;
  try {
    new URL(item.url);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Отправить ссылки. mode: "each" | "list".
 * onStep({sent, total, waiting}) — для хода отправки; onBatch(Map id → результат) — после
 * каждой принятой пачки (чтобы сразу отметить «в Telegram», а не в самом конце).
 * Возвращает { results, error, stopped, paused, skipped, saved, exists, failed, posts }.
 */
export async function sendLinks(items, mode, { title = "", desc, onStep, onBatch, signal } = {}) {
  const s = await botSettings();
  const out = { results: new Map(), error: "", stopped: false, paused: false, skipped: 0, saved: 0, exists: 0, failed: 0, posts: 0 };
  if (!s.token) {
    out.error = "Впишите секрет бота в настройках.";
    return out;
  }
  const good = items.filter(sendable);
  out.skipped = items.length - good.length;
  // Бот бережёт лимиты Groq: не больше ~30 новых постов за 10 минут. Если он просит подождать
  // недолго — ждём сами (с отсчётом), если долго — останавливаемся: остальное останется
  // в «Не отправлены», и его можно дослать позже.
  const queue = batches(mode, good);
  const total = queue.length;
  let sent = 0;
  let done = 0;
  const aborted = () => !!(signal && signal.aborted);
  const wait = async (sec) => {
    for (let left = sec; left > 0; left--) {
      if (aborted()) return false;
      onStep && onStep({ sent, total: good.length, waiting: left });
      await sleep(1000);
    }
    return !aborted();
  };
  const tooLong = (sec) =>
    `Бот просит подождать ${sec >= 3600 ? `${Math.ceil(sec / 3600)} ч` : `${Math.ceil(sec / 60)} мин`}: так он бережёт бесплатные лимиты ИИ. Остальные ссылки остались в разделе «Не отправлены».`;
  let wakeTries = 0;
  while (queue.length) {
    if (aborted()) break;
    const part = queue.shift();
    done++;
    const partTitle = mode === "list" && total > 1 ? `${title || "Список ссылок"} (${done}/${total})` : title;
    onStep && onStep({ sent, total: good.length, waiting: 0 });
    const body = payload(mode, part, partTitle, desc);
    // сознательная повторная отправка уже отправленных — новый пост (бот иначе ответит «уже есть»);
    // повтор после сбоя (ссылки ещё не отмечены) — тот же ключ, и бот не создаст второй пост
    if (body.batchKey && part.every((it) => it.sentAt)) body.batchKey += `-r${Date.now().toString(36)}`;
    const r = await post("/api/save-links", body, s, undefined, signal);
    if (r.aborted || aborted()) break;
    const retryAfter = Math.max(5, Number((r.data && r.data.retryAfter) || 0));

    // бот просыпается на Render: повторяем только быстрый сбой — после долгого запроса
    // бот мог уже всё сохранить, и повтор дал бы второй пост
    const sleepy = (r.status === 502 || r.status === 503 || r.status === 0) && !(r.data && r.data.code);
    if (sleepy && r.ms < QUICK && wakeTries < 3) {
      wakeTries++;
      queue.unshift(part);
      done--;
      if (!(await wait(20))) break;
      continue;
    }
    if (r.status === 429) {
      queue.unshift(part);
      done--;
      if (retryAfter > MAX_WAIT) {
        out.error = tooLong(retryAfter);
        out.paused = true;
        break;
      }
      if (!(await wait(retryAfter))) break;
      continue;
    }
    if (r.status !== 200 || !r.data || !r.data.ok) {
      out.error = sleepy && r.ms >= QUICK ? "Бот не ответил вовремя. Проверьте чат бота — часть ссылок могла сохраниться; остальные остались в «Не отправлены»." : botError(r.status, r.data);
      break;
    }
    wakeTries = 0;
    const batch = new Map();
    const later = [];
    if (mode === "each") {
      const res = r.data.results || [];
      part.forEach((it, j) => {
        const x = res[j] || {};
        if (x.code === "rate") return later.push(it);
        batch.set(it.id, x);
        if (x.status === "saved") out.saved++;
        else if (x.status === "exists") out.exists++;
        else out.failed++;
        sent++;
      });
    } else {
      // бот не смог записать часть списка в архив — не считаем отправленным: ссылки останутся
      // в «Не отправлены», и повтор их досохранит
      if (Number(r.data.unsaved) > 0) {
        out.error = "Бот не смог сохранить часть списка в архив — ссылки остались в «Не отправлены». Попробуйте отправить ещё раз.";
        break;
      }
      out.posts += Number(r.data.parts) || 1;
      if (r.data.status === "exists") out.exists += part.length;
      for (const it of part) batch.set(it.id, { status: r.data.status === "exists" ? "exists" : "saved", category: r.data.category, icon: r.data.icon });
      if (r.data.status !== "exists") out.saved += part.length;
      sent += part.length;
    }
    for (const [id, x] of batch) out.results.set(id, x);
    if (onBatch) await onBatch(batch);
    onStep && onStep({ sent, total: good.length, waiting: 0 });
    if (later.length) {
      queue.unshift(later);
      done--;
      if (retryAfter > MAX_WAIT) {
        out.error = tooLong(retryAfter);
        out.paused = true;
        break;
      }
      if (!(await wait(retryAfter))) break;
    }
  }
  out.stopped = aborted();
  return out;
}
