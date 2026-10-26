import { build } from "esbuild";
import { cp, mkdir, copyFile, rm, writeFile } from "node:fs/promises";
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
  external: ["obsidian", "@azure/msal-node"],
  sourcemap: false,
});
await copyFile("manifest.json", "dist/manifest.json");
await copyFile("dpapi.ps1", "dist/dpapi.ps1");
await writeFile(
  "dist/package.json",
  JSON.stringify(
    {
      name: "hcw-second-brain",
      version: "1.0.0",
      private: true,
      type: "commonjs",
    },
    null,
    2,
  ),
);
// Preserve the MSAL package layout. The vault never needs npm or credentials.
await cp("node_modules", "dist/node_modules", {
  recursive: true,
  filter: (path) => !/[\\/](esbuild|@esbuild|\.bin)([\\/]|$)/.test(path),
});
console.log(
  "Built dist/. Copy its contents to .obsidian/plugins/hcw-second-brain/ in a TEST vault first.",
);
