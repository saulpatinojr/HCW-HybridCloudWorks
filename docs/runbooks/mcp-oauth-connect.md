# MCP servers — OAuth Connect

> **Status, 2026-10-08: built, not yet exercised against the live vendors.**
> Replicate MCP and Hostinger MCP sign in with **Connect** on their AI Engine
> cards. Until someone presses Connect, each card reads an amber **Not
> connected** — that is the expected state, not a fault.

## Why these two servers need it

| Server | URL and transport | What it accepts |
| --- | --- | --- |
| Replicate MCP | `https://mcp.replicate.com/sse`, SSE | Only OAuth access tokens from Replicate's own sign-in. The `REPLICATE_API_KEY` bearer is answered `401 invalid_token`, so the key is no longer named on this server. It still serves cover images through Replicate's REST API. |
| Hostinger MCP | `https://mcp.hostinger.com`, Streamable HTTP | Only OAuth access tokens from `auth.hostinger.com`, scope `mcp:use`. The old entry at `http://localhost:8100` was never reachable from the Function App and is gone, as is the localhost-http exception in the URL rule. |

Plaud is also an OAuth server but is **not** connected this way: its token is
pasted on Recording Hub → Connect and refreshed by Plaud's own endpoint.

## What the owner does

Once per server, as a super_admin:

