// Предпросмотр при наведении: через ~0,45 с над карточкой ссылки (или строкой открытой
// вкладки) появляется большая карточка — снимок страницы или постер, полное описание.
// Только для мыши на широком экране; ничего не грузит из сети, кроме уже известных картинок.

import { getShot } from "../core/shots.js";
import { esc } from "./ui.js";

const DELAY = 450;
const urls = new Map(); // ключ снимка → objectURL (живут, пока открыта страница)
let el = null;
let timer = null;
let current = null;

export async function shotUrl(key) {
  if (urls.has(key)) return urls.get(key);
  const blob = await getShot(key).catch(() => null);
  const u = blob ? URL.createObjectURL(blob) : "";
  urls.set(key, u);
  return u;
}

/** Снимок обновился (или удалён) — забыть закэшированный адрес. */
export function forgetShots() {
  for (const u of urls.values()) if (u) URL.revokeObjectURL(u);
  urls.clear();
}

function can() {
  return matchMedia("(hover: hover) and (pointer: fine)").matches && innerWidth >= 700;
}

function hide() {
  clearTimeout(timer);
  current = null;
  if (el) el.hidden = true;
}

const POSTER = new Set(["anime", "manga", "ranobe", "character", "person"]);

async function show(target, data, x) {
  const shot = data.shotKey ? await shotUrl(data.shotKey) : "";
  if (current !== target) return;
  const poster = data.image && POSTER.has(data.kind);
  const wide = shot || (!poster && data.image);
  const media = poster
    ? `<img class="pk-poster" src="${esc(data.image)}" alt="" referrerpolicy="no-referrer" />`
    : wide
      ? `<img class="pk-wide" src="${esc(shot || data.image)}" alt="" referrerpolicy="no-referrer" />`
      : "";
  el.className = `peek${poster ? " has-poster" : ""}`;
  el.innerHTML = `
    ${poster ? media : wide ? `<div class="pk-media">${media}${shot ? '<span class="pk-badge">снимок страницы</span>' : ""}</div>` : ""}
    <div class="pk-body">
      <div class="pk-kicker">${data.kindLabel ? `<span class="tag kind">${data.icon || ""} ${esc(data.kindLabel)}</span>` : ""}<span>${esc(data.site || "")}</span></div>
      <div class="pk-title">${esc(data.title || data.url)}</div>
      ${data.meta ? `<div class="pk-meta">${esc(data.meta)}</div>` : ""}
      ${data.description ? `<div class="pk-desc">${esc(data.description)}</div>` : ""}
      <div class="pk-url">${esc(data.url)}</div>
      ${data.foot ? `<div class="pk-foot">${data.foot}</div>` : ""}
    </div>`;
  el.hidden = false;
  place(target, x);
  el.querySelectorAll("img").forEach((img) => img.addEventListener("load", () => current === target && place(target, x), { once: true }));
}

function place(target, x) {
  const r = target.getBoundingClientRect();
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const left = Math.max(16, Math.min(x - w / 3, innerWidth - w - 16));
  let top = r.bottom + 8;
  if (top + h > innerHeight - 16) top = r.top - h - 8;
  if (top < 16) top = Math.max(16, Math.min(innerHeight - h - 16, r.top));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

/**
 * Включить предпросмотр внутри root для элементов selector.
 * describe(element) → данные карточки {title, url, kind, kindLabel, icon, site, meta, description, image, shotKey, foot}
 */
export function bindPeek(root, selector, describe) {
  if (!el) {
    el = document.createElement("div");
    el.className = "peek";
    el.hidden = true;
    el.setAttribute("aria-hidden", "true");
    document.body.append(el);
    for (const ev of ["scroll", "mousedown", "keydown", "blur"]) window.addEventListener(ev, hide, true);
  }
  root.addEventListener("mouseover", (e) => {
    const t = e.target.closest(selector);
    if (!t || t === current || !can()) return;
    if (e.target.closest("button, .chk, input")) return hide();
    hide();
    current = t;
    const x = e.clientX;
    timer = setTimeout(() => {
      const data = describe(t);
      if (data) show(t, data, x);
    }, DELAY);
  });
  root.addEventListener("mouseout", (e) => {
    const t = e.target.closest(selector);
    if (t && !t.contains(e.relatedTarget)) hide();
  });
}
