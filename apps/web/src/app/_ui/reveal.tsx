"use client";

import { motion } from "motion/react";
import type { ReactNode } from "react";
import { EASE_OUT } from "./motion";

/** Rises in once on first paint; `order` staggers siblings. */
export function Reveal({ children, order = 0, className }: { children: ReactNode; order?: number; className?: string }) {
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.07 * order, duration: 0.5, ease: EASE_OUT }}
    >
      {children}
    </motion.div>
  );
}
