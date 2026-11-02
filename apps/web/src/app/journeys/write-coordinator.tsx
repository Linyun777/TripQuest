"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

export type WriteIntent = "edit" | "report" | "replan" | "confirm";
interface Coordinator {
  /** The intent currently holding the page, if any. */
  readonly owner: WriteIntent | null;
  /** Synchronous: a second intent in the same tick is refused, not queued. */
  claim(intent: WriteIntent): boolean;
  release(intent: WriteIntent): void;
}

const WriteContext = createContext<Coordinator>({
  owner: null,
  claim: () => true,
  release: () => {},
});

/** One page-level write intent at a time: single edit, report, generation or confirmation. */
export function WriteCoordinator({ children }: { children: ReactNode }) {
  const [owner, setOwner] = useState<WriteIntent | null>(null);
  const current = useRef<WriteIntent | null>(null);
  const claim = useCallback((intent: WriteIntent) => {
    if (current.current !== null && current.current !== intent) return false;
    current.current = intent;
    setOwner(intent);
    return true;
  }, []);
  const release = useCallback((intent: WriteIntent) => {
    if (current.current !== intent) return;
    current.current = null;
    setOwner(null);
  }, []);
  const value = useMemo(() => ({ owner, claim, release }), [owner, claim, release]);
  return <WriteContext.Provider value={value}>{children}</WriteContext.Provider>;
}

export function useWriteCoordinator(): Coordinator {
  return useContext(WriteContext);
}
