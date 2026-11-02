import { notFound } from "next/navigation";
import ValidatorLab from "./validator-lab";

/** The exercise is deliberately absent from the production site. */
export default function ValidatorLabPage() {
  if (process.env.NODE_ENV !== "development") {
    notFound();
  }

  return <ValidatorLab />;
}
