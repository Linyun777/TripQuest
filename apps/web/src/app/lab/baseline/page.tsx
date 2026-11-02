import { notFound } from "next/navigation";
import BaselineLab from "./baseline-lab";

/** Local exercise only; no production route or travel plan is exposed. */
export default function BaselineLabPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <BaselineLab />;
}
