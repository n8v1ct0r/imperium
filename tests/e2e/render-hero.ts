// Renders the hero still the console paints first (DESIGN.md section 11, docs/decisions.md
// SHIP.11): the 3D map's fixed hero view, terrain only, at 1600x1200. Run after `pnpm build`
// whenever the terrain, the cloud or the hero camera changes:
//
//   pnpm build && pnpm hero:still && pnpm build
//
// The image is committed at apps/console/public/hero/hero-still.webp. Headless Chrome needs
// SwiftShader for WebGL; PLAYWRIGHT_CHROME may point at a cached Chrome for Testing build.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const out = join(root, "apps/console/out");
const target = join(root, "apps/console/public/hero/hero-still.webp");
const W = 1600;
const H = 1200;
/** The honesty strip sits above the map; the map fills the rest of the window. */
const STRIP_H = 32;

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};

const server = createServer((req, res) => {
  let path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  if (path.endsWith("/")) path += "index.html";
  const file = join(out, path);
  try {
    if (!statSync(file).isFile()) throw new Error("not a file");
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const port = typeof address === "object" && address !== null ? address.port : 0;

const browser = await chromium.launch({
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  ...(process.env.PLAYWRIGHT_CHROME ? { executablePath: process.env.PLAYWRIGHT_CHROME } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: W, height: H + STRIP_H } });
  await page.goto(`http://127.0.0.1:${port}/?hero-still`);
  await page.addStyleTag({
    content:
      "[data-honesty-strip], .console > :not(.map), .map-note, .cesium-widget-credits { visibility: hidden !important; }",
  });
  await page.waitForSelector(".map-canvas[data-cloud='done']", { timeout: 120_000 });
  // A few frames after the last cloud part, so every point is drawn.
  await page.waitForTimeout(1500);
  const png = await page.locator(".map").screenshot({ type: "png" });
  // Encode in the page: Chrome writes WebP, and the repo needs no image tool for it.
  const webp = (await page.evaluate(`(async () => {
    const img = new Image();
    img.src = "data:image/png;base64,${png.toString("base64")}";
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    c.getContext("2d").drawImage(img, 0, 0);
    return c.toDataURL("image/webp", 0.6).split(",")[1];
  })()`)) as string;
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, Buffer.from(webp, "base64"));
  process.stdout.write(`render-hero: ${W}x${H}, ${Math.round(statSync(target).size / 1024)} KB\n`);
} finally {
  await browser.close();
  server.close();
}
