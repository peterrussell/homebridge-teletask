#!/usr/bin/env node
// Vendors the teletask-api library source into the plugin at ./lib/teletask-api so the
// plugin is fully self-contained for install — WITHOUT committing the duplicated code to
// git (./lib is gitignored). Run it yourself via "npm run bundle" (as your normal user,
// never under sudo). It is NOT wired to the "prepare"/install lifecycle on purpose: running
// it under `sudo npm install` would leave ./lib owned by root and break the next plain
// `npm run bundle`. Idempotent and tolerant: if the library source isn't next to the plugin
// (e.g. in an already-installed copy) but a bundled copy exists, it does nothing.
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(pluginRoot, "..", "src"); // the teletask-api library (repo src/)
const dest = join(pluginRoot, "lib", "teletask-api");

if (existsSync(join(src, "index.js"))) {
  try {
    rmSync(dest, { recursive: true, force: true });
  } catch (err) {
    console.error(`[bundle-lib] ERROR: could not clear ${dest}: ${err.message}`);
    console.error(
      "[bundle-lib] This usually means ./lib is owned by root (a previous `sudo npm install`\n" +
        "            ran the bundle as root). Fix the ownership, then re-run as your normal user:\n" +
        `              sudo rm -rf "${join(pluginRoot, "lib")}"\n` +
        "              npm run bundle"
    );
    process.exit(1);
  }
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
  // type:module so the vendored .js files are treated as ES modules under the CJS plugin.
  writeFileSync(
    join(dest, "package.json"),
    JSON.stringify({ name: "teletask-api", type: "module", main: "index.js" }, null, 2) + "\n"
  );
  console.log("[bundle-lib] vendored teletask-api ->", dest);
} else if (existsSync(join(dest, "index.js"))) {
  console.log("[bundle-lib] teletask-api already bundled; nothing to do");
} else {
  console.warn("[bundle-lib] WARNING: library source not found and no bundled copy present");
}
