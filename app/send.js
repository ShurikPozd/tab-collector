// Окно «Отправить в Telegram»: выбор режима, предпросмотр, отправка с ходом и итогом.

import { hydrateIcons } from "./icons.js";
import { itemText, listParts, linksWord, descLimit } from "../core/format.js";
import { sendLinks, botSettings, sendable } from "../core/bot.js";
import { patchItems, load } from "../core/store.js";
import { esc } from "./ui.js";

const $ = (id) => document.getElementById(id);
let items = [];
let sentBefore = new Map(); // отметки «отправлено» на момент открытия окна
let onDone = () => {};
let ctl = null;
let bound = false;

function mode() {
  return document.querySelector('#send-dlg input[name="mode"]:checked').value;
}

// подробность описания — запоминается отдельно для каждого режима
const DESC_DEFAULT = { each: "full", list: "short" };
function descChoice(m = mode()) {
  try {
    const v = localStorage.getItem(`tc:desc:${m}`);
    if (v === "none" || v === "short" || (v === "full" && m === "each")) return v;
  } catch (e) {
    /* по умолчанию */
  }
  return DESC_DEFAULT[m];
}

function syncDesc() {
  const m = mode();
  const cur = descChoice(m);
  document.querySelectorAll("[data-desc]").forEach((b) => {
    b.setAttribute("aria-checked", String(b.dataset.desc === cur));
    // в посте-списке бот всё равно показывает ~140 символов — «Полностью» там нет
    b.hidden = m === "list" && b.dataset.desc === "full";
  });
}

function preview() {
  const m = mode();
  if (!items.length) {
    $("send-preview").textContent = "";
    return;
  }
  $("list-title-wrap").hidden = m !== "list";
  syncDesc();
  const descMax = descLimit(m, descChoice(m));
  if (m === "each") {
    const first = itemText(items[0], { descMax });
    $("send-preview").textContent = items.length > 1 ? `${first}\n\n…и ещё ${items.length - 1} — каждая своим постом` : first;
  } else {
    const parts = listParts(items, $("list-title").value.trim(), descMax);
    $("send-preview").textContent = parts[0] + (parts.length > 1 ? `\n\n…и ещё ${parts.length - 1} ${parts.length - 1 === 1 ? "часть" : "части"} (в Telegram сообщение — до 4096 символов)` : "");
  }
}

function status(text, kind = "") {
  const el = $("send-status");
  el.hidden = !text;
  el.className = `send-status${kind ? " " + kind : ""}`;
  el.textContent = text;
}

function busy(on) {
  $("send-go").disabled = on;
  $("send-go").classList.toggle("spin", on);
  document.querySelectorAll('#send-dlg input[name="mode"], #list-title, [data-desc]').forEach((i) => (i.disabled = on));
  // во время отправки «Отмена» — останавливает отправку
  document.querySelector("#send-dlg .dlg-foot [data-close]").textContent = on ? "Остановить" : "Закрыть";
}

function bind() {
  bound = true;
  const dlg = $("send-dlg");
  dlg.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener("change", preview));
  $("list-title").addEventListener("input", preview);
  dlg.querySelectorAll("[data-desc]").forEach((b) =>
    b.addEventListener("click", () => {
      try {
        localStorage.setItem(`tc:desc:${mode()}`, b.dataset.desc);
      } catch (e) {
        /* не критично */
      }
      preview();
    })
  );
  dlg.querySelectorAll("[data-close]").forEach((b) =>
    b.addEventListener("click", () => {
      if (ctl) return ctl.abort();
      dlg.close();
    })
  );
  dlg.addEventListener("cancel", (e) => {
    if (ctl) {
      e.preventDefault();
      ctl.abort();
    }
  });
  $("send-go").addEventListener("click", go);
}

