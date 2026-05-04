#!/usr/bin/env node
// Generate Narwhal Tracker PNG app icons from a hand-drawn narwhal SVG.
// Sharp resamples the same 100x100 viewBox up to 192/512/96 px.
//
// Usage: node scripts/build-icons.mjs

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(__dirname, "..", "public");

const SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" fill="#0A2342"/>
  <ellipse cx="52" cy="55" rx="28" ry="18" fill="#00B4C8"/>
  <path d="M 78 50 Q 90 40 88 58 Q 90 62 78 60 Z" fill="#00B4C8"/>
  <path d="M 55 37 Q 62 28 68 38 Z" fill="#00B4C8"/>
  <line x1="24" y1="50" x2="60" y2="45" stroke="white" stroke-width="3.5" stroke-linecap="round"/>
  <circle cx="40" cy="50" r="2.5" fill="#0A2342"/>
</svg>`;

const BG = { r: 10, g: 35, b: 66, alpha: 1 };

async function emit(size, file) {
  const png = await sharp(Buffer.from(SVG))
    .resize(size, size, { fit: "contain", background: BG })
    .png()
    .toBuffer();
  writeFileSync(resolve(PUBLIC, file), png);
  console.log(`✓ ${file} (${png.length} bytes)`);
}

await emit(192, "icon-192.png");
await emit(512, "icon-512.png");
await emit(96, "badge-96.png");
console.log("done");
