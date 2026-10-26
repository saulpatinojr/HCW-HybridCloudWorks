import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dpapi, encryptedCache } from "../src/cache.js";

test(
  "Windows DPAPI encrypts and decrypts a synthetic cache without storing plaintext",
  { skip: process.platform !== "win32" },
  async () => {
    const helper = resolve("dpapi.ps1");
    const synthetic = JSON.stringify({
      testOnly: "synthetic-token-never-issued-研究",
    });
    const encrypted = await dpapi("Protect", synthetic, helper);
    assert.ok(!encrypted.includes("synthetic-token"));
    assert.equal(await dpapi("Unprotect", encrypted, helper), synthetic);
    const directory = await mkdtemp(join(tmpdir(), "hcw-brain-cache-test-"));
    const path = join(directory, "test.cache");
    const cache = encryptedCache(path, helper);
    let loaded;
    const tokenCache = {
      serialize: () => synthetic,
      deserialize: (v) => {
        loaded = v;
      },
    };
    await cache.beforeCacheAccess({ tokenCache });
    await cache.afterCacheAccess({ tokenCache, cacheHasChanged: true });
    assert.ok(!(await readFile(path, "utf8")).includes("synthetic-token"));
    await cache.beforeCacheAccess({ tokenCache });
    await cache.afterCacheAccess({ tokenCache, cacheHasChanged: false });
    assert.equal(loaded, synthetic);
  },
);
