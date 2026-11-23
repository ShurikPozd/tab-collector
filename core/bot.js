// Связь с ботом-архивом (@SaveandSort_bot): POST /api/save-links с секретом X-Sec-Token.
// Секрет — в настройках расширения или в local-config.js (файл не попадает в git).

import { DEFAULTS } from "../config.js";
import { load } from "./store.js";
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
  const { settings } = await load();
  // local-config.js читаем, только если в настройках чего-то нет (файла может и не быть)
  const lc = settings.token && settings.baseUrl ? {} : await localConfig();
  return {
    baseUrl: (settings.baseUrl || lc.baseUrl || DEFAULTS.baseUrl).replace(/\/+$/, ""),
    token: settings.token || lc.token || "",
    tokenFromFile: !settings.token && !!lc.token,
  };
}

// запрос each идёт долго: бот сохраняет ссылки по одной и ждёт ИИ (до минут при лимитах Groq)
async function post(path, body, s, timeout = 6 * 60000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(s.baseUrl + path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Sec-Token": s.token },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    let data = null;
    try {
      data = await r.json();
    } catch (e) {
      /* не JSON */
    }
    return { status: r.status, data };
  } catch (e) {
    return { status: 0, data: null };
  } finally {
    clearTimeout(t);
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

/**
 * Отправить ссылки. mode: "each" | "list". onStep({sent, total, waiting}) — для прогресса.
 * Возвращает { results: Map(id → {status, category, icon}), error, saved, exists, failed }.
 */
export async function sendLinks(items, mode, { title = "", desc, onStep, signal } = {}) {
  const s = await botSettings();
  const out = { results: new Map(), error: "", saved: 0, exists: 0, failed: 0, posts: 0 };
  if (!s.token) {
    out.error = "Впишите секрет бота в настройках.";
    return out;
  }
  // Бот бережёт лимиты Groq: не больше ~30 новых постов за 10 минут. Если он просит подождать
  // недолго — ждём сами (с отсчётом), если долго — останавливаемся: остальное останется
  // в «Не отправлены», и его можно дослать позже.
  const queue = batches(mode, items);
  const total = queue.length;
  let sent = 0;
  let done = 0;
  const wait = async (sec) => {
    for (let left = sec; left > 0; left--) {
      if (signal && signal.aborted) return false;
      onStep && onStep({ sent, total: items.length, waiting: left });
      await sleep(1000);
    }
    return !(signal && signal.aborted);
  };
  let wakeTries = 0;
  while (queue.length) {
    if (signal && signal.aborted) break;
    const part = queue.shift();
    done++;
    const partTitle = mode === "list" && total > 1 ? `${title || "Список ссылок"} (${done}/${total})` : title;
    onStep && onStep({ sent, total: items.length, waiting: 0 });
    const r = await post("/api/save-links", payload(mode, part, partTitle, desc), s);
    const retryAfter = Math.max(5, Number((r.data && r.data.retryAfter) || 0));

    // бот спит на Render или просит подождать до первой ссылки
    if ((r.status === 502 || r.status === 503 || r.status === 0) && !(r.data && r.data.code) && wakeTries < 3) {
      wakeTries++;
      queue.unshift(part);
      done--;
      if (!(await wait(20))) break;
      continue;
    }
    if (r.status === 429) {
      queue.unshift(part);
      done--;
      if (retryAfter > MAX_WAIT || !(await wait(retryAfter))) {
        out.error = `Бот просит подождать ${Math.ceil(retryAfter / 60)} мин: так он бережёт бесплатные лимиты ИИ. Остальные ссылки остались в разделе «Не отправлены».`;
        out.paused = true;
        break;
      }
      continue;
    }
    if (r.status !== 200 || !r.data || !r.data.ok) {
      out.error = botError(r.status, r.data);
      break;
    }
    wakeTries = 0;
    if (mode === "each") {
      const res = r.data.results || [];
      const later = [];
      part.forEach((it, j) => {
        const x = res[j] || {};
        if (x.code === "rate") return later.push(it);
        out.results.set(it.id, x);
        if (x.status === "saved") out.saved++;
        else if (x.status === "exists") out.exists++;
        else out.failed++;
        sent++;
      });
      if (later.length) {
        queue.unshift(later);
        done--;
        if (retryAfter > MAX_WAIT || !(await wait(retryAfter))) {
          out.error = `Бот просит подождать ${Math.ceil(retryAfter / 60)} мин: так он бережёт бесплатные лимиты ИИ. Остальные ссылки остались в разделе «Не отправлены».`;
          out.paused = true;
          break;
        }
      }
    } else {
      out.posts += Number(r.data.parts) || 1;
      for (const it of part) out.results.set(it.id, { status: "saved", category: r.data.category, icon: r.data.icon });
      out.saved += part.length;
      sent += part.length;
    }
    onStep && onStep({ sent, total: items.length, waiting: 0 });
  }
  return out;
}

const MAX_WAIT = 12 * 60; // ждём сами не дольше 12 минут
