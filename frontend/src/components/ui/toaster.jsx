import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from '@/components/ui/toast';
import { pauseToast, resumeToast, useToast } from '@/components/ui/use-toast';
import React, { useEffect, useRef } from 'react';

/**
 * The toasts on screen, stacked: up to TOAST_LIMIT of them, newest first.
 *
 * NO LIVE REGION ON THE VIEWPORT (AP-F12, #936). It used to carry
 * `aria-live="polite" aria-atomic="true"`, which made the whole list one
 * atomic region: every toast that arrived re-announced the list from the top,
 * and the one it replaced was never announced at all. Radix already gives
 * each toast its own visually-hidden `role="status"` live region, mounted
 * for a second after the toast appears, so each outcome is announced once,
 * in order — one polite live region per toast, as WAI-ARIA asks. The
 * viewport stays the labelled `region` Radix renders it as.
 *
 * ONE CLOCK, THE STORE'S (AP-F12, #936). Radix runs a close timer of its own
 * per toast, from when it mounts rather than when it was fired, and pauses it
 * on hover, focus and a backgrounded window where the store's clock did not,
 * so whichever ran out first decided what the reader saw. Radix 1.2 starts no
 * timer for a duration of Infinity, so the provider and every toast are given
 * Infinity — after the toast's own props, so its `duration` never reaches
 * Radix. That duration stays in the store, which alone expires the toast.
 * Radix still says when the toasts are being read, through onPause and
 * onResume, and those stop and restart the store's clock.
 */
export function Toaster() {
  const { toasts } = useToast();
  // The toasts this toaster paused and has not resumed. Leaving the admin
  // shell mid-hover resumes them, so none stays paused in the store with
  // nothing mounted to resume it.
  const pausedRef = useRef(new Set());

  useEffect(() => {
    const paused = pausedRef.current;
    return () => {
      paused.forEach((id) => resumeToast(id));
      paused.clear();
    };
  }, []);

  return (
    <ToastProvider duration={Infinity}>
      {toasts.map(({ id, title, description, action, ...props }) => {
        /** Stop this toast's clock while Radix says the toasts are being read. */
        const pause = () => {
          pausedRef.current.add(id);
          pauseToast(id);
        };
        /** Run its clock again on the time it had left, once they are not. */
        const resume = () => {
          pausedRef.current.delete(id);
          resumeToast(id);
        };
        /**
         * Closed by hand — the close button, a swipe, Escape, its action — the
         * toast unmounts and Radix never resumes it, so its clock restarts here
         * rather than staying paused in the store.
         */
        const onOpenChange = (open) => {
          if (!open) resume();
        };
        return (
          <Toast
            key={id}
            {...props}
            duration={Infinity}
            onPause={pause}
            onResume={resume}
            onOpenChange={onOpenChange}
          >
            <div className="grid gap-1">
              {title && <ToastTitle>{title}</ToastTitle>}
              {description && <ToastDescription>{description}</ToastDescription>}
            </div>
            {action}
            <ToastClose />
          </Toast>
        );
      })}
      <ToastViewport />
    </ToastProvider>
  );
}
