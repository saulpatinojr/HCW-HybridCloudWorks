import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

/**
 * ConfirmModal — accessible alternative to the browser's confirm dialog for
 * destructive actions. Confirmations are state (ADR 0033 §2): the page holds
 * what is pending and renders this with it.
 *
 * Usage:
 *   const [confirmOpen, setConfirmOpen] = useState(false);
 *   <ConfirmModal
 *     open={confirmOpen}
 *     title="Delete item?"
 *     description="This cannot be undone."
 *     confirmLabel="Delete"
 *     onConfirm={() => { setConfirmOpen(false); doDelete(); }}
 *     onCancel={() => setConfirmOpen(false)}
 *   />
 *
 * Pass `preview` to render an arbitrary node (e.g. a list of items being
 * affected) between the description and the action buttons. Use it for
 * bulk destructive actions so the user can verify scope before confirming.
 *
 * Pass `busy` while the confirmed action's request is in flight (AP-F12,
 * #936). The confirm button is disabled and reads `busyLabel`, Cancel is
 * disabled, and the dialog cannot be dismissed by Escape, the overlay or the
 * close button: on a phone a second tap or an accidental swipe used to close
 * the dialog over a request still running, with nothing on screen to say
 * whether it had happened. The caller closes it when the request settles.
 *
 * @param {{
 *   open: boolean,
 *   title: string,
 *   description?: string,
 *   preview?: React.ReactNode,
 *   confirmLabel?: string,
 *   cancelLabel?: string,
 *   busy?: boolean,
 *   busyLabel?: string,
 *   onConfirm: () => void,
 *   onCancel: () => void,
 *   destructive?: boolean,
 * }} props
 */
export default function ConfirmModal({
  open,
  title,
  description,
  preview,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  busy = false,
  busyLabel = 'Working…',
  onConfirm,
  onCancel,
  destructive = true,
}) {
  // Radix asks before closing for Escape and for a pointer outside; refusing
  // there keeps the dialog open while busy. The close button and anything
  // else that reaches onOpenChange is refused the same way below.
  const holdWhileBusy = (event) => {
    if (busy) event.preventDefault();
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen && !busy) onCancel();
      }}
    >
      <DialogContent
        className={preview ? 'sm:max-w-xl' : 'sm:max-w-md'}
        aria-busy={busy || undefined}
        onEscapeKeyDown={holdWhileBusy}
        onPointerDownOutside={holdWhileBusy}
        onInteractOutside={holdWhileBusy}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {preview && <div className="mt-2">{preview}</div>}
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="outline" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            onClick={onConfirm}
            disabled={busy}
            aria-busy={busy || undefined}
          >
            {busy ? busyLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
