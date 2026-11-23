// Разбор всех скриптов расширения как ES-модулей и проверка, что импортируемые имена
// действительно экспортируются (опечатка в import роняет страницу целиком).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    if (n === "node_modules" || n === ".git" || n === "tests") continue;
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".js") && !/theme-boot|local-config/.test(n)) files.push(p);
  }
})(root);

let fail = 0;
const exportsOf = new Map();
for (const f of files) {
  const src = readFileSync(f, "utf8");
  try {
    new vm.SourceTextModule(src, { identifier: f });
  } catch (e) {
    if (!/SourceTextModule/.test(String(e))) {
      console.log(`FAIL синтаксис ${relative(root, f)}: ${e.message}`);
      fail++;
    }
  }
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  exportsOf.set(f, names);
}
for (const f of files) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)) {
    const target = resolve(dirname(f), m[2]);
    const have = exportsOf.get(target);
    if (!have) {
      console.log(`FAIL ${relative(root, f)}: нет файла ${m[2]}`);
      fail++;
      continue;
    }
    for (const name of m[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean)) {
      if (!have.has(name)) {
        console.log(`FAIL ${relative(root, f)}: ${m[2]} не экспортирует ${name}`);
        fail++;
      }
    }
  }
}
console.log(`${files.length} файлов, импорты ${fail ? "с ошибками" : "в порядке"}`);
process.exit(fail ? 1 : 0);
