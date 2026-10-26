import { build } from "esbuild";
import { mkdir, copyFile, readFile, rm, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const pluginRoot = dirname(fileURLToPath(import.meta.url));
if (resolve(process.cwd()) !== pluginRoot)
  throw new Error("Run the build from the plugin workspace.");
const output = resolve("dist");
if (dirname(output) !== pluginRoot)
  throw new Error(
    "Distribution directory must be inside the plugin workspace.",
  );
await rm(output, { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/main.js"],
  outfile: "dist/main.js",
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node22",
  // Obsidian's renderer require does not search a plugin's node_modules.
  // Bundle the SDK and its dependencies; only the host API stays external.
  external: ["obsidian"],
  sourcemap: false,
});
await copyFile("manifest.json", "dist/manifest.json");
await copyFile("dpapi.ps1", "dist/dpapi.ps1");
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
await writeFile(
  "dist/package.json",
  JSON.stringify(
    {
      name: "hcw-second-brain",
      version: manifest.version,
      private: true,
      type: "commonjs",
    },
    null,
    2,
  ),
);
console.log(
  "Built dist/. Copy its contents to .obsidian/plugins/hcw-second-brain/ in a TEST vault first.",
);
