import { useCallback, useRef, useSyncExternalStore } from "react";
import type { PlayerSnapshot } from "@wasm-player/contracts";
import type { PlayerController } from "@wasm-player/player-core";

/**
 * Subscribes to a slice of the controller snapshot. The selector result must be
 * referentially stable while the selected data is unchanged: primitives are
 * fine, objects need `isEqual` (for example a shallow comparison).
 *
 * Placement matters: a selector only avoids re-renders for the component that
 * calls it, so position/stats subscriptions live in the leaf components that
 * display them rather than in the app shell.
 */
export function usePlayerSnapshot<T>(
  controller: PlayerController | null,
  selector: (snapshot: PlayerSnapshot) => T,
  isEqual: (left: T, right: T) => boolean = Object.is
): T | null {
  const cache = useRef<{ value: T } | null>(null);
  const read = useCallback((): T | null => {
    if (!controller) return null;
    const next = selector(controller.getSnapshot());
    const current = cache.current;
    if (current !== null && isEqual(current.value, next)) return current.value;
    cache.current = { value: next };
    return next;
  }, [controller, selector, isEqual]);
  const subscribe = useCallback(
    (listener: () => void) => (controller ? controller.subscribeSnapshot(listener) : () => undefined),
    [controller]
  );
  return useSyncExternalStore(subscribe, read, read);
}

/** Shallow comparison for selector results that are flat objects. */
export function shallowEqual<T extends Record<string, unknown>>(left: T, right: T): boolean {
  if (Object.is(left, right)) return true;
  const leftKeys = Object.keys(left);
  if (leftKeys.length !== Object.keys(right).length) return false;
  for (const key of leftKeys) {
    if (!Object.is(left[key], right[key])) return false;
  }
  return true;
}
