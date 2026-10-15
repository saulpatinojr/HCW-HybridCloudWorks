/**
 * The shell for an admin panel that opens on demand: the Publish page's
 * "Images: re-host hotlinked". (The Review Queue's "Import drafts from the
 * repository" used it too, until that moved to the Drafts page.)
 *
 * A card with a title, a line saying what the panel does, and a toggle
 * button; the body exists only while the panel is open, which is what lets a
 * panel whose body calls an API read on open rather than on page mount. An
 * error, when there is one, is the first line of the body.
 */
import React from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

/** The spinner line a panel shows while its body loads. */
export function PanelLoading({ children }) {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" />
      {children}
    </p>
  );
}

/**
 * @param {{
 *   title: string,
 *   description: React.ReactNode,
 *   icon?: React.ComponentType<{ className?: string }>,
 *   toggleLabel: string,
 *   open: boolean,
 *   onToggle: () => void,
 *   error?: string,
 *   children?: React.ReactNode,
 * }} props
 */
export default function CollapsiblePanel({
  title,
  description,
  icon: Icon,
  toggleLabel,
  open,
  onToggle,
  error,
  children,
}) {
  return (
    <Card>
      <CardContent className="p-4 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-medium">{title}</p>
            <p className="text-xs text-muted-foreground">{description}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={onToggle}
            aria-expanded={open}
            className="shrink-0"
          >
            {Icon && <Icon className="h-4 w-4 mr-2" />}
            {toggleLabel}
          </Button>
        </div>

        {open && (
          <div className="space-y-3 border-t pt-3">
            {error && <p className="text-sm text-destructive">{error}</p>}
            {children}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
