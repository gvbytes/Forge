import { useEffect, useRef } from "react";

/** Keep a scroll container pinned to the bottom while content streams in,
 *  unless the user scrolled away to read history.
 *
 *  - `dep` re-runs the pin (pass the timeline array so in-place token growth
 *    is followed, not just length changes).
 *  - `resetKey` (e.g. the active task id) re-engages the pin when it changes,
 *    so switching tasks doesn't inherit the previous task's scrolled-away state.
 *
 *  The pin sets `scrollTop` programmatically, which fires a scroll event; we flag
 *  those so they don't re-evaluate `stick` and fight the user. A user scroll-up
 *  beyond the threshold disengages the pin until they return to the bottom. */
export function useStickBottom(dep: unknown, resetKey?: unknown): {
  ref: React.RefObject<HTMLDivElement>;
  onScroll: () => void;
} {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const autoScrolling = useRef(false);

  // New conversation/task → re-engage so the fresh stream auto-follows.
  const prevReset = useRef(resetKey);
  useEffect(() => {
    if (prevReset.current !== resetKey) {
      prevReset.current = resetKey;
      stick.current = true;
    }
  }, [resetKey]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !stick.current) return;
    const bottom = el.scrollHeight - el.clientHeight;
    if (el.scrollTop >= bottom) return; // already pinned — avoid a no-op scroll event
    autoScrolling.current = true;
    el.scrollTop = el.scrollHeight;
  }, [dep]);

  return {
    ref,
    onScroll: () => {
      const el = ref.current;
      if (!el) return;
      // Ignore the scroll event our own pin just produced.
      if (autoScrolling.current) {
        autoScrolling.current = false;
        return;
      }
      // Generous threshold: a small scroll-up shouldn't require pixel-perfect
      // bottom-hugging to keep following, but a deliberate scroll-away disengages.
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    },
  };
}
