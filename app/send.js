// Окно «Отправить в Telegram»: выбор режима, предпросмотр, отправка с ходом и итогом.

import { hydrateIcons } from "./icons.js";
import { itemText, listParts, linksWord } from "../core/format.js";
import { sendLinks, botSettings } from "../core/bot.js";
import { patchItems } from "../core/store.js";
import { esc } from "./ui.js";

const $ = (id) => document.getElementById(id);
let items = [];
let onDone = () => {};
let ctl = null;
let bound = false;

function mode() {
  return document.querySelector('#send-dlg input[name="mode"]:checked').value;
}

function preview() {
  const m = mode();
  $("list-title-wrap").hidden = m !== "list";
  if (m === "each") {
    const first = itemText(items[0]);
    $("send-preview").textContent = items.length > 1 ? `${first}\n\n…и ещё ${items.length - 1} — каждая своим постом` : first;
  } else {
    const parts = listParts(items, $("list-title").value.trim());
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
  document.querySelectorAll('#send-dlg input[name="mode"], #list-title').forEach((i) => (i.disabled = on));
  // во время отправки «Отмена» — останавливает отправку
  document.querySelector("#send-dlg .dlg-foot [data-close]").textContent = on ? "Остановить" : "Закрыть";
}

function bind() {
  bound = true;
  const dlg = $("send-dlg");
  dlg.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener("change", preview));
  $("list-title").addEventListener("input", preview);
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
  const m = mode();
  const s = await botSettings();
  if (!s.token) return status("Сначала впишите секрет бота в настройках (значок справа вверху).", "err");
  ctl = new AbortController();
  busy(true);
  status(m === "each" ? "Отправляю… бот сохраняет ссылки по одной, это может занять пару минут." : "Отправляю список…");
  const res = await sendLinks(items, m, {
    title: $("list-title").value.trim(),
    signal: ctl.signal,
    onStep: ({ sent, total, waiting }) => {
      if (waiting) status(`Отправлено ${sent} из ${total}. Бот просит подождать — продолжу через ${waiting} с.`);
      else status(`Отправлено ${sent} из ${total}…`);
    },
  });
  const stopped = ctl.signal.aborted;
  ctl = null;
  busy(false);

  // отмечаем отправленные (и те, что уже были в архиве)
  const now = Date.now();
  const marks = [];
  for (const [id, r] of res.results) if (r.status === "saved" || r.status === "exists") marks.push([id, r]);
  for (const [id, r] of marks) await patchItems([id], { sentAt: now, sentCategory: r.category || "" });
  onDone();

  const parts = [];
  if (m === "each") {
    if (res.saved) parts.push(`сохранено ${res.saved}`);
    if (res.exists) parts.push(`уже были в архиве ${res.exists}`);
    if (res.failed) parts.push(`не получилось ${res.failed}`);
  } else if (res.saved) parts.push(`${linksWord(res.saved)} — ${res.posts > 1 ? `${res.posts} ${res.posts < 5 ? "поста" : "постов"}` : "одним постом"}`);
  const summary = parts.length ? parts.join(", ") : "";
  if (res.error) status([summary && `Готово частично — ${summary}.`, res.error].filter(Boolean).join(" "), "err");
  else if (stopped) status(`Остановлено. ${summary ? summary[0].toUpperCase() + summary.slice(1) + "." : ""}`.trim());
  else {
    const tail = m === "list" ? " Список уже в чате бота." : res.saved ? " Новые ссылки — в чате бота и в его папках." : " Бот ничего не дублировал.";
    status(`Готово: ${summary}.${tail}`, "ok");
    $("send-go").disabled = true;
  }
}

export function openSend(selected, done) {
  if (!selected.length) return;
  if (!bound) bind();
  items = selected;
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
