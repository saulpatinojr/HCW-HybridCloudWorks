/**
 * The admin layout's door to the Calendar Alerts pop-up.
 *
 * Three jobs, all of them about keeping the pop-up from costing anything:
 *
 *   - It loads the pop-up's code only for an editor or above, the role the
 *     server asks for, so a viewer downloads nothing and asks nothing.
 *   - It loads it lazily, so the portal's shell is no bigger for it.
 *   - It swallows a failure. If the file cannot be fetched (offline, or the
 *     page is older than the deploy that moved it) or the pop-up throws while
 *     it draws, the boundary renders nothing and the portal carries on. A
 *     calendar reminder must never be the reason an admin cannot sign in.
 */
import React, { Component, Suspense, lazy } from 'react';
import { useAdminRole } from '@/hooks/useAdminRole';
import { satisfiesRole } from '@/config/adminNav';

const CalendarAlertsPrompt = lazy(() => import('./CalendarAlertsPrompt'));

/** Renders nothing once anything below it has thrown. */
class QuietBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export default function CalendarAlertsGate() {
  const role = useAdminRole();
  if (!satisfiesRole(role, 'editor')) return null;
  return (
    <QuietBoundary>
      <Suspense fallback={null}>
        <CalendarAlertsPrompt />
      </Suspense>
    </QuietBoundary>
  );
}
