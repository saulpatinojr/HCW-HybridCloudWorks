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

const STAGE = "token cache (Windows encryption)";
const cacheError = (message, code) =>
  Object.assign(new Error(message), { stage: STAGE, ...(code && { code }) });

/** Explains a helper failure from its exit code and a pattern match on what
 * PowerShell wrote to stderr. The stderr text itself is never shown or logged:
 * the helper reads token data, so only these fixed sentences leave here.
 * dpapi.ps1 exits 3 when Windows' encryption call itself fails; any other
 * non-zero code means PowerShell did not run the script. */
export function helperFailure(exitCode, stderr = "") {
  if (/running scripts is disabled|execution ?polic/i.test(stderr))
    return cacheError(
      "PowerShell's execution policy blocked the cache helper (dpapi.ps1). No plaintext cache was written.",
      "helper_execution_policy",
    );
  if (/not digitally signed|cannot be loaded|is blocked|Zone\.Identifier/i.test(stderr))
    return cacheError(
      "Windows blocked the cache helper (dpapi.ps1) as unsigned or downloaded. No plaintext cache was written.",
      "helper_blocked",
    );
  if (exitCode === 3)
    return cacheError(
      "Windows refused encrypted token storage (DPAPI). No plaintext cache was written.",
      "dpapi_refused",
    );
  return cacheError(
    `The cache helper (dpapi.ps1) did not run; PowerShell exit code ${Number.isInteger(exitCode) ? exitCode : "none"}. No plaintext cache was written.`,
    "helper_failed",
  );
}

/** Fixed, packaged helper; secrets travel on stdin/stdout, never in arguments.
 * No execution-policy override, native unsigned addon, or plaintext fallback. */
export function dpapi(mode, input, helperPath) {
  if (!isAbsolute(helperPath || "") || !["Protect", "Unprotect"].includes(mode))
    throw cacheError(
      "The packaged Windows cache helper is required.",
      "helper_missing",
    );
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
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(
        cacheError(
          "The encrypted cache helper (dpapi.ps1) timed out after 15 seconds.",
          "helper_timeout",
        ),
      );
    }, 15000);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(
        cacheError(
          `Windows PowerShell could not be started (${error?.code || "unknown"}).`,
          "helper_spawn",
        ),
      );
    });
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) child.kill();
      else chunks.push(chunk);
    });
    // Kept only to classify the failure (see helperFailure); never logged.
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8192) stderr += chunk.toString("utf8");
    });
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (bytes > 4 * 1024 * 1024)
        reject(
          cacheError(
            "The cache helper returned too much data. No plaintext cache was written.",
            "helper_oversize",
          ),
        );
      else if (code !== 0) reject(helperFailure(code, stderr));
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
        throw cacheError(
          `Another HCW sign-in is using the encrypted cache (${cachePath}.lock). Retry, or delete that file if Obsidian is the only program using it.`,
          "cache_locked",
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
