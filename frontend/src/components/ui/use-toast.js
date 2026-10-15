import { useState, useEffect, useRef } from 'react';

// Three, not one (AP-F12, #936). With one slot a bulk action's outcomes —
// three publishes, two of them failed — replaced each other faster than they
// could be read or announced, and the last one standing was whichever request
// finished last. Three is what fits above the fold on a phone; the oldest
// leaves when a fourth arrives.
export const TOAST_LIMIT = 3;

let count = 0;
function generateId() {
  count = (count + 1) % Number.MAX_VALUE;
  return count.toString();
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

    toastStore.listeners.forEach((listener) => listener(toastStore.state));
  },

  subscribe: (listener) => {
    toastStore.listeners.push(listener);
    return () => {
      toastStore.listeners = toastStore.listeners.filter((l) => l !== listener);
    };
  },
};

export const toast = ({ ...props }) => {
  const id = generateId();

  const update = (props) =>
    toastStore.setState((state) => ({
      ...state,
      toasts: state.toasts.map((t) => (t.id === id ? { ...t, ...props } : t)),
    }));

  const dismiss = () =>
    toastStore.setState((state) => ({
      ...state,
      toasts: state.toasts.filter((t) => t.id !== id),
    }));

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

export function useToast() {
  const [state, setState] = useState(toastStore.getState());

  useEffect(() => {
    const unsubscribe = toastStore.subscribe((state) => {
      setState(state);
    });

    return unsubscribe;
  }, []);

  // One timer per toast, kept across renders. The timers used to be rebuilt
  // on every store change, which with one slot never showed: with three, a
  // second toast restarted the first one's clock, so a steady stream of
  // outcomes kept the oldest on screen for as long as the stream ran.
  const timersRef = useRef(new Map());

  useEffect(() => {
    const timers = timersRef.current;
    const live = new Set(state.toasts.map((t) => t.id));

    // A toast that left — closed by hand, swiped, or by its own timer — drops
    // its timer, so the map never outgrows what is on screen.
    timers.forEach((timeout, id) => {
      if (!live.has(id)) {
        clearTimeout(timeout);
        timers.delete(id);
      }
    });

    state.toasts.forEach((toast) => {
      if (toast.duration === Infinity || timers.has(toast.id)) {
        return;
      }

      const safeDuration =
        typeof toast.duration === 'number' && toast.duration > 0 && toast.duration <= 30000
          ? toast.duration
          : 5000;
      const dismissFn =
        typeof toast.dismiss === 'function' && toast.dismiss.toString().indexOf('eval') === -1
          ? toast.dismiss
          : () => {};
      timers.set(toast.id, setTimeout(dismissFn, safeDuration));
    });
  }, [state.toasts]);

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timeout) => clearTimeout(timeout));
      timers.clear();
    };
  }, []);

  return {
    toast,
    toasts: state.toasts,
  };
}
