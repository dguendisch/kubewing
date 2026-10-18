// Bans raw colors outside theme tokens (src/theme.css) and keeps the
// overridable token list in sync with them. Pixel values in
// TSX/TS are allowed only for grid metrics, which are listed explicitly.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const raw = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
const bad = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(tsx?|css)$/.test(f) && !p.endsWith("theme.css") && !/\.test\.ts$/.test(f)) {
      readFileSync(p, "utf8").split("\n").forEach((line, i) => {
        if (raw.test(line)) bad.push(`${p}:${i + 1}: raw color: ${line.trim()}`);
      });
    }
  }
};
walk("src");

// themeTokens (the tokens theme files may override) must list exactly the tokens theme.css defines
const themeCss = readFileSync("src/theme.css", "utf8");
// runtime readers (grid canvas, Monaco, safety colors) need every token emitted
if (!/@theme static\s*\{/.test(themeCss)) bad.push("src/theme.css: use `@theme static` so unused tokens are still emitted as CSS variables");
const defined = [...themeCss.matchAll(/--color-([a-z0-9-]+):/g)].map((m) => m[1]).sort();
const listed = [...readFileSync("src/store/config.ts", "utf8").match(/themeTokens = \[([^\]]*)\]/)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
if (defined.join() !== listed.join()) bad.push(`src/store/config.ts: themeTokens ${listed} != theme.css tokens ${defined}`);

if (bad.length) {
  console.error("theme token lint:\n" + bad.join("\n"));
  process.exit(1);
}
