import type { ChinaDateTime } from "@tripquest/domain";
import { z } from "zod";

import type { JourneyIdGenerator, JourneyIdKind } from "./contracts";

const UUID_SCHEMA = z.uuid();
const CHINA_OFFSET_MILLISECONDS = 8 * 60 * 60 * 1000;

export function isJourneyId(value: unknown): value is string {
  return UUID_SCHEMA.safeParse(value).success;
}

export function createCheckedIdFactory(generator: JourneyIdGenerator): (
  kind: JourneyIdKind,
) => string {
  const generatedIds = new Set<string>();

  return (kind) => {
    const id = generator.next(kind);
    if (!UUID_SCHEMA.safeParse(id).success) {
      throw new Error(`JourneyIdGenerator returned an invalid ${kind} UUID`);
    }
    if (generatedIds.has(id)) {
      throw new Error(`JourneyIdGenerator returned a duplicate ${kind} UUID`);
    }
    generatedIds.add(id);
    return id;
  };
}

export function toChinaDateTime(value: Date): ChinaDateTime {
  if (Number.isNaN(value.getTime())) {
    throw new Error("JourneyClock returned an invalid Date");
  }

  const chinaWallClock = new Date(value.getTime() + CHINA_OFFSET_MILLISECONDS);
  return `${chinaWallClock.toISOString().slice(0, 19)}+08:00`;
}
