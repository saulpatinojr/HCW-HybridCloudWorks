// Ages as the admin pages say them: "just now", "3 min ago", "2 h ago",
// "5 d ago". Each step is used below its limit in seconds.
const AGE_STEPS = [
  [60, () => 'just now'],
  [3600, (seconds) => `${Math.floor(seconds / 60)} min ago`],
  [86400, (seconds) => `${Math.floor(seconds / 3600)} h ago`],
  [Infinity, (seconds) => `${Math.floor(seconds / 86400)} d ago`],
];

/** "3 min ago" for an ISO time, or null when there is none to describe. */
export function relativeTime(iso, now = Date.now()) {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  const seconds = Math.round((now - then) / 1000);
  // The last step also takes a non-number (a bad `now`), as days.
  const [, say] = AGE_STEPS.find(([limit]) => seconds < limit) || AGE_STEPS[AGE_STEPS.length - 1];
  return say(seconds);
}
