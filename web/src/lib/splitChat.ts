import { useSyncExternalStore } from "react";

/**
 * Split-chat layout preference: Aria on the left, the Cyra chat on the right.
 * A client-side UI preference (like the color theme), not a server setting —
 * stored in localStorage and shared across components via a tiny external
 * store so the settings dialog and the session view stay in sync.
 */

const KEY = "aria-split-chat";
const listeners = new Set<() => void>();

function read(): boolean {
  return localStorage.getItem(KEY) === "1";
}

export function setSplitChat(on: boolean): void {
  localStorage.setItem(KEY, on ? "1" : "0");
  for (const l of listeners) l();
}

export function useSplitChat(): boolean {
  return useSyncExternalStore((cb) => {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }, read);
}
