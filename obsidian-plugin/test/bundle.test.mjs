import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire, isBuiltin } from "node:module";
import { runInNewContext } from "node:vm";

test("the distribution loads with Obsidian's host-only package resolution", async () => {
  const source = await readFile(new URL("../dist/main.js", import.meta.url), "utf8");
  const nodeRequire = createRequire(import.meta.url);
  const module = { exports: {} };
  class HostClass {}
  const host = {
    Plugin: HostClass,
    PluginSettingTab: HostClass,
    Modal: HostClass,
    Notice: HostClass,
    TFile: HostClass,
  };
  const context = {
    module,
    exports: module.exports,
    require(name) {
      if (name === "obsidian") return host;
      assert.ok(isBuiltin(name), `Unbundled package lookup: ${name}`);
      return nodeRequire(name);
    },
    process,
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch,
    __dirname: "/virtual/obsidian-plugin",
    __filename: "/virtual/obsidian-plugin/main.js",
  };
  context.global = context;
  runInNewContext(source, context, { timeout: 5000 });
  const plugin = module.exports.default || module.exports;
  assert.equal(typeof plugin, "function");
  assert.ok(plugin.prototype instanceof HostClass);
});
