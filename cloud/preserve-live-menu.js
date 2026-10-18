#!/usr/bin/env node
/* Branding-only release helper. Run AFTER build.js and BEFORE wrangler deploy.
   Keep the cloud station's published recipes/options byte-for-byte rather than
   replacing them with an older local export. Requires Node 22. Fails closed. */
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

(async () => {
  const files = ["recipes.json", "addons.json"];
  const downloads = [];
  for (const name of files) {
    const response = await fetch(`https://station.thirstybeaches.com/${name}`, {
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`${name}: HTTP ${response.status}; do not deploy`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const data = JSON.parse(bytes.toString("utf8"));
    if (name === "recipes.json" && (!data.recipes || typeof data.recipes !== "object")) {
      throw new Error("Invalid live recipes; do not deploy");
    }
    if (name === "addons.json" && !Array.isArray(data.groups)) {
      throw new Error("Invalid live options; do not deploy");
    }
    downloads.push({ name, bytes });
  }
  // Only replace build output after BOTH live menu files pass validation.
  for (const { name, bytes } of downloads) {
    fs.writeFileSync(path.join(__dirname, "public", name), bytes);
    console.log(`Preserved live ${name}: ${createHash("sha256").update(bytes).digest("hex")}`);
  }
})().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
