import React, { useId } from 'react';
import { cn } from '@/lib/utils';
import { useAdminRole } from '@/hooks/useAdminRole';
import { roleLabel, roleLevel, satisfiesRole } from '@/config/adminNav';

/**
 * RoleGate — a control the signed-in admin cannot use says so before the
 * round trip (AP-F4, #928).
 *
 * Usage:
 *   <RoleGate minRole="publisher" reason="Publishing needs the publisher role.">
 *     <Button onClick={publish}>Publish</Button>
 *   </RoleGate>
 *
 * `minRole`, the registry's own word (adminNav.js), and not `role`: a `role`
 * prop on a JSX element reads as an ARIA role to jsx-a11y, which refuses
 * "publisher" as one, and it would read that way to a person too.
 *
 * With the role, or above it, the children render exactly as written. Below
 * it, each child element is rendered with `aria-disabled="true"`, its click
 * replaced by a no-op, and the reason beneath it as visible text that the
 * control names through `aria-describedby` — so a screen reader hears
 * "Publish, unavailable, Publishing needs the publisher role" where a sighted
 * user reads the same sentence under the button. `aria-disabled` rather than
 * `disabled`, deliberately: a `disabled` button leaves the tab order and
 * announces nothing, which is a control that vanished rather than one that
 * explains itself (ConfirmModal.jsx takes the same view of window.confirm).
 *
 * THIS IS NOT A SECURITY CONTROL. The server's requireRole still answers
 * every request on its own; this only stops the admin finding that out from
 * a 403. So when the role is not known — no AdminRoleProvider above, which
 * in the app never happens (AdminAuthGuard provides it) — the gate has
 * nothing to say and renders the children untouched, rather than telling a
 * publisher they are not one.
 *
 * @param {{
 *   minRole: string,
 *   reason?: string,
 *   className?: string,
 *   children: React.ReactNode,
 * }} props
 */
export default function RoleGate({ minRole, reason, className, children }) {
  const current = useAdminRole();
  const reasonId = useId();
  // A typo in a call site ("publishor") must fail at the render, not quietly
  // gate the control for everyone — the same rule as the server's requireRole.
  if (!roleLevel(minRole)) {
    throw new Error(`RoleGate: unknown role ${JSON.stringify(minRole)}`);
  }

  if (current === null || satisfiesRole(current, minRole)) return <>{children}</>;

  const text = reason || roleGateReason(minRole, current);
  /** The click below the role: nothing happens, so the request and its 403 never start. */
  const blocked = (event) => event.preventDefault();
  const gated = React.Children.map(children, (child) =>
    React.isValidElement(child)
      ? React.cloneElement(child, {
          'aria-disabled': 'true',
          'aria-describedby': reasonId,
          onClick: blocked,
          className: cn(child.props.className, 'cursor-not-allowed opacity-50'),
        })
      : child
  );

  return (
    <span
      className={cn('inline-flex flex-col items-start gap-1', className)}
      data-role-gate={minRole}
    >
      <span className="inline-flex flex-wrap items-center gap-2">{gated}</span>
      <span id={reasonId} className="text-xs text-muted-foreground">
        {text}
      </span>
    </span>
  );
}

/** The sentence shown when a call site gives none. */
export function roleGateReason(required, current) {
  return `Needs the ${roleLabel(required).toLowerCase()} role; you are signed in as ${roleLabel(current).toLowerCase()}.`;
}
