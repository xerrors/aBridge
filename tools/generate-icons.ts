/** Export canonical C3 assets. Development-only: librsvg and macOS iconutil. */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
const root = resolve(import.meta.dirname, ".."),
  blue = "#0066DD";
const source = await readFile(join(root, "docs/assets/brand/bridge.svg"), "utf8");
const start = source.indexOf('<g id="mark"'),
  end = source.lastIndexOf("</svg>");
if (start < 0 || end < start) throw new Error("Canonical bridge mark is missing");
const mark = source.slice(start, end),
  native = join(root, "apps/desktop/native/assets"),
  extension = join(root, "apps/browser/public/icons");
await mkdir(native, { recursive: true });
await mkdir(extension, { recursive: true });
const work = await mkdtemp(join(tmpdir(), "abridge-icons-"));
const render = (input: string, output: string, width: number) =>
  execFileSync("rsvg-convert", ["-w", String(width), input, "-o", output]);
try {
  const square = join(work, "square.svg"),
    template = join(work, "template.svg");
  const squareText = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g transform="translate(0 10)">${mark}</g></svg>`;
  await writeFile(square, squareText);
  await writeFile(template, squareText.replaceAll(blue, "#000000"));
  render(template, join(native, "StatusIcon.png"), 19);
  render(template, join(native, "StatusIcon@2x.png"), 38);
  for (const size of [16, 32, 48, 128]) render(square, join(extension, `icon-${size}.png`), size);
  const app = join(work, "app.svg");
  await writeFile(
    app,
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect x="64" y="64" width="896" height="896" rx="200" fill="${blue}"/><g transform="translate(208 303) scale(9.5)">${mark.replaceAll(blue, "#FFFFFF")}</g></svg>`,
  );
  render(app, join(native, "AppIcon.png"), 1024);
  const iconset = join(work, "AppIcon.iconset");
  await mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    render(app, join(iconset, `icon_${size}x${size}.png`), size);
    render(app, join(iconset, `icon_${size}x${size}@2x.png`), size * 2);
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(native, "AppIcon.icns")]);
  const wordmark = join(root, "docs/assets/brand/wordmark.svg");
  render(wordmark, join(native, "Wordmark.png"), 171);
  render(wordmark, join(native, "Wordmark@2x.png"), 342);
  for (const target of [join(root, "apps/web/public"), extension]) {
    await cp(join(root, "docs/assets/brand/bridge.svg"), join(target, "brand.svg"));
    await cp(wordmark, join(target, "wordmark.svg"));
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
console.log("Exported canonical C3 assets");
