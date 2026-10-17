// Bans raw colors outside theme tokens (src/theme.css). Pixel values in
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
        if (raw.test(line)) bad.push(`${p}:${i + 1}: ${line.trim()}`);
      });
    }
  }
};
walk("src");
if (bad.length) {
  console.error("raw colors outside theme tokens:\n" + bad.join("\n"));
  process.exit(1);
}