1. Open [AI Engine → MCP Servers](https://hybridcloudworks.com/admin/ai-engine?tab=mcp).
2. On the **Replicate MCP** card press **Connect**. The browser goes to
   Replicate; sign in and approve **HybridCloudWorks**.
3. You come back to the MCP Servers tab. Success is a green banner:
   **"Replicate MCP is connected. N tools synced."** and the card shows
   **Connected**, with when the access token expires.
4. Repeat for **Hostinger MCP** (Hostinger asks to approve `mcp:use`).
5. Switch a server on only when you want it callable. Both ship off, and
   switching them on or off, like calling their tools, is super_admin.

Start from `https://hybridcloudworks.com`, not `www.`: the vendors return the
browser to the apex address, which is the one registered with them.

### Reading the result

| What you see | What it means | What to do |
| --- | --- | --- |
| Green banner, card **Connected** | Signed in, token stored, tools synced | Nothing |
| Amber banner "connected, but its tool sync failed" | The token works; the tool list did not load | Press **Sync Tools** on the card |
| Red "The sign-in was declined at the provider" | You pressed cancel or deny at the vendor | Press **Connect** again |
| Red "took longer than 10 minutes" | A sign-in is valid for ten minutes, once | Press **Connect** again |
| Red "started by a different administrator" | Each administrator completes only the sign-in they started | Press **Connect** yourself |
| Red "not one this site started, or it has already been used" | The callback was replayed, or a newer Connect replaced it | Press **Connect** again |
| Red "Requires super_admin or higher" | Connect, its callback and Disconnect are super_admin | Ask a super_admin |
| Red "came back from …, not from …'s sign-in server" | The redirect named a different issuer (RFC 9207) | Press **Connect** again; if it repeats, the server's metadata is wrong |
| Red "changed while the sign-in was in progress" | The server's URL or sign-in method changed after Connect | Press **Connect** again |
| Card **Sign-in expired** | The vendor refused to renew the token | Press **Connect** |

## How it works

`functions/src/lib/ai/mcp-oauth.js` is the protocol;
`functions/src/lib/ai/mcp-oauth-handlers.js` the three routes.

1. **Connect** (`POST /api/cms/mcp/{serverId}/oauth/start`). The API sends
   the MCP server one unauthenticated request and reads the 401's
   `WWW-Authenticate` for a `resource_metadata` URL (Hostinger sends one,
   Replicate does not). It reads the protected-resource metadata (RFC 9728)
   from that URL, else from `/.well-known/oauth-protected-resource` with the
   server's path appended, else at its origin; then the authorization
   server's metadata (RFC 8414, falling back to OpenID configuration). It
   refuses a server without PKCE `S256` or without a `registration_endpoint`,
   and any endpoint that is not https, with a sentence naming which. It
   registers the site once per authorization server by dynamic client
   registration (RFC 7591) as a public client, and reuses that registration
   until the issuer or the redirect URI changes. It stores the pending
   sign-in — the SHA-256 of `state`, the PKCE verifier, who started it, a
   ten-minute expiry — write-only on the server's document, and returns the
   vendor's sign-in URL with `resource` (RFC 8707) and the scopes the
   resource itself lists — for Hostinger `scope=mcp:use`, for Replicate none.
2. The vendor redirects to
   `https://hybridcloudworks.com/admin/ai-engine/oauth/callback` with `code`
   and `state`.
3. **Complete** (`POST /api/cms/mcp/oauth/complete`). The API finds the
   server by the state's hash, refuses another administrator's, an expired
   or a spent state, spends it, refuses a redirect whose `iss` (RFC 9207)
   is not the issuer verbatim and a server that moved meanwhile, exchanges
   the code at the token endpoint discovered in step 1, stores the access
   and refresh tokens write-only (under the ETag the spend left, so a server
   moved during the exchange answers SERVER_CHANGED and keeps no token),
   clears the card's last error, runs the same tool sync as **Sync Tools**,
   and writes an `admin_audit_logs` row (`mcp_oauth_connected`).
4. **Use.** Before any call, a token with under two minutes left is
   refreshed (standard refresh grant). A 401 from the server earns one
   refresh and one retry. A refresh the vendor refuses clears the tokens and
   turns the card to **Sign-in expired**; an outage at the vendor changes
   nothing.
5. **Timer.** `refreshPlaudToken` (every 12 hours, flag
   `REFRESH_PLAUD_TOKEN`) now also refreshes every Connect server whose token
   expires within 30 minutes or already has, so an idle server's refresh
   token keeps renewing. Its name, flag and schedule are unchanged. Calls do
   not depend on it: step 4 refreshes on demand.
6. **Disconnect** (`POST /api/cms/mcp/{serverId}/oauth/disconnect`) first
   revokes the grant at the vendor (RFC 7009: the refresh token, then the
   access token, POSTed to the `revocation_endpoint` the sign-in's metadata
   named, with the registered client credentials; #1116), then deletes the
   tokens and the connection, keeps the registration, and audits
   `mcp_oauth_disconnected` with `revoked`. The local delete happens whatever
   the vendor answers. The response's `revoked` is `true`, `false` (a
   non-2xx, no answer or a timeout — the card then says the grant may still
   be live at the vendor, and `reason` says why) or `null` (the vendor
   advertises no revocation endpoint, or the connection predates its
   storage). Podbean advertises one (`https://mcp.podbean.com/revoke`, read
   2026-10-13); Replicate and Hostinger did not when read. Where it is
   `false` or `null`, revoke the grant by removing HybridCloudWorks from the
   authorized apps in the vendor account.

Every request the flow makes goes through the SSRF guard
(`lib/http/guarded-fetch.js`) with https required on every hop, and the
requests that carry a secret follow no redirect at all. No config write can
set the flow's fields (`oauth`, `oauthClient`, `oauthClientSecret`,
`oauthPending`) — not whole, and not by a nested path such as
`oauth.tokenEndpoint`, which the config routes refuse outright — and reads
never return the tokens, the client secret or the pending sign-in. Changing
a connected server's URL disconnects it. An SSE stream that names its message
endpoint on another host or over http does not get the token.

## Who can do what

A Connect token is the vendor account of the super_admin who signed in, and
Hostinger's tools can change VPS, DNS and domain settings. So for a server
that signs in with Connect:

| Action | Role |
| --- | --- |
| Connect, Reconnect, Disconnect | super_admin |
| Switch the server on or off, change its sign-in method (`authType`) | super_admin |
| Delete the server | super_admin |
| Call its tools (Playground, `mcpProxy`) | super_admin |
| Sync Tools (reads the tool list) | editor |

No configuration write can set a Connect server's tokens; only Connect does. Every other server keeps the editor gate it had. Neither Connect server has
an `allowedTools` list yet, so a super_admin can call any of its tools; keep
Hostinger switched off except while you are using it, and give it a list
once its tool names are known (as #995 did for Publer).

## Limits worth knowing

- **One instance refreshes at a time, per process.** Two Function App
  instances refreshing the same server in the same second can trip a
  vendor's refresh-token reuse detection, which ends the grant; the card
  then reads **Sign-in expired** and Connect fixes it.
- **Backups include the tokens.** `mcp_servers` is exported whole, so the
  Cosmos backups hold the access and refresh tokens, the client secret (none
  for these two, which register as public clients) and any pending sign-in,
  as they already held Plaud's token.
