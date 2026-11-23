"use client";

import { MotionConfig } from "motion/react";
import type { ReactNode } from "react";

/** Emil Kowalski / Apple fluid strong ease-out curve for entrances and mode transitions. */
export const EASE_OUT = [0.23, 1, 0.32, 1] as const;

/** Crisp critically-damped spring for structural UI transitions (tabs, drawers). */
export const SPRING_SNAPPY = { type: "spring", duration: 0.36, bounce: 0.16 } as const;

/** Lively tactile spring with gentle overshoot for mode switches, Dock icons, and playful moments. */
export const SPRING_BOUNCY = { type: "spring", duration: 0.44, bounce: 0.26 } as const;

/** Respects prefers-reduced-motion globally across all Motion components. */
export function MotionProvider({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
