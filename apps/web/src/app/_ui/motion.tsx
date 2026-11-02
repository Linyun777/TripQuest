"use client";

import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";

/** The app's one ease-out curve (same as `--ease-out-soft` in globals.css). */
export const EASE_OUT = [0.22, 1, 0.36, 1] as const;

/**
 * Motion's JS animations follow the system's "reduce motion" setting like the CSS ones do:
 * movement is dropped, fades stay (they help reading what changed).
 */
export function MotionProvider({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
