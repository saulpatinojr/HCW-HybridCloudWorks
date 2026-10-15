/**
 * Calendar (route `/admin/calendar`) — the operational calendar for everything
 * ContentForge schedules (ADR 0033 §4, Amplify slice): content publishes,
 * newsletter sends, social posts, talks and CFP deadlines, certification
 * expirations and renewals, Ambassador deadlines, Listen & Learn releases.
 *
 * The grid itself is `SharedCalendar`, which the Newsletter Hub also embeds.
 * This page adds the Unscheduled panel (approved content waiting for a
 * date), the summary links, and the header's help.
 *
 * Until 2026-10-03 this page showed scheduled content only, in one month
 * view, with no reschedule or unschedule, and never refetched after a
 * change. Every write here refetches both the grid and the panel.
 */
import React, { useState } from 'react';
import { useNavigate } from 'react-router';
import { Calendar } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import PageHeader from '@/components/admin/shared/PageHeader';
import SharedCalendar from '@/components/admin/calendar/SharedCalendar';
import UnscheduledPanel from '@/components/admin/calendar/UnscheduledPanel';
import useUnscheduledContent from '@/components/admin/calendar/useUnscheduledContent';
import { useAuthReady } from '@/hooks/useAuthReady';

const HELP = [
  'Every item with a date in ContentForge is here: content publishes (sky), newsletter sends (violet), social posts (pink), talks and CFP deadlines (amber), certification expirations and renewals (green), Ambassador deadlines (indigo) and audio releases (teal). The icon and the word travel with the colour.',
  'Drag an Unscheduled card onto a day to schedule it at 09:00, or press its Schedule… button to pick the day and time. Drag a scheduled publish to another day to move it; its Reschedule button does the same from the keyboard.',
  'Open any item for its actions: edit, open its record, reschedule, unschedule, share to social, or retry a failed publish. Newsletter issues are canceled or moved on the Newsletter Hub, beside their preview.',
  'A dashed border with a warning mark is a publish that did not happen. An amber mark means two items share the same 15-minute slot; you can still keep them there.',
  'Times are shown in your browser’s time zone, named on the toolbar. The server stores UTC.',
];

export default function CalendarPage() {
  const navigate = useNavigate();
  const { authReady } = useAuthReady();
  const unscheduled = useUnscheduledContent(authReady);
  const [scheduleRequest, setScheduleRequest] = useState(null);

  const summary = [
    {
      label: 'Unscheduled',
      value: unscheduled.data.length,
      to: '/admin/review-queue?status=approved',
      hint: 'Approved content with no publish time, on the Review Queue',
    },
    {
      label: 'Instant Ready',
      value: unscheduled.data.filter((row) => row.contentStatus === 'forge_ready').length,
      to: '/admin/review-queue?status=ready_to_publish',
      hint: 'Forge-ready content, one click from publishing',
    },
    {
      label: 'Social queue',
      value: null,
      to: '/admin/social-hub?tab=queue',
      hint: 'Open the scheduled social queue',
    },
    {
      label: 'Newsletter',
      value: null,
      to: '/admin/newsletter-hub?tab=published',
      hint: 'Open the newsletter’s sent and scheduled issues',
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader icon={Calendar} help={HELP} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-4">
        <div className="lg:col-span-3">
          <SharedCalendar
            enabled={authReady}
            unscheduled={unscheduled.data}
            onChanged={unscheduled.refresh}
            scheduleRequest={scheduleRequest}
            onScheduleHandled={() => setScheduleRequest(null)}
          />
        </div>
        <div className="space-y-4">
          <UnscheduledPanel
            items={unscheduled.data}
            loading={unscheduled.loading}
            error={unscheduled.error}
            onRetry={unscheduled.refresh}
            onSchedule={(content) => setScheduleRequest({ content, day: new Date() })}
          />
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Go to</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-xs">
              {summary.map(({ label, value, to, hint }) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => navigate(to)}
                  title={hint}
                  aria-label={`${label}${value === null ? '' : `: ${value}`}. ${hint}`}
                  className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="text-muted-foreground">{label}</span>
                  {value !== null && <span className="font-medium tabular-nums">{value}</span>}
                </button>
              ))}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
