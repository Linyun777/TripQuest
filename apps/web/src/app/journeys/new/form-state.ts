import type { JourneyFieldErrors } from "@tripquest/application";

export interface JourneyFormActivity {
  readonly placeName: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly priority: string;
  readonly kind: string;
}

export interface JourneyFormValues {
  readonly title: string;
  readonly date: string;
  readonly activities: readonly JourneyFormActivity[];
}

export interface JourneyFormState {
  readonly revision: number;
  readonly values: JourneyFormValues;
  readonly fieldErrors: JourneyFieldErrors;
  readonly formError?: string;
}

export const emptyActivity: JourneyFormActivity = {
  placeName: "",
  startsAt: "",
  endsAt: "",
  priority: "normal",
  kind: "activity",
};

export const initialJourneyFormState: JourneyFormState = {
  revision: 0,
  values: { title: "", date: "", activities: [emptyActivity] },
  fieldErrors: {},
};
