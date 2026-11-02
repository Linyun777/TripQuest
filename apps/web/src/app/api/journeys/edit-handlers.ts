import "server-only";
import { requireOwner } from "../../auth/owner";
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import { isJourneyId } from "@tripquest/application";
import {
  previewDayEditCommandSchema,
  confirmDayEditCommandSchema,
  type DayEditPreviewReply,
  type DayEditConfirmReply,
  type DayEditError,
} from "@tripquest/application/saved-day";
import {
  previewDayEdit,
  confirmDayEdit,
  DAY_EDIT_PURPOSE,
  type DayEditRepository,
} from "@tripquest/application/day-edit";
import { PLANNING_FIXTURE_VERSION } from "@tripquest/providers/planning-fixture";
import {
  DrizzleJourneyRepository,
  getSharedJourneyDatabase,
} from "@tripquest/db";
import { readBody, sameOrigin } from "../planning/request-body";
import {
  readDayEditConfig,
  signEditReceipt,
  verifyEditReceipt,
  EDIT_RECEIPT_TTL,
} from "../../journeys/edit-receipt";

function reply(
  body: DayEditPreviewReply | DayEditConfirmReply,
  httpStatus?: number,
) {
  const errors: Record<DayEditError, number> = {
    invalid_request: 400,
    invalid_receipt: 403,
    not_found: 404,
    source_not_allowed: 403,
    invalid_change: 422,
    stale: 409,
    candidate_changed: 409,
    expired: 410,
    disabled: 503,
    acknowledgment_required: 422,
    intent_conflict: 409,
    temporarily_unavailable: 503,
  };
  const status =
    body.status === "saved"
      ? 201
      : ["ready", "already_saved", "not_feasible"].includes(body.status)
        ? 200
        : errors[body.status as DayEditError];
  return Response.json(body, {
    status: httpStatus ?? status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

async function readCommand<T>(
  request: Request,
  schema: z.ZodType<T>,
): Promise<T | Response> {
  if (!sameOrigin(request)) return reply({ status: "invalid_request" }, 403);
  if (
    !/^application\/json\s*(?:;|$)/i.test(
      request.headers.get("content-type") ?? "",
    )
  ) {
    return reply({ status: "invalid_request" }, 415);
  }
  const body = await readBody(request);
  if (body === "too_large") return reply({ status: "invalid_request" }, 413);
  try {
    return schema.parse(JSON.parse(body));
  } catch {
    return reply({ status: "invalid_request" });
  }
}

export function createDayEditHandlers(
  options: {
    environment?: NodeJS.ProcessEnv;
    now?: () => number;
    repository?: () => DayEditRepository;
    /** V2.12：当前用户（路由从会话取得）。 */
    userId?: string;
  } = {},
) {
  const repository = () =>
    options.repository?.() ??
    new DrizzleJourneyRepository(getSharedJourneyDatabase().database, requireOwner(options.userId));
  return {
    async preview(request: Request, journeyId: string) {
      const command = await readCommand(request, previewDayEditCommandSchema);
      if (command instanceof Response) return command;
      if (!isJourneyId(journeyId)) return reply({ status: "invalid_request" });
      const config = readDayEditConfig(options.environment);
      if (!config.enabled) return reply({ status: "disabled" });
      const now = (options.now ?? Date.now)();
      try {
        const stored = await repository().findCurrentJourney(journeyId);
        if (!stored) return reply({ status: "not_found" });
        const result = await previewDayEdit(stored, command, now);
        if (result.status === "not_feasible")
          return reply({ status: result.status, issues: [...result.issues] });
        if (result.status !== "ready") return reply(result);
        const receipt = signEditReceipt(
          {
            purpose: DAY_EDIT_PURPOSE,
            editId: randomUUID(),
            journeyId,
            basePlanVersion: command.basePlanVersion,
            baseObservationVersion: 0,
            baseFingerprint: result.baseFingerprint,
            candidateFingerprint: result.candidateFingerprint,
            change: command.change,
            datasetVersion: PLANNING_FIXTURE_VERSION,
            issuedAt: now,
            expiresAt: now + EDIT_RECEIPT_TTL,
          },
          config.secret,
        );
        return reply({
          status: "ready",
          draft: result.candidate.facts.draft,
          places: result.candidate.facts.places,
          comparison: result.comparison,
          receipt,
        });
      } catch {
        return reply({ status: "temporarily_unavailable" });
      }
    },
    async confirm(request: Request, journeyId: string) {
      const command = await readCommand(request, confirmDayEditCommandSchema);
      if (command instanceof Response) return command;
      const now = (options.now ?? Date.now)();
      const config = readDayEditConfig(options.environment);
      let receipt;
      try {
        receipt = verifyEditReceipt(command.receipt, config.secret, now);
        if (receipt.journeyId !== journeyId)
          return reply({ status: "invalid_receipt" });
      } catch {
        return reply({ status: "invalid_receipt" });
      }
      try {
        return reply(
          await confirmDayEdit({
            receipt,
            acknowledgeUnknowns: command.acknowledgeUnknowns,
            enabled: config.enabled,
            now,
            repository: repository(),
            idGenerator: { next: () => randomUUID() },
          }),
        );
      } catch {
        return reply({ status: "temporarily_unavailable" });
      }
    },
  };
}