async function go() {
  // кнопку выключаем сразу, до первого await: двойной щелчок не запустит вторую отправку
  if (ctl) return;
  ctl = new AbortController();
  busy(true);
  const m = mode();
  const s = await botSettings();
  if (!s.token) {
    ctl = null;
    busy(false);
    return status("Сначала впишите секрет бота в настройках (значок справа вверху).", "err");
  }
  status(m === "each" ? "Отправляю… бот сохраняет ссылки по одной, это может занять пару минут." : "Отправляю список…");
  let res;
  try {
  // отправка идёт в другом окне сборщика — не ждём молча, а говорим
  res = await navigator.locks.request("tc-send", { ifAvailable: true }, async (lock) => {
    if (!lock) return { busy: true };
    // пока окно было открыто, часть ссылок могли отправить из другого окна — их не шлём
    // (сознательную повторную отправку уже отправленных — например, списком — не трогаем)
    const fresh = new Map((await load()).items.map((it) => [it.id, it]));
    const before = items.length;
    items = items.filter((it) => fresh.has(it.id) && (fresh.get(it.id).sentAt || null) === (sentBefore.get(it.id) || null));
    if (before && !items.length) return { allSentElsewhere: true };
    if (items.length < before) $("send-count").innerHTML = `Отправить: <b>${esc(linksWord(items.length))}</b> (остальные уже отправили или удалили в другом окне)`;
    return sendLinks(items, m, {
    title: $("list-title").value.trim(),
    desc: descChoice(m),
    signal: ctl.signal,
    onStep: ({ sent, total, waiting }) => {
      if (waiting) status(`Отправлено ${sent} из ${total}. Бот просит подождать — продолжу через ${waiting} с.`);
      else status(`Отправлено ${sent} из ${total}…`);
    },
    // отмечаем «в Telegram» сразу после каждой принятой пачки: если закрыть страницу
    // посередине, уже отправленное не уйдёт второй раз
    onBatch: async (batch) => {
      const now = Date.now();
      const ok = [...batch].filter(([, r]) => r.status === "saved" || r.status === "exists");
      const cat = new Map(ok.map(([id, r]) => [id, r.category || ""]));
      if (ok.length) await patchItems([...cat.keys()], (it) => ({ sentAt: now, sentCategory: cat.get(it.id) }));
      items = items.filter((it) => !cat.has(it.id)); // «Отправить» ещё раз — только оставшиеся
      onDone();
    },
  });
  });
  } catch (err) {
    res = { error: "Не получилось отправить — попробуйте ещё раз.", results: new Map(), saved: 0, exists: 0, failed: 0, posts: 0, skipped: 0 };
  } finally {
    ctl = null;
    busy(false);
  }
  if (res.busy) {
    status("Отправка уже идёт в другом окне сборщика — дождитесь её конца.", "err");
    return;
  }
  if (res.allSentElsewhere) {
    status("Эти ссылки уже отправили или удалили в другом окне сборщика.", "ok");
    $("send-count").textContent = "Отправлять нечего";
    $("send-go").disabled = true;
    return;
  }
  $("send-count").innerHTML = items.length ? `Осталось отправить: <b>${esc(linksWord(items.length))}</b>` : "Все выбранные ссылки отправлены";

  const parts = [];
  if (m === "each") {
    if (res.saved) parts.push(`сохранено ${res.saved}`);
    if (res.exists) parts.push(`уже были в архиве ${res.exists}`);
    if (res.failed) parts.push(`не получилось ${res.failed}`);
  } else if (res.saved) parts.push(`${linksWord(res.saved)} — ${res.posts > 1 ? `${res.posts} ${res.posts < 5 ? "поста" : "постов"}` : "одним постом"}`);
  if (res.skipped) parts.push(`пропущено ${res.skipped} (не веб-адреса или слишком длинные)`);
  const summary = parts.join(", ");
  if (res.stopped) status(`Остановлено.${summary ? ` ${summary[0].toUpperCase()}${summary.slice(1)}.` : ""} Остальные ссылки — в разделе «Не отправлены».`);
  else if (res.error) status([summary && `Готово частично — ${summary}.`, res.error].filter(Boolean).join(" "), "err");
  else {
    const tail = m === "list" ? " Список уже в чате бота." : res.saved ? " Новые ссылки — в чате бота и в его папках." : " Бот ничего не дублировал.";
    status(`Готово: ${summary || "нечего отправлять"}.${tail}`, "ok");
  }
  $("send-go").disabled = !items.filter(sendable).length;
}

export function openSend(selected, done) {
  if (!selected.length) return;
  if (!bound) bind();
  items = selected;
  sentBefore = new Map(selected.map((it) => [it.id, it.sentAt || null]));
  onDone = done || (() => {});
  $("send-count").innerHTML = `Выбрано: <b>${esc(linksWord(items.length))}</b>`;
  $("list-title").value = "";
  status("");
  busy(false);
  $("send-go").disabled = false;
  preview();
  hydrateIcons($("send-dlg"));
  $("send-dlg").showModal();
  $("send-go").focus({ focusVisible: false });
}
