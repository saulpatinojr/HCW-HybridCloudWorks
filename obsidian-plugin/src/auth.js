import { PublicClientApplication } from "@azure/msal-node";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { encryptedCache } from "./cache.js";

export async function createAuth(
  settings,
  showCode,
  { helperPath, networkClient } = {},
) {
  if (process.platform !== "win32")
    throw new Error("The initial HCW plugin release supports Windows desktop.");
  const guid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const name of ["tenantId", "clientId", "audience"])
    if (!guid.test(settings[name] || ""))
      throw new Error(
        "Enter the tenant, desktop client, and API audience from HCW admin.",
      );
  if (!process.env.LOCALAPPDATA)
    throw new Error("Windows local application storage is unavailable.");
  const directory = join(
    process.env.LOCALAPPDATA,
    "HybridCloudWorks",
    "Obsidian",
    settings.clientId,
  );
  await mkdir(directory, { recursive: true });
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
  const token = async (interactive = false) => {
    const accounts = await app.getTokenCache().getAllAccounts();
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
    const result = await app.acquireTokenByDeviceCode({
      scopes,
      deviceCodeCallback: showCode,
    });
    settings.accountId = result.account.homeAccountId;
    return result.accessToken;
  };
  return {
    token,
    signOut: async () => {
      const accounts = await app.getTokenCache().getAllAccounts();
      for (const account of accounts.filter(
        (a) => a.homeAccountId === settings.accountId,
      ))
        await app.getTokenCache().removeAccount(account);
      delete settings.accountId;
    },
  };
}
