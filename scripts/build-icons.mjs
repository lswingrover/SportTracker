#!/usr/bin/env node
// Generate PNG app icons from inline SVGs at the sizes Chrome's PWA
// installability check requires (192 + 512), plus a 96px badge for
// push notifications. Run once, commit the outputs.
//
// Usage: node scripts/build-icons.mjs

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(__dirname, "..", "public");

function svgFor(size) {
  // Emoji rendering across librsvg is inconsistent; we draw the
  // volleyball geometrically (white disc with black panel curves) so
  // the result is identical on every renderer. Royal-blue background
  // mirrors the theme.
  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.34;
  const cornerRadius = size * 0.18;
  const wordmark = size >= 192 ? Math.round(size * 0.16) : 0;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${cornerRadius}" fill="#1E3EBF"/>
  <g>
    <circle cx="${cx}" cy="${cy - (wordmark ? size * 0.08 : 0)}" r="${r}" fill="#ffffff"/>
    <g stroke="#0a0a14" stroke-width="${size * 0.012}" fill="none" stroke-linecap="round">
      <path d="M ${cx - r} ${cy - (wordmark ? size * 0.08 : 0)} Q ${cx} ${cy - r * 1.4 - (wordmark ? size * 0.08 : 0)}, ${cx + r} ${cy - (wordmark ? size * 0.08 : 0)}" />
      <path d="M ${cx - r * 0.92} ${cy + r * 0.4 - (wordmark ? size * 0.08 : 0)} Q ${cx - r * 0.1} ${cy + r * 0.05 - (wordmark ? size * 0.08 : 0)}, ${cx + r * 0.4} ${cy + r * 0.94 - (wordmark ? size * 0.08 : 0)}" />
      <path d="M ${cx - r * 0.4} ${cy + r * 0.94 - (wordmark ? size * 0.08 : 0)} Q ${cx + r * 0.1} ${cy + r * 0.05 - (wordmark ? size * 0.08 : 0)}, ${cx + r * 0.92} ${cy + r * 0.4 - (wordmark ? size * 0.08 : 0)}" />
    </g>
  </g>
  ${wordmark ? `<text x="${cx}" y="${size * 0.92}" text-anchor="middle" font-family="Arial,sans-serif" font-weight="900" font-size="${wordmark}" fill="#ffffff">208</text>` : ""}
</svg>`;
}

async function emit(size, file) {
  const png = await sharp(Buffer.from(svgFor(size))).png().toBuffer();
  writeFileSync(resolve(PUBLIC, file), png);
  console.log(`✓ ${file} (${png.length} bytes)`);
}

await emit(192, "icon-192.png");
await emit(512, "icon-512.png");
await emit(96, "badge-96.png");

console.log("done");
