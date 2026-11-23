/**
 * Erase a speaker's talk proposals — a card on the Developer API tab (#1777).
 *
 * A talk proposal sent to an organizer's call for speakers holds the speaker's
 * name, email and bio. When a speaker asks for their data to be deleted (an
 * erasure request), the owner types the speaker's email address here, sees
 * where it has proposals, and deletes each one. The steps for the whole
 * request are in docs/runbooks/data-subject-requests.md.
 *
 * What the list shows is the event, the status and the date, never what the
 * speaker wrote: enough to delete, nothing more to read. The address is kept
 * in this card's state only: it goes in the request body, never in the page
 * address, a toast or storage.
 *
 * Both calls need super_admin; RoleGate says so instead of a 403.
 */
import React, { useState } from 'react';
import { Card, CardHeader, CardTitle, CardContent, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/use-toast';
import { Loader2, Search, Trash2, UserX } from 'lucide-react';
import RoleGate from '@/components/admin/RoleGate';
import ConfirmModal from '@/components/admin/ConfirmModal';
import { eraseProposal, findProposalsByEmail } from '@/lib/developerApi';
import { whenText } from './developerApiView';

const ERASE_REASON = 'Finding and deleting a speaker’s proposals needs the super_admin role.';
/** The longest email address the API reads. */
const MAX_EMAIL = 254;
const looksLikeEmail = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);

export default function ProposalErasureCard() {
  const { toast } = useToast();
  const [email, setEmail] = useState('');
  const [problem, setProblem] = useState(null);
  const [searching, setSearching] = useState(false);
  // null before a search; { proposals, truncated } after one.
  const [found, setFound] = useState(null);
  const [confirm, setConfirm] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const search = async () => {
    const address = email.trim();
    if (!looksLikeEmail(address)) {
      setProblem('Type the speaker’s email address.');
      return;
    }
    setProblem(null);
    setSearching(true);
    try {
      const answer = await findProposalsByEmail(address);
      setFound({ proposals: answer?.proposals || [], truncated: Boolean(answer?.truncated) });
    } catch (err) {
      setFound(null);
      setProblem(err?.message || 'The search failed. Nothing was changed.');
    } finally {
      setSearching(false);
    }
  };

  const remove = async (proposal) => {
    setConfirm(null);
    setDeleting(proposal.id);
    try {
      const answer = await eraseProposal(proposal.id);
      setFound((current) =>
        current
          ? { ...current, proposals: current.proposals.filter((row) => row.id !== proposal.id) }
          : current
      );
      toast({
        title: answer?.deleted === false ? 'Already deleted' : 'Proposal deleted',
        description: `Event ${proposal.eventId || 'unknown'}`,
      });
    } catch (err) {
      toast({
        title: 'Nothing was deleted',
        description: err?.message || 'The request failed.',
        variant: 'destructive',
      });
    } finally {
      setDeleting(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <UserX className="h-5 w-5" aria-hidden="true" />
          Erase a speaker’s proposals
        </CardTitle>
        <CardDescription>
          For when a speaker asks you to delete their data. Type their email address to see where
          they sent a talk proposal, then delete each one. A delete cannot be undone, and it removes
          the proposal from the organizer’s list too.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1 grow min-w-[16rem]">
            <Label htmlFor="developer-erase-email">Speaker’s email address</Label>
            <Input
              id="developer-erase-email"
              type="email"
              autoComplete="off"
              value={email}
              maxLength={MAX_EMAIL}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <RoleGate minRole="super_admin" reason={ERASE_REASON}>
            <Button size="sm" disabled={searching} onClick={search}>
              {searching ? (
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" aria-hidden="true" />
              ) : (
                <Search className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
              )}
              Find proposals
            </Button>
          </RoleGate>
        </div>
        {problem && (
          <p role="alert" className="text-sm text-red-600">
            {problem}
          </p>
        )}
        {found && found.proposals.length === 0 && (
          <p role="status" className="text-sm text-muted-foreground">
            No proposals are stored for that address.
          </p>
        )}
        {found && found.proposals.length > 0 && (
          <ul className="divide-y" aria-label="Proposals from this address">
            {found.proposals.map((proposal) => (
              <li
                key={proposal.id}
                className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
              >
                <span className="min-w-0">
                  <span className="font-mono break-all">{proposal.eventId || 'unknown event'}</span>
                  <span className="text-muted-foreground">
                    {' '}
                    · {proposal.status || 'unknown'} · sent {whenText(proposal.submittedAt)}
                  </span>
                </span>
                <RoleGate minRole="super_admin" reason={ERASE_REASON}>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={deleting === proposal.id}
                    aria-label={`Delete the proposal on ${proposal.eventId || 'unknown event'}`}
                    onClick={() => setConfirm(proposal)}
                  >
                    {deleting === proposal.id ? (
                      <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" aria-hidden="true" />
                    ) : (
                      <Trash2 className="h-3.5 w-3.5 mr-1" aria-hidden="true" />
                    )}
                    Delete
                  </Button>
                </RoleGate>
              </li>
            ))}
          </ul>
        )}
        {found?.truncated && (
          <p className="text-sm text-muted-foreground">
            Only the first 200 are listed. Delete these, then search again for the rest.
          </p>
        )}
        <ConfirmModal
          open={Boolean(confirm)}
          title="Delete this proposal?"
          description={`The proposal on event ${confirm?.eventId || 'unknown'} is deleted for good: the speaker’s name, email, bio and talk. It cannot be undone, and the organizer no longer sees it.`}
          confirmLabel="Delete proposal"
          busy={Boolean(deleting)}
          onConfirm={() => remove(confirm)}
          onCancel={() => setConfirm(null)}
        />
      </CardContent>
    </Card>
  );
}
