/**
 * What every Cloudflare tab shares (#1905): one read with its loading,
 * failure and "not set up yet" states; one write runner that refuses a second
 * click while the first request is out; and the lock note a protected row
 * shows instead of an edit button.
 */
import React, { useCallback } from 'react';
import { Link } from 'react-router';
import { Loader2, Lock, Settings2 } from 'lucide-react';
import EmptyState from '@/components/admin/shared/EmptyState';
import useGuardedLoad from '@/components/admin/shared/useGuardedLoad';
import useWriteGuard from '@/components/admin/shared/useWriteGuard';
import { useToast } from '@/components/ui/use-toast';
import { useAuthReady } from '@/hooks/useAuthReady';
import { NOT_CONFIGURED } from '@/lib/cloudflare';
import { tabHref as integrationsTabHref } from '@/components/admin/integrations/tabs';

/** The sentence every write control shows to someone below the role. */
export const WRITE_REASON =
  'Changing Cloudflare needs the super admin role. You can look at everything here.';

/** Cloudflare's pages this page sends a reader to (the contract of #1905). */
export const CLOUDFLARE_DOCS = Object.freeze({
  permissions: 'https://developers.cloudflare.com/fundamentals/api/reference/permissions/',
  createToken: 'https://developers.cloudflare.com/fundamentals/api/get-started/create-token/',
  accountTokens:
    'https://developers.cloudflare.com/fundamentals/api/get-started/account-owned-tokens/',
  api: 'https://developers.cloudflare.com/api/',
});

export function ExternalLink({ href, children }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline underline-offset-2 hover:text-foreground"
    >
      {children}
    </a>
  );
}

/** What to do while the token or the zone id is not set: one place to paste it, and why. */
export function NotConfigured({ compact = false }) {
  return (
    <EmptyState
      icon={Settings2}
      compact={compact}
      title="Cloudflare is not set up here yet"
      description="The page needs the Cloudflare admin token: an account-owned API token limited to this one zone. Make it in the Cloudflare dashboard, then paste it on Integrations → Keys (the row CLOUDFLARE-ADMIN-TOKEN). The site never shows it again."
      action={
        <Link
          to={integrationsTabHref('keys')}
          className="text-sm font-medium text-primary underline underline-offset-2"
        >
          Open Integrations → Keys
        </Link>
      }
    />
  );
}

/**
 * A tab's read: the guarded loader, started once sign-in is ready, with a
 * failure message that never carries more than the API said.
 */
export function useCloudflareRead(load, empty = null) {
  const { authReady } = useAuthReady();
  // `load` and `empty` must be stable (module-level or memoised), and so is
  // the describer: a new one each render would start a new read each render.
  return useGuardedLoad(load, { enabled: authReady, empty, describeError: describeReadError });
}

const describeReadError = (err) => err?.message || 'Cloudflare could not be read.';

/**
 * The tab's body once its read has landed; until then the spinner, the
 * failure with a retry, or the "not set up" note.
 */
export function ReadGate({ read, label, children }) {
  if (read.errorCode === NOT_CONFIGURED) return <NotConfigured />;
  if (read.error && !read.loaded) {
    return (
      <EmptyState
        variant="error"
        title={`${label} could not be read`}
        description={read.error}
        onRetry={read.refresh}
      />
    );
  }
  if (!read.loaded) {
    return (
      <div className="flex justify-center py-12" role="status" aria-label={`Reading ${label}`}>
        <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
      </div>
    );
  }
  return children;
}

/**
 * The writes' runner. `run(id, work, success)` claims `id` (a second call
 * while the first is out does nothing), runs the request, re-reads the tab,
 * and says what happened; a refusal is a toast with the server's sentence
 * and changes nothing on screen.
 */
export function useCloudflareWrite(refresh) {
  const { toast } = useToast();
  const { busyIds, claim, release } = useWriteGuard();
  const run = useCallback(
    async (id, work, success) => {
      if (!claim(id)) return false;
      try {
        const answer = await work();
        toast({ title: 'Saved', description: success });
        await refresh?.();
        return answer ?? true;
      } catch (err) {
        toast({
          title: 'Nothing was changed',
          description: err?.message || 'Cloudflare refused the change.',
          variant: 'destructive',
        });
        return false;
      } finally {
        release(id);
      }
    },
    [claim, release, refresh, toast]
  );
  return { busyIds, run };
}

/** The note a locked row or phase shows in place of its edit control. */
export function LockNote({ reason, className = '' }) {
  return (
    <span className={`inline-flex items-start gap-1.5 text-xs text-muted-foreground ${className}`}>
      <Lock className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-600" aria-hidden="true" />
      <span>
        <span className="font-medium text-foreground">Locked.</span> {reason}
      </span>
    </span>
  );
}

export const TH = 'pb-2 pr-3 text-left text-xs font-medium text-muted-foreground';
export const TD = 'py-2 pr-3 align-top border-t border-border/60 text-sm';
