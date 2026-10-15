import { useState, useEffect } from 'react';

// Three, not one (AP-F12, #936). With one slot a bulk action's outcomes —
// three publishes, two of them failed — replaced each other faster than they
// could be read or announced, and the last one standing was whichever request
// finished last. Three is what fits above the fold on a phone; the oldest
// leaves when a fourth arrives.
export const TOAST_LIMIT = 3;

// A toast's lifetime when it names none, and the longest one it may name.
const DEFAULT_DURATION = 5000;
const MAX_DURATION = 30000;

let count = 0;
/** A fresh id per toast, so a dismiss or an update reaches its own toast and no other. */
function generateId() {
  count = (count + 1) % Number.MAX_VALUE;
  return count.toString();
}

/**
 * How long a toast stays: until dismissed for Infinity, else its own duration
 * up to thirty seconds, else five.
 */
function lifetimeOf(duration) {
  if (duration === Infinity) return Infinity;
  return typeof duration === 'number' && duration > 0 && duration <= MAX_DURATION
    ? duration
    : DEFAULT_DURATION;
}

// EXPIRY LIVES WITH THE STORE, NOT WITH A MOUNTED HOOK (AP-F12, #936). Every
// component that called useToast() — the toaster, and every page that wanted
// `toast` from it — ran its own timer per toast, and unmounting cleared them.
// Leaving the admin shell inside a toast's five seconds therefore left the
// toast in the store, and the next visit showed that old outcome on a fresh
// clock. One timer per toast here runs whether anything is mounted or not.
//
// Each entry keeps the lifetime it was scheduled for, so an update that
// changes `duration` is seen: Infinity cancels the timer, a new number starts
// a new clock from the update, and an update that leaves the duration alone
// keeps the clock the toast already had. The timer calls the store's own
// removal by id, so no function carried on a toast's props is ever run by it.
const timers = new Map(); // id -> { lifetime, timeout }

/** Drop a toast's timer, so a toast that left cannot be removed twice or keep the map growing. */
function clearTimer(id) {
  const timer = timers.get(id);
  if (!timer) return;
  clearTimeout(timer.timeout);
  timers.delete(id);
}

/** Bring the timers in line with the toasts the store now holds, after every change to it. */
function syncTimers(toasts) {
  const live = new Set(toasts.map((t) => t.id));
  // A toast that left — closed by hand, swiped, pushed out by a fourth, or
  // by its own timer — drops its timer.
  timers.forEach((_, id) => {
    if (!live.has(id)) clearTimer(id);
  });

  toasts.forEach(({ id, duration }) => {
    const lifetime = lifetimeOf(duration);
    if (timers.get(id)?.lifetime === lifetime) return;
    clearTimer(id);
    if (lifetime === Infinity) return;
    timers.set(id, { lifetime, timeout: setTimeout(() => removeToast(id), lifetime) });
  });
}

const toastStore = {
  state: {
    toasts: [],
  },
  listeners: [],

  getState: () => toastStore.state,

  setState: (nextState) => {
    if (typeof nextState === 'function') {
      toastStore.state = nextState(toastStore.state);
    } else {
      toastStore.state = { ...toastStore.state, ...nextState };
    }

    syncTimers(toastStore.state.toasts);
    toastStore.listeners.forEach((listener) => listener(toastStore.state));
  },

  subscribe: (listener) => {
    toastStore.listeners.push(listener);
    return () => {
      toastStore.listeners = toastStore.listeners.filter((l) => l !== listener);
    };
  },
};

/** Take one toast out of the store, by hand or by its timer, leaving the others where they are. */
function removeToast(id) {
  toastStore.setState((state) => ({
    ...state,
    toasts: state.toasts.filter((t) => t.id !== id),
  }));
}

/**
 * Show an outcome — newest first, at most TOAST_LIMIT on screen — and hand
 * back its id, dismiss and update.
 */
export const toast = ({ ...props }) => {
  const id = generateId();

  const update = (props) =>
    toastStore.setState((state) => ({
      ...state,
      toasts: state.toasts.map((t) => (t.id === id ? { ...t, ...props } : t)),
    }));

  const dismiss = () => removeToast(id);

  toastStore.setState((state) => ({
    ...state,
    toasts: [{ ...props, id, dismiss }, ...state.toasts].slice(0, TOAST_LIMIT),
  }));

  return {
    id,
    dismiss,
    update,
  };
};

/**
 * The toasts in the store, kept current for the toaster to draw, and `toast`
 * for a page that only fires one; it holds no timers, so mounting it or not
 * changes nothing about when a toast leaves.
 */
export function useToast() {
  const [state, setState] = useState(toastStore.getState());

  useEffect(() => {
    const unsubscribe = toastStore.subscribe((state) => {
      setState(state);
    });

    return unsubscribe;
  }, []);

  return {
    toast,
    toasts: state.toasts,
  };
}
