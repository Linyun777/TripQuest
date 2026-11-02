import type { PreviewJourneyOutcome } from "@tripquest/application";
import { emptyPreviewValues, type PreviewValues } from "./form-data";

export interface PreviewFormState {
  readonly revision: number;
  readonly values: PreviewValues;
  readonly result?: PreviewJourneyOutcome;
  readonly confirmationKey?: string;
  readonly formError?: string;
}

export const initialPreviewFormState: PreviewFormState = { revision: 0, values: emptyPreviewValues };
