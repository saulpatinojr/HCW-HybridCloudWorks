import { safeText } from "./errors.js";

/** True only for plain https://login.microsoftonline.com URLs: no port,
 * user name, password or #fragment. */
const isAuthority = (url) =>
  url.protocol === "https:" &&
  url.hostname === "login.microsoftonline.com" &&
  ![url.port, url.username, url.password, url.hash].some(Boolean);

/** MSAL Node runs in Obsidian's renderer, where global fetch is subject to
 * browser CORS. Use the host's documented native HTTPS transport instead.
 * Credentials stay in memory and are sent only to Microsoft's authority.
 *
 * MSAL replaces a transport failure with a generic "network_error", and it
 * does not check the status of the device-code reply at all, so the client
 * keeps the last failure (endpoint, HTTP status, Entra's error code and
 * description, never a request or response body) for the caller to report. */
export function createMsalNetworkClient(
  requestUrl,
  { timeoutMs = 30000 } = {},
) {
  let lastFailure = null;
  const send = async (method, rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    if (!isAuthority(url))
      throw new Error(
        "Microsoft sign-in requires the configured HTTPS authority.",
      );
    const endpoint = url.pathname.split("/").filter(Boolean).at(-1) || "/";
    const remember = (text) => {
      lastFailure = safeText(`Microsoft ${endpoint}: ${text}`);
    };
    let timer;
    let response;
    try {
      response = await Promise.race([
        Promise.resolve().then(() =>
          requestUrl({
            url: url.href,
            method,
            headers: options.headers || {},
            ...(method === "POST" && { body: options.body || "" }),
            throw: false,
          }),
        ),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(new Error("Microsoft sign-in request timed out. Retry.")),
            timeoutMs,
          );
        }),
      ]);
    } catch (error) {
      remember(`request failed: ${error?.message || error}`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
    let body;
    try {
      // Obsidian's `json` is a getter that parses on read and throws on
      // text that is not JSON (a proxy's HTML page, for example).
      body = response.json;
    } catch {
      remember(`HTTP ${response.status}, reply was not JSON`);
      throw new Error(
        `Microsoft returned an unreadable reply (HTTP ${response.status}).`,
      );
    }
    if (
      response.status >= 400 &&
      !(body && body.error === "authorization_pending")
    ) {
      const description = String(body?.error_description || "").split(
        /\r?\n/,
      )[0];
      remember(
        `HTTP ${response.status} ${body?.error || "error"}${description ? ` ${description}` : ""}`,
      );
    }
    return {
      status: response.status,
      headers: Object.fromEntries(
        Object.entries(response.headers || {}).map(([key, value]) => [
          key.toLowerCase(),
          String(value),
        ]),
      ),
      body,
    };
  };
  return {
    sendGetRequestAsync: (url, options) => send("GET", url, options),
    sendPostRequestAsync: (url, options) => send("POST", url, options),
    lastFailure: () => lastFailure,
    clearFailure: () => {
      lastFailure = null;
    },
  };
}
