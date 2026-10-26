/**
 * The Calendar Alerts pop-up: when an admin signs in to the portal and some of
 * their open alerts are due within a week (or overdue), a dialog lists them
 * with Done, Snooze and Open link.
 *
 * Owner request 2026-10-26: "Calendar Alerts when I log into the Admin portal
 * (popup window or iframe)". A dialog, not an iframe: nothing here loads
 * another page, so there is no frame to size or to allow in the site's
 * content-security policy.
 *
 * WHEN IT OPENS. After the alerts have been read, if at least one is open and
 * due within DUE_SOON_DAYS or overdue, and it has not been shown in this
 * browser session or on this UTC day (lib/calendarAlerts.js shouldShowPrompt).
 * Closing it does not forget the alerts: they are listed again tomorrow while
 * they are still due, and always on the Calendar page.
 *
 * WHERE IT EXISTS. Only inside the admin layout, which only renders behind
 * the sign-in guard, and only for an editor or above (the server's role for
 * these routes). It is not reachable from a public page.
 *
 * IT NEVER BLOCKS SIGN-IN. The read happens after the portal has rendered. If
 * it fails, the only effect is a small notice with a Try again button; the
 * portal is already usable. CalendarAlertsGate catches even a failure to load
 * this file.
 *
 * KEYBOARD. It is a Radix dialog (components/ui/dialog.jsx): role "dialog"
 * with a title and description, focus moves into it and stays there, Escape
 * closes it, and focus returns to where it was.
 */
import React, { useCallback, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useToast } from '@/components/ui/use-toast';
import { useAdminRole } from '@/hooks/useAdminRole';
import { satisfiesRole } from '@/config/adminNav';
import {
  DUE_SOON_DAYS,
  markPromptShown,
  selectPromptAlerts,
  shouldShowPrompt,
} from '@/lib/calendarAlerts';
import { AlertBody, AlertLinkButton, SnoozeButtons } from './AlertParts';
import useCalendarAlerts from './useCalendarAlerts';

export const CALENDAR_ALERTS_HREF = '/admin/calendar#alerts';

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What the dialog says it is about, from how many alerts it lists. */
export function promptSummary(count) {
  if (count === 0) return 'Nothing else is due. You are all caught up.';
  return `${plural(count, 'alert')} ${count === 1 ? 'is' : 'are'} overdue or due within ${DUE_SOON_DAYS} days.`;
}

export default function CalendarAlertsPrompt() {
  const role = useAdminRole();
  const allowed = satisfiesRole(role, 'editor');
  const navigate = useNavigate();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [noticeDismissed, setNoticeDismissed] = useState(false);
  const dialogRef = useRef(null);

  // Decide after each read that lands (the first, or a Try again): open if
  // something is due and the browser has not been shown the pop-up in this
  // session or on this UTC day. shouldShowPrompt is what keeps a second read
  // from opening it a second time.
  const decide = useCallback(({ alerts: read, today: day }) => {
    if (selectPromptAlerts(read).length > 0 && shouldShowPrompt(day)) {
      markPromptShown(day);
      setOpen(true);
    }
  }, []);

  const alerts = useCalendarAlerts({ enabled: allowed, onLoaded: decide });
  const { status, reload } = alerts;
  const due = selectPromptAlerts(alerts.alerts);

  const retry = useCallback(() => {
    setNoticeDismissed(false);
    reload();
  }, [reload]);

  /** Run one action and say so in a toast if the server refused it. */
  const act = useCallback(
    async (work) => {
      try {
        await work();
      } catch (error) {
        toast({
          title: 'That change was not saved',
          description: error?.message || 'Try again in a moment.',
          variant: 'destructive',
        });
      }
    },
    [toast]
  );

  const goTo = useCallback(
    (href) => {
      setOpen(false);
      navigate(href);
    },
    [navigate]
  );

  if (!allowed) return null;

  return (
    <>
      {status === 'error' && !noticeDismissed && (
        <div
          role="status"
          className="fixed bottom-4 left-4 z-40 max-w-sm rounded-md border border-border bg-card p-3 text-sm shadow-md"
        >
          <p>
            Calendar alerts could not be loaded just now. Signing in worked, and the rest of the
            portal is not affected.
          </p>
          <div className="mt-2 flex gap-2">
            <Button type="button" size="sm" variant="outline" onClick={retry}>
              Try again
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setNoticeDismissed(true)}
            >
              Dismiss
            </Button>
          </div>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent
          ref={dialogRef}
          className="max-h-[85dvh] max-w-xl overflow-y-auto"
          // The pop-up opens by itself, perhaps while the admin is typing or
          // about to press Enter. Focus goes to the dialog, whose title and
          // description are then read out, and not to the first button, which
          // would be Done: a keystroke meant for the page must not finish an alert.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            dialogRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>Calendar alerts</DialogTitle>
            <DialogDescription>{promptSummary(due.length)}</DialogDescription>
          </DialogHeader>

          {due.length > 0 && (
            <ul className="space-y-3">
              {due.map((alert) => {
                const busy = alerts.busyIds.has(alert.id);
                return (
                  <li key={alert.id} className="space-y-3 rounded-lg border border-border p-3">
                    <AlertBody alert={alert} titleAs="h3" />
                    <div className="flex flex-wrap items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        disabled={busy}
                        aria-label={`Mark “${alert.title}” done`}
                        onClick={() => act(() => alerts.markDone(alert.id))}
                      >
                        Done
                      </Button>
                      <AlertLinkButton alert={alert} onOpenAdmin={goTo} />
                    </div>
                    <SnoozeButtons
                      alert={alert}
                      busy={busy}
                      onSnooze={(days) => act(() => alerts.snooze(alert.id, days))}
                    />
                  </li>
                );
              })}
            </ul>
          )}

          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={() => goTo(CALENDAR_ALERTS_HREF)}>
              All alerts
            </Button>
            <Button type="button" onClick={() => setOpen(false)}>
              Close for today
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
