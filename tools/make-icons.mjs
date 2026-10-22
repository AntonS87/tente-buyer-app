// Draws the app icons. Run: node tools/make-icons.mjs
import { chromium } from 'playwright';
const svg = (pad) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="${pad ? 0 : 96}" fill="#0b4f1c"/>
  <g transform="translate(256 270) scale(${pad ? 0.72 : 0.9}) translate(-256 -270)">
    <path d="M86 250 C110 130 402 130 426 250 C430 272 406 280 380 270 C320 248 192 248 132 270 C106 280 82 272 86 250Z" fill="#f2a516"/>
    <path d="M200 262 C196 330 186 380 176 410 C200 424 312 424 336 410 C326 380 316 330 312 262 C276 254 236 254 200 262Z" fill="#fff4dc"/>
  </g></svg>`;
const browser = await chromium.launch();
const page = await browser.newPage();
for (const [name, size, pad] of [['icon-192', 192, false], ['icon-512', 512, false], ['icon-maskable-512', 512, true]]) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>body{margin:0}svg{width:${size}px;height:${size}px;display:block}</style>${svg(pad)}`);
  await page.screenshot({ path: `app/icons/${name}.png`, omitBackground: true });
}
await browser.close();
