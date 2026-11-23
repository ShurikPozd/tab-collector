// Небольшие окна в стиле страницы — вместо системных prompt()/confirm().

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function modal(html, { onReady } = {}) {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "dlg dlg-small";
    dlg.innerHTML = `<form method="dialog" class="dlg-body">${html}</form>`;
    document.body.append(dlg);
    dlg.querySelector("[data-cancel]").onclick = () => dlg.close("cancel");
    dlg.addEventListener("close", () => {
      const v = dlg.returnValue;
      const input = dlg.querySelector("input");
      dlg.remove();
      resolve(v === "ok" ? (input ? input.value.trim() : true) : null);
    });
    dlg.querySelector("form").addEventListener("submit", (e) => {
      e.preventDefault();
      const input = dlg.querySelector("input");
      if (!input || input.value.trim()) dlg.close("ok");
    });
    dlg.showModal();
    onReady && onReady(dlg);
  });
}

/** Поле с названием. Возвращает строку или null. */
export function askName(title, value = "") {
  return modal(
    `<header class="dlg-head"><h2>${esc(title)}</h2></header>
     <label class="field"><span class="field-label">Название</span><input type="text" maxlength="60" value="${esc(value)}" required /></label>
     <footer class="dlg-foot"><button type="button" class="ghost" data-cancel>Отмена</button><button type="submit" class="primary">Сохранить</button></footer>`,
    { onReady: (d) => d.querySelector("input").select() }
  );
}

/** Подтверждение. Возвращает true или null. */
export function confirmDlg(title, text, okLabel = "Удалить") {
  return modal(
    `<header class="dlg-head"><h2>${esc(title)}</h2></header>
     <p class="dlg-lead">${esc(text)}</p>
     <footer class="dlg-foot"><button type="button" class="ghost" data-cancel>Отмена</button><button type="submit" class="primary">${esc(okLabel)}</button></footer>`,
    { onReady: (d) => d.querySelector('[type="submit"]').focus() }
  );
}
