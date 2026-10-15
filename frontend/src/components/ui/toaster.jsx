import {
  Toast,
  ToastClose,
  ToastDescription,
  ToastProvider,
  ToastTitle,
  ToastViewport,
} from '@/components/ui/toast';
import { useToast } from '@/components/ui/use-toast';
import React from 'react';

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
 */
export function Toaster() {
  const { toasts } = useToast();

  return (
    <ToastProvider>
      {toasts.map(({ id, title, description, action, ...props }) => {
        return (
          <Toast key={id} {...props}>
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
