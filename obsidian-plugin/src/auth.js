import { PublicClientApplication } from "@azure/msal-node";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { encryptedCache } from "./cache.js";

/** Labels a failure with the sign-in step it came from, and adds the last
 * Microsoft reply the transport saw, so the owner can tell a local cache
 * problem from a Microsoft refusal. Adds text only; never a token. */
function atStep(stage, error, networkClient) {
  const tagged =
    error instanceof Error ? error : new Error(String(error ?? "Unknown"));
  if (!tagged.stage) tagged.stage = stage;
  const detail = networkClient?.lastFailure?.();
  if (detail && !tagged.detail) tagged.detail = detail;
  return tagged;
}

export async function createAuth(
  settings,
  showCode,
  { helperPath, networkClient } = {},
) {
  const fail = (stage, message) =>
    Object.assign(new Error(message), { stage });
  if (process.platform !== "win32")
    throw fail(
      "settings",
      "The initial HCW plugin release supports Windows desktop.",
    );
  const guid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const name of ["tenantId", "clientId", "audience"])
    if (!guid.test(settings[name] || ""))
      throw fail(
        "settings",
        "Enter the tenant, desktop client, and API audience from HCW admin.",
      );
  if (!process.env.LOCALAPPDATA)
    throw fail(
      "token cache",
      "Windows local application storage is unavailable.",
    );
  const directory = join(
    process.env.LOCALAPPDATA,
    "HybridCloudWorks",
    "Obsidian",
    settings.clientId,
  );
  try {
    await mkdir(directory, { recursive: true });
  } catch (error) {
    throw atStep("token cache folder", error);
  }
  const cachePlugin = encryptedCache(
    join(directory, "tokens.cache"),
    helperPath,
  );
  const app = new PublicClientApplication({
    auth: {
      clientId: settings.clientId,
      authority: `https://login.microsoftonline.com/${settings.tenantId}`,
    },
    cache: { cachePlugin },
    ...(networkClient && { system: { networkClient } }),
  });
  const scopes = [`api://${settings.audience}/brain_sync`];
  const readAccounts = async () => {
    try {
      return await app.getTokenCache().getAllAccounts();
    } catch (error) {
      throw atStep("token cache (read)", error);
    }
  };
  const token = async (interactive = false) => {
    networkClient?.clearFailure?.();
    const accounts = await readAccounts();
    const account = accounts.find(
      (a) => a.homeAccountId === settings.accountId,
    );
    if (account) {
      try {
        return (await app.acquireTokenSilent({ account, scopes })).accessToken;
      } catch (error) {
        if (!interactive)
          throw Object.assign(new Error("Sign in again."), { status: 401 });
      }
    }
    if (!interactive)
      throw Object.assign(new Error("Sign in to synchronize."), {
        status: 401,
      });
    let closeCodeDialog;
    let codeShown = false;
    let result;
    networkClient?.clearFailure?.();
    try {
      result = await app.acquireTokenByDeviceCode({
        scopes,
        deviceCodeCallback: (code) => {
          // MSAL does not check the device-code reply's status. When Entra
          // refuses the request there is no code; stop here instead of
          // opening an empty dialog and polling with no device code.
          if (!code?.userCode || !code?.verificationUri)
            throw fail(
              "device code request",
              "Microsoft did not issue a sign-in code.",
            );
          codeShown = true;
          closeCodeDialog = showCode(code);
        },
      });
    } catch (error) {
      throw atStep(
        codeShown ? "waiting for browser sign-in" : "device code request",
        error,
        networkClient,
      );
    } finally {
      if (typeof closeCodeDialog === "function") closeCodeDialog();
    }
    settings.accountId = result.account.homeAccountId;
    return result.accessToken;
  };
  return {
    token,
    signOut: async () => {
      const accounts = await readAccounts();
      for (const account of accounts.filter(
        (a) => a.homeAccountId === settings.accountId,
      ))
        await app.getTokenCache().removeAccount(account);
      delete settings.accountId;
    },
  };
}
