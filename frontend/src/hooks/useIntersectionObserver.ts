import { useRef, useEffect, useState, useMemo } from 'react';

// Shared global state for observers
// Key: stringified options (without root)
// Value: { observer, callbacks map }
const observers = new Map<
  string,
  {
    observer: IntersectionObserver;
    callbacks: Map<Element, (entry: IntersectionObserverEntry) => void>;
  }
>();

/**
 * Returns a shared IntersectionObserver instance if possible (when root is null/undefined).
 * If a custom root is provided, it returns a new independent observer.
 */
const getObserver = (options: IntersectionObserverInit) => {
  const { root, ...restOptions } = options;

  // If a specific root element is provided, we don't share observers
  // because we can't easily use the DOM element as a stable Map key in a simple way
  // alongside the other options without a more complex cache structure (e.g. Map<Element, Map<String, Observer>>).
  // For now, custom roots get their own isolated observer (standard behavior).
  if (root) {
    const callbacks = new Map<Element, (entry: IntersectionObserverEntry) => void>();
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const callback = callbacks.get(entry.target);
        if (callback) callback(entry);
      });
    }, options);

    return { observer, callbacks, isShared: false };
  }

  // For viewport-based observers (no root), we use a shared instance.
  // We sort keys to ensure consistent cache hits regardless of object key order.
  // However, JSON.stringify usually respects insertion order, but explicit key ordering is safer.
  // For IntersectionObserverInit, keys are few: rootMargin, threshold.
  const optionsKey = JSON.stringify(restOptions);

  if (!observers.has(optionsKey)) {
    const callbacks = new Map<Element, (entry: IntersectionObserverEntry) => void>();

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const callback = callbacks.get(entry.target);
        if (callback) {
          callback(entry);
        }
      });
    }, options);

    observers.set(optionsKey, { observer, callbacks });
  }

  return { ...observers.get(optionsKey)!, isShared: true };
};

export interface UseIntersectionObserverOptions extends IntersectionObserverInit {
  /**
   * If true, observer is removed after first intersection
   * @default false
   */
  once?: boolean;
  /**
   * Callback fired when element becomes visible
   */
  onVisible?: () => void;
  /**
   * Callback fired when element leaves viewport
   */
  onHidden?: () => void;
}

interface IntersectionHandlerParts {
  once: boolean;
  onVisible?: () => void;
  onHidden?: () => void;
  setIsVisible: (value: boolean) => void;
  setHasBeenVisible: (value: boolean) => void;
  stopWatching: () => void;
}

/** What happens when one watched element enters or leaves the viewport. */
const intersectionHandler =
  ({
    once,
    onVisible,
    onHidden,
    setIsVisible,
    setHasBeenVisible,
    stopWatching,
  }: IntersectionHandlerParts) =>
  (entry: IntersectionObserverEntry) => {
    if (!entry.isIntersecting) {
      setIsVisible(false);
      if (onHidden) onHidden();
      return;
    }
    setIsVisible(true);
    setHasBeenVisible(true);
    if (onVisible) onVisible();
    if (once) stopWatching();
  };

export function useIntersectionObserver(options: UseIntersectionObserverOptions = {}) {
  const ref = useRef<HTMLDivElement>(null);
  const [isVisible, setIsVisible] = useState(false);
  const [hasBeenVisible, setHasBeenVisible] = useState(false);

  // Separate non-observer options
  const { once = false, onVisible, onHidden, ...observerOptions } = options;

  // Memoize the observer options to prevent recreating the observer request
  // We default values here to ensure consistency
  const memoizedOptions = useMemo(
    () => ({
      threshold: observerOptions.threshold ?? 0.1,
      rootMargin: observerOptions.rootMargin ?? '0px',
      root: observerOptions.root ?? null,
    }),
    [observerOptions.threshold, observerOptions.rootMargin, observerOptions.root]
  );

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    // Get access to the shared (or new) observer
    const { observer, callbacks, isShared } = getObserver(memoizedOptions);

    // Define what happens when THIS specific element intersects
    const handleIntersection = intersectionHandler({
      once,
      onVisible,
      onHidden,
      setIsVisible,
      setHasBeenVisible,
      // Stop observing this element, but keep the shared observer alive
      stopWatching: () => {
        callbacks.delete(element);
        observer.unobserve(element);
      },
    });

    // Register this element with the observer
    callbacks.set(element, handleIntersection);
    observer.observe(element);

    return () => {
      // Cleanup when component unmounts or options change
      callbacks.delete(element);
      observer.unobserve(element);

      // If we created a custom observer for a specific root (not shared),
      // we should disconnect it if it's no longer watching anything to avoid leaks.
      // Shared observers (viewport) stay alive forever in this implementation
      // (a simple optimization tradeoff).
      if (!isShared && callbacks.size === 0) {
        observer.disconnect();
      }
    };
  }, [once, onVisible, onHidden, memoizedOptions]);

  return { ref, isVisible, hasBeenVisible };
}
