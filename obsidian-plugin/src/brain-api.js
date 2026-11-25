import { requestUrl } from "obsidian";

/** The site's Second Brain API at `baseUrl`. `getToken` is asked for a fresh
 * sign-in token on every call. */
export function brainApi(baseUrl, getToken) {
  const call = async (action, method = "GET", body) => {
    const token = await getToken();
    const response = await requestUrl({
      url: `${baseUrl}/cms/brain/${action}`,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body && { body: JSON.stringify(body) }),
      throw: false,
    });
    if (response.status >= 400)
      throw Object.assign(new Error("HCW sync request failed."), {
        status: response.status,
        details: response.json,
      });
    return response.json;
  };
  return {
    push: (body) => call("sync", "POST", body),
    pull: (cursor) => call(`sync?cursor=${cursor}`),
    references: (cursor) =>
      call(
        `sync-references${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
      ),
    status: (body) => call("sync-status", "POST", body),
  };
}
