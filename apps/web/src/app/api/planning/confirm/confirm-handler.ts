import "server-only";
import { traced } from "../../../runs/runs";
import { withUser, type UserResolver } from "../../../auth/session";
import { randomUUID } from "node:crypto";
import {
  confirmDayCommandSchema,
  type ConfirmDayReply,
} from "@tripquest/application/day-save-api";
import {
  confirmGeneratedDay,
  type GeneratedDayRepository,
} from "@tripquest/application/generated-day";
import { DrizzleJourneyRepository, getSharedJourneyDatabase } from "@tripquest/db";
import { daySnapshotSource } from "@tripquest/application/day-confirmation";
import { confirmRealDay, type RealDayRepository } from "@tripquest/application/real-day";
import { readRealPlaceMode } from "../../../real-places/real-mode";
import {
  createUserUsage,
  meteredAmap,
} from "../../../usage/usage";
import type { MobilityProvider } from "@tripquest/providers";
import {
  DraftReceiptError,
  readDraftSaveConfig,
  verifyDraftReceipt,
} from "../../../planning/new/draft-receipt";
import { logFailure } from "../failure-code";
import { readBody, sameOrigin } from "../request-body";

function json(status: number, body: ConfirmDayReply): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}
const HTTP_STATUS: Record<Exclude<ConfirmDayReply["status"], "saved" | "already_saved">, number> = {
  invalid_request: 400,
  invalid_receipt: 403,
  source_not_allowed: 403,
  expired: 410,
  disabled: 503,
  acknowledgment_required: 422,
  draft_changed: 409,
  intent_conflict: 409,
  temporarily_unavailable: 503,
};

export function createConfirmDayHandler(options: {
  environment?: NodeJS.ProcessEnv;
  now?: () => number;
  repository?: () => GeneratedDayRepository;
  realRepository?: () => RealDayRepository;
  /** Tests only: replaces the metered Amap routes used to recheck a real draft. */
  realRoutes?: MobilityProvider;
  /** V2.12：测试注入当前用户。 */
  user?: UserResolver;
} = {}) {
  return withUser(options, async (request, user): Promise<Response> => {
    if (!sameOrigin(request)) return json(403, { status: "invalid_request" });
    if (!/^application\/json\s*(?:;|$)/i.test(request.headers.get("content-type") ?? "")) {
      return json(415, { status: "invalid_request" });
    }
    const body = await readBody(request);
    if (body === "too_large") return json(413, { status: "invalid_request" });
    let command;
    try {
      command = confirmDayCommandSchema.parse(JSON.parse(body));
    } catch {
      return json(400, { status: "invalid_request" });
    }
    const now = (options.now ?? Date.now)();
    const config = readDraftSaveConfig(options.environment);
    let payload;
    try {
      payload = verifyDraftReceipt(command.receipt, config.secret, now);
    } catch (error) {
      const status = error instanceof DraftReceiptError ? error.code : "invalid_receipt";
      return json(403, { status });
    }
    try {
      if (daySnapshotSource(payload.snapshot) === "amap") {
        // S5.5: only the local personal mode may store real days (D-046).
        const mode = readRealPlaceMode(options.environment);
        if (!mode.enabled) return json(403, { status: "source_not_allowed" });
        const result = await traced({ trigger: "save", userId: user.id }, () => confirmRealDay({
          snapshot: payload.snapshot,
          draftFingerprint: payload.draftFingerprint,
          expiresAt: payload.expiresAt,
          enabled: config.enabled,
          title: command.title,
          acknowledgeUnknowns: command.acknowledgeUnknowns,
          repository: options.realRepository?.() ??
            new DrizzleJourneyRepository(getSharedJourneyDatabase().database, user.id),
          routes: options.realRoutes ?? meteredAmap({
            key: mode.key,
            usage: createUserUsage(user.id),
            purpose: "save",
          }),
          idGenerator: { next: () => randomUUID() },
          clock: { now: () => new Date(now) },
        }));
        const status = result.status === "saved"
          ? 201
          : result.status === "already_saved"
          ? 200
          : HTTP_STATUS[result.status];
        return json(status, result);
      }
      const repository = options.repository?.() ??
        new DrizzleJourneyRepository(getSharedJourneyDatabase().database, user.id);
      const result = await confirmGeneratedDay({
        snapshot: payload.snapshot,
        draftFingerprint: payload.draftFingerprint,
        expiresAt: payload.expiresAt,
        enabled: config.enabled,
        title: command.title,
        acknowledgeUnknowns: command.acknowledgeUnknowns,
        repository,
        idGenerator: { next: () => randomUUID() },
        clock: { now: () => new Date(now) },
      });
      const status = result.status === "saved"
        ? 201
        : result.status === "already_saved"
        ? 200
        : HTTP_STATUS[result.status];
      return json(status, result);
    } catch (error) {
      logFailure("confirm", error, options.environment);
      // A lost response or database fault does not establish that no write occurred.
      return json(503, { status: "temporarily_unavailable" });
    }
  });
}
