import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const source = new URL("../public/", import.meta.url);
const output = new URL("../docs/", import.meta.url);

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
mkdirSync(new URL("data/", output), { recursive: true });

const app = readFileSync(new URL("app.js", source), "utf8")
  .replaceAll('fetch("/data/', 'fetch("./data/');
const styles = readFileSync(new URL("styles.css", source), "utf8");
const assetVersion = createHash("sha256").update(app).update(styles).digest("hex").slice(0, 12);
const html = readFileSync(new URL("index.html", source), "utf8")
  .replace('href="/public/styles.css"', `href="./styles.css?v=${assetVersion}"`)
  .replace('src="/public/app.js"', `src="./app.js?v=${assetVersion}"`);

writeFileSync(new URL("index.html", output), html);
writeFileSync(new URL("app.js", output), app);
cpSync(new URL("styles.css", source), new URL("styles.css", output));
cpSync(new URL("../data/dashboard.json", import.meta.url), new URL("data/dashboard.json", output));
cpSync(new URL("../data/recommendations.json", import.meta.url), new URL("data/recommendations.json", output));
cpSync(new URL("../data/technical-history.json", import.meta.url), new URL("data/technical-history.json", output));
writeFileSync(fileURLToPath(new URL(".nojekyll", output)), "");

console.log("Built static site in docs/.");
