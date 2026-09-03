import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const siteRoot = dirname(fileURLToPath(import.meta.url));
const imageRoot = resolve(siteRoot, "images");
const localPhotoRoot = resolve(siteRoot, "../../05_餐點照片");
const categories = [
  "burger", "club-sandwich", "danish-pastry", "drink", "egg-pancake",
  "meal-set", "new-item", "noodle", "other", "platter", "shaobing",
  "snail-burger", "thick-toast", "toast", "value-meal", "vegetarian",
  "yaduo-bun",
];

async function webpFiles(directory) {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".webp"))
      .map((entry) => entry.name);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}

let copied = 0;
for (const category of categories) {
  const source = resolve(localPhotoRoot, category);
  const files = await webpFiles(source);
  if (!files.length) continue;
  const destination = resolve(imageRoot, category);
  await mkdir(destination, { recursive: true });
  for (const file of files) {
    await copyFile(resolve(source, file), resolve(destination, file));
    copied += 1;
  }
}

let mealImageCount = 0;
const missingCategories = [];
const deployedImages = new Set();
for (const category of categories) {
  const files = await webpFiles(resolve(imageRoot, category));
  mealImageCount += files.length;
  for (const file of files) deployedImages.add(`${category}/${file}`);
  if (!files.length) missingCategories.push(category);
}

if (mealImageCount < 174 || missingCategories.length) {
  throw new Error(
    `Refusing incomplete deployment: found ${mealImageCount}/174 meal images; ` +
    `empty categories: ${missingCategories.join(", ") || "none"}`,
  );
}

try {
  const urls = (await readFile(resolve(localPhotoRoot, "元氣餐點照片網址.csv"), "utf8"))
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const missingImages = urls.filter((url) => {
    const parts = decodeURIComponent(new URL(url).pathname).split("/").filter(Boolean);
    return !deployedImages.has(parts.slice(-2).join("/"));
  });
  if (urls.length !== 173 || missingImages.length) {
    throw new Error(
      `Refusing incomplete deployment: URL list has ${urls.length}/173 entries and ` +
      `${missingImages.length} missing local images`,
    );
  }
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const headers = await readFile(resolve(siteRoot, "_headers"), "utf8");
if (headers.includes("Content-Security-Policy-Report-Only:")) {
  throw new Error("Refusing deployment with Content-Security-Policy-Report-Only");
}
for (const required of [
  "Content-Security-Policy:",
  "https://static.cloudflareinsights.com",
  "wss://*.firebasedatabase.app",
]) {
  if (!headers.includes(required)) throw new Error(`_headers is missing ${required}`);
}

console.log(`Cloudflare assets ready: ${mealImageCount} meal images (${copied} synced locally)`);
