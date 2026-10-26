/** MSAL Node runs in Obsidian's renderer, where global fetch is subject to
 * browser CORS. Use the host's documented native HTTPS transport instead.
 * Credentials stay in memory and are sent only to Microsoft's authority. */
export function createMsalNetworkClient(
  requestUrl,
  { timeoutMs = 30000 } = {},
) {
  const send = async (method, rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "login.microsoftonline.com" ||
      url.port ||
      url.username ||
      url.password ||
      url.hash
    )
      throw new Error(
        "Microsoft sign-in requires the configured HTTPS authority.",
      );
    let timer;
    try {
      const response = await Promise.race([
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
      return {
        status: response.status,
        headers: Object.fromEntries(
          Object.entries(response.headers || {}).map(([key, value]) => [
            key.toLowerCase(),
            String(value),
          ]),
        ),
        body: response.json,
      };
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    sendGetRequestAsync: (url, options) => send("GET", url, options),
    sendPostRequestAsync: (url, options) => send("POST", url, options),
  };
}
