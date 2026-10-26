import { spawn } from "node:child_process";
import {
  readFile,
  writeFile,
  rename,
  open,
  unlink,
  stat,
} from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

/** Fixed, packaged helper; secrets travel on stdin/stdout, never in arguments.
 * No execution-policy override, native unsigned addon, or plaintext fallback. */
export function dpapi(mode, input, helperPath) {
  if (!isAbsolute(helperPath || "") || !["Protect", "Unprotect"].includes(mode))
    throw new Error("The packaged Windows cache helper is required.");
  return new Promise((resolve, reject) => {
    const child = spawn(
      join(
        process.env.SystemRoot || "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      ["-NoProfile", "-NonInteractive", "-File", helperPath, "-Mode", mode],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const chunks = [];
    let bytes = 0;
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("Encrypted cache helper timed out."));
    }, 15000);
    child.on("error", () => {
      clearTimeout(timeout);
      reject(new Error("Windows encrypted cache is unavailable."));
    });
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) child.kill();
      else chunks.push(chunk);
    });
    // Drain without logging: helper failures must never disclose token data.
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0 || bytes > 4 * 1024 * 1024)
        reject(
          new Error(
            "Windows refused encrypted token storage. No plaintext cache was written.",
          ),
        );
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    child.stdin.end(input);
  });
}

export function encryptedCache(cachePath, helperPath) {
  let lock;
  const release = async () => {
    if (lock) {
      await lock.close();
      lock = null;
      await unlink(`${cachePath}.lock`).catch(() => {});
    }
  };
  return {
    async beforeCacheAccess(context) {
      for (let attempt = 0; attempt < 50; attempt++) {
        try {
          lock = await open(`${cachePath}.lock`, "wx");
          break;
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
          const info = await stat(`${cachePath}.lock`).catch(() => null);
          if (info && Date.now() - info.mtimeMs > 60000)
            await unlink(`${cachePath}.lock`).catch(() => {});
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
      }
      if (!lock)
        throw new Error(
          "Another HCW sign-in is using the encrypted cache. Retry.",
        );
      try {
        const encrypted = await readFile(cachePath, "utf8").catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (encrypted)
          context.tokenCache.deserialize(
            await dpapi("Unprotect", encrypted, helperPath),
          );
      } catch (error) {
        await release();
        throw error;
      }
    },
    async afterCacheAccess(context) {
      try {
        if (context.cacheHasChanged) {
          const ciphertext = await dpapi(
            "Protect",
            context.tokenCache.serialize(),
            helperPath,
          );
          const temporary = `${cachePath}.${randomUUID()}.tmp`;
          try {
            await writeFile(temporary, ciphertext, { flag: "wx" });
            await rename(temporary, cachePath);
          } finally {
            await unlink(temporary).catch(() => {});
          }
        }
      } finally {
        await release();
      }
    },
  };
}
