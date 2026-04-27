#!/usr/bin/env node
// Generate PNG app icons from a hand-drawn volleyball SVG. Sharp's SVG
// renderer keeps the source resolution-independent — we rasterize the
// same 100x100 viewBox up to 192/512/96 with sharp's resize step.
//
// Usage: node scripts/build-icons.mjs

import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = resolve(__dirname, "..", "public");

// Royal blue background, white ball with three classic meridian curves.
// Curves picked so the ball reads as a volleyball at small sizes:
//   - Top arc spans most of the ball, slightly upward.
//   - Two side meridians sweep from outside the ball toward the top
//     center, giving the impression of four panels visible from this
//     angle.
// Stroke width tuned so the panels stay visible at 96px without dominating.
const SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect x="0" y="0" width="100" height="100" rx="18" fill="#1E3EBF"/>
  <circle cx="50" cy="50" r="34" fill="#ffffff"/>
  <g stroke="#1E3EBF" stroke-width="3" fill="none" stroke-linecap="round">
    <path d="M 22 42 Q 50 24 78 42"/>
    <path d="M 22 58 Q 32 38 38 18"/>
    <path d="M 78 58 Q 68 38 62 18"/>
  </g>
</svg>`;

const BG = { r: 30, g: 62, b: 191, alpha: 1 };

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
