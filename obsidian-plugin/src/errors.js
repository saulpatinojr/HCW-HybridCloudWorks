/** Turns a sign-in or cache failure into text that is safe to show and log.
 * Tokens, device codes and other long opaque strings are replaced, so the
 * owner sees what failed and where, but never a credential. */
const OPAQUE = [
  // A JSON Web Token (an access or ID token): three base64url parts.
  /eyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]*/g,
  // Any other long run without spaces (a refresh token, a device code).
  // A GUID (36 characters) and an AADSTS code stay readable.
  /[A-Za-z0-9_\-+/=]{48,}/g,
];

export function safeText(value, max = 300) {
  let text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  for (const pattern of OPAQUE) text = text.replace(pattern, "[hidden]");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function describeError(error) {
  const described = {
    stage: safeText(error?.stage || "unknown", 60),
    code: safeText(error?.errorCode || error?.code || "", 80),
    message: safeText(error?.message || error || "Unknown error."),
  };
  if (error?.detail) described.detail = safeText(error.detail);
  if (error?.correlationId)
    described.correlationId = safeText(error.correlationId, 60);
  return described;
}

export function failureText(error) {
  const { stage, code, message, detail } = describeError(error);
  return [
    `Step: ${stage}.`,
    code && !message.includes(code) ? `${code}:` : "",
    message,
    detail && !message.includes(detail) ? `(${detail})` : "",
  ]
    .filter(Boolean)
    .join(" ");
}
