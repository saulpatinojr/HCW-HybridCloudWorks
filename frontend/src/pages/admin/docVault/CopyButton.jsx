/**
 * A Copy button that says what happened. The text is fetched at the click
 * (`getText`), so a long document is not copied into state on every render,
 * and the answer is both seen (the button turns to "Copied", or a line says
 * the clipboard refused) and heard (a status region a screen reader reads).
 * When the clipboard is refused the text is left on the page to select by hand.
 *
 * This is the Doc Vault's own, not the Ambassador hub's CopyButton: that one is
 * a small ghost button for one answer among many, with no fallback. This one
 * is the main action on a document, so it is large, and it falls back to the
 * older copy command where the clipboard API is missing (clipboard.js).
 */
import React, { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { copyText } from './clipboard';

const RESET_MS = 4000;

/**
 * @param {{
 *   getText: () => string,
 *   label: string,
 *   children: React.ReactNode,
 *   icon?: React.ComponentType<{className?: string}>,
 *   variant?: string,
 *   size?: string,
 *   className?: string,
 * }} props
 */
export default function CopyButton({
  getText,
  label,
  children,
  icon: Icon = Copy,
  variant = 'outline',
  size = 'sm',
  className = '',
}) {
  const [state, setState] = useState('idle');
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    const ok = await copyText(getText());
    setState(ok ? 'copied' : 'failed');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), RESET_MS);
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        type="button"
        variant={variant}
        size={size}
        onClick={copy}
        aria-label={label}
        className={`gap-2 ${className}`}
      >
        {state === 'copied' ? <Check className="h-4 w-4" /> : <Icon className="h-4 w-4" />}
        {state === 'copied' ? 'Copied' : children}
      </Button>
      <span role="status" className={state === 'failed' ? 'text-xs text-destructive' : 'sr-only'}>
        {state === 'copied' && `${label}: done.`}
        {state === 'failed' &&
          'The browser did not allow copying. Select the text and press Ctrl+C instead.'}
      </span>
    </span>
  );
}
