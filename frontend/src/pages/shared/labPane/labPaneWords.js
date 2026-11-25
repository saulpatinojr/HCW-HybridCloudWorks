/**
 * The lab page's fixed sentences and button styles, shared by LabPanePage.jsx
 * (which re-exports the sentences its tests read) and its sign-in step.
 */
import { loadTurnstile, turnstileSiteKey } from '@/lib/turnstile';

export const SIGN_IN_HEADING = 'Sign in with GitHub to open your lab workspace';
export const VISITOR_START_BUTTON = 'Start visitor session';
/** How long the pane waits before it reads the status again after "your session is still being set up" (409). */
export const VISITOR_START_REREAD_MS = 5000;
export const VISITOR_CAPACITY_FULL_REASON =
  'The lab is currently at full capacity (visitor limit reached). Please try again in a few minutes, or sign in if you are a team member.';
export const DEFAULT_TURNSTILE = Object.freeze({
  siteKey: turnstileSiteKey(),
  load: loadTurnstile,
});
/**
 * The fallback clause is for a return this page cannot hear: storage that
 * is blocked, or a visit on www, whose storage the returning tab (always on
 * the apex, where #750 redirects) does not share.
 */
export const SIGN_IN_PENDING_SENTENCE =
  "Finish signing in with GitHub in the new tab. Your workspace opens here when you're done; if it doesn't, choose I've already signed in.";

export const MUTED = 'text-slate-600 dark:text-slate-400';
export const BUTTON =
  'inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary';
export const PRIMARY = `${BUTTON} bg-primary text-primary-foreground hover:opacity-90`;
export const SECONDARY = `${BUTTON} border border-slate-300 dark:border-slate-600 text-slate-900 dark:text-slate-100 hover:bg-slate-100 dark:hover:bg-slate-800`;
export const LINK =
  'font-semibold text-slate-900 dark:text-slate-100 underline underline-offset-4 hover:text-primary';
