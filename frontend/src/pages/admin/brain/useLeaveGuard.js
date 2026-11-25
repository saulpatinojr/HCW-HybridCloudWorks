/**
 * Asks before leaving a note with unsaved changes. The editor reports whether
 * it has changes (`reportDirty`); `canLeave()` answers at once when it has
 * none, and otherwise opens the "Leave this note?" dialog and waits for the
 * answer, which `answerLeave(true | false)` gives.
 */
import { useCallback, useRef, useState } from 'react';

export function useLeaveGuard() {
  const dirtyRef = useRef(false);
  const [leavePending, setLeavePending] = useState(false);
  const leaveAnswer = useRef(null);
  const reportDirty = useCallback((value) => {
    dirtyRef.current = value;
  }, []);
  const canLeave = useCallback(() => {
    if (!dirtyRef.current) return Promise.resolve(true);
    return new Promise((resolve) => {
      leaveAnswer.current = resolve;
      setLeavePending(true);
    });
  }, []);
  const answerLeave = (leave) => {
    setLeavePending(false);
    if (leave) dirtyRef.current = false;
    leaveAnswer.current?.(leave);
  };
  return { dirtyRef, reportDirty, canLeave, leavePending, answerLeave };
}
