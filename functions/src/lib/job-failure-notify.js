/**
 * job-failure-notify.js — the failure-only onComplete hook for platform jobs
 * (T-607). One Telegram message when a job fails or times out; silence on
 * success — successes in the forge path already ride the forge_ready rising
 * edge (lib/triggers/forge-ready-notify.js), and double-pinging the owner
 * defeats the point of the notification.
 *
 * source is `job_failed:{type}` so the 15-minute notify cooldown is per job
 * type: a burst of failing forge jobs is one ping, but a publish failure is
 * never masked by it.
 */
import { createNotifier } from './notify.js';
import { redactSensitive, redactText } from './newsletter/insights-handlers.js';

export function createJobFailureOnComplete({ store, notifier, log = {} }) {
  const telegram = notifier || createNotifier({ store, log });

  return async function onComplete({ job, status, error }) {
    if (status === 'succeeded') return;
    const safePayload = JSON.stringify(redactSensitive(job?.payload ?? {})).slice(0, 300);
    const safeError = error ? `Error: ${redactText(error)}` : null;

    await telegram.notifyTelegram({
      title: `Job ${status}: ${job.type}`,
      message: [
        `Job ${job.id} (${job.type}) ${status === 'timeout' ? 'timed out' : 'failed'}.`,
        safeError,
        `Payload: ${safePayload}`,
        'Send /status for the platform snapshot.',
      ]
        .filter(Boolean)
        .join('\n'),
      severity: 'warning',
      source: `job_failed:${job.type}`,
    });
  };
}
