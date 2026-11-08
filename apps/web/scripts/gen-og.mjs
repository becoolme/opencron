// Draws the landing page's 1200x630 share image for each language into public/og/<name>.png, from the hero copy in
// src/landing/copy.ts. The PNGs are committed, so a normal build needs neither sharp nor the fonts; run
// `pnpm --filter @opencron/web og` after changing the hero text. The fonts are macOS system fonts, which cover CJK.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { LANDING } from "../src/landing/copy.ts";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(web, "public", "og");
mkdirSync(outDir, { recursive: true });

const IMAGES = [
  ["en", "en", "Helvetica Neue, Helvetica, Arial, sans-serif"],
  ["zh-Hans", "zh-CN", "PingFang SC, Hiragino Sans GB, sans-serif"],
  ["ja", "ja", "Hiragino Sans, Hiragino Kaku Gothic ProN, sans-serif"],
  ["ko", "ko", "Apple SD Gothic Neo, sans-serif"],
];
const MONO = "Menlo, Courier New, monospace";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const wide = (ch) => /[ᄀ-ᇿ⺀-鿿가-힯＀-￯]/.test(ch);
const width = (s) => [...s].reduce((w, ch) => w + (wide(ch) ? 1 : 0.52), 0);

/** Breaks text into lines of at most `max` em: at spaces for Latin text, between any two characters for CJK. */
function wrap(text, max) {
  const tokens = text.match(/[ᄀ-ᇿ⺀-鿿가-힯＀-￯][、。，！？]?|[^\sᄀ-ᇿ⺀-鿿가-힯＀-￯]+\s*|\s+/g) ?? [];
  const lines = [];
  let cur = "";
  for (const token of tokens) {
    if (cur.trim() && width(cur + token.trimEnd()) > max) {
      lines.push(cur.trimEnd());
      cur = token.trimStart();
    } else cur += token;
  }
  if (cur.trim()) lines.push(cur.trimEnd());
  return lines;
}

const logo = `<rect x="72" y="64" width="56" height="56" rx="14" fill="#2f5bea"/><g transform="translate(72 64) scale(1.75)"><path d="M11 8.5v9M7.1 10.75l7.8 4.5M7.1 15.25l7.8-4.5M24 7l-6.5 18" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></g>`;

// One hour of */5 runs on a strip, the way the landing page's footer draws it.
const strip = Array.from({ length: 13 }, (_, i) => {
  const x = 72 + i * 88;
  return `<rect x="${x - 1.5}" y="520" width="3" height="${i % 3 === 0 ? 30 : 18}" rx="1.5" fill="${i === 8 ? "#2f5bea" : "#0e1411"}"/>`;
}).join("");

function svg(copy, font) {
  // Each part of the title fits on one line where it can: long ones get a smaller size rather than an orphan word.
  const size = Math.min(66, Math.floor(1050 / Math.max(width(copy.hero.titleA), width(copy.hero.titleB))));
  const lh = size * 1.12;
  // The plain part and the accent part each start on their own line, as the hero sets them.
  const lines = [
    ...wrap(copy.hero.titleA, 1056 / size).map((text) => [text, "#0e1411"]),
    ...wrap(copy.hero.titleB, 1056 / size).map((text) => [text, "#2f5bea"]),
  ].slice(0, 3);
  const title = lines
    .map(([text, fill], i) => `<text x="72" y="${236 + i * lh}" font-family="${font}" font-size="${size}" font-weight="700" letter-spacing="-1.6" fill="${fill}">${esc(text)}</text>`)
    .join("");
  const leadY = 236 + (lines.length - 1) * lh + 62;
  const leadLines = wrap(copy.meta.description, 1000 / 27);
  const maxLead = lines.length > 2 ? 2 : 3;
  if (leadLines.length > maxLead) {
    leadLines.length = maxLead;
    leadLines[maxLead - 1] = `${leadLines[maxLead - 1].replace(/\s*\S$/, "")}…`;
  }
  const lead = leadLines
    .map((l, i) => `<text x="72" y="${leadY + i * 38}" font-family="${font}" font-size="27" fill="#5a635d">${esc(l)}</text>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<defs>
<pattern id="grid" width="44" height="44" patternUnits="userSpaceOnUse"><path d="M44 0H0V44" fill="none" stroke="#efefe9" stroke-width="1"/></pattern>
<radialGradient id="glow" cx="1040" cy="40" r="560" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#2f5bea" stop-opacity=".13"/><stop offset=".5" stop-color="#0f9d58" stop-opacity=".04"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
</defs>
<rect width="1200" height="630" fill="#fff"/><rect width="1200" height="630" fill="url(#grid)"/><rect width="1200" height="630" fill="url(#glow)"/>
${logo}
<text x="146" y="104" font-family="${font}" font-size="32" font-weight="600" fill="#0e1411">OpenCron</text>
<rect x="934" y="70" width="194" height="44" rx="22" fill="#fff" stroke="#dfe5fb"/>
<circle cx="958" cy="92" r="5" fill="#2f5bea"/>
<text x="1043" y="100" text-anchor="middle" font-family="${MONO}" font-size="21" fill="#2447c9">*/5 * * * *</text>
${title}${lead}
<path d="M72 535H1128" stroke="#d9dbd2" stroke-width="1"/>${strip}
<text x="1128" y="590" text-anchor="end" font-family="${MONO}" font-size="22" fill="#6f7873">github.com/becoolme/opencron</text>
<text x="72" y="590" font-family="${font}" font-size="22" fill="#6f7873">${esc(copy.hero.note)}</text>
</svg>`;
}

for (const [name, locale, font] of IMAGES) {
  const out = join(outDir, `${name}.png`);
  await sharp(Buffer.from(svg(LANDING[locale], font))).png({ compressionLevel: 9 }).toFile(out);
  console.log(`wrote public/og/${name}.png`);
}
