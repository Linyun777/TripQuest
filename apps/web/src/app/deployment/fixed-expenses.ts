import { readFileSync } from "node:fs";
import { z } from "zod";

const entries = z.array(
  z.object({
    type: z.enum(["server", "domain"]),
    period: z.string().regex(/^\d{4}-\d\d(?:\.\.\d{4}-\d\d)?$/),
    paid: z.iso.date(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    amount: z.string().regex(/^\d+(\.\d+)?$/),
  }),
);
export function fixedExpenses(file?: string) {
  return file ? entries.parse(JSON.parse(readFileSync(file, "utf8"))) : [];
}
