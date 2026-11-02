"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { DayDraft, DaySaveOffer } from "@tripquest/application/day-planning";
import {
  confirmDayReplySchema,
  type ConfirmDayReply,
} from "@tripquest/application/day-save-api";
import { primaryButton } from "./place-search";

const ERRORS: Record<Exclude<ConfirmDayReply["status"], "saved" | "already_saved">, string> = {
  invalid_request: "标题或提交格式无效，请核对后再确认。",
  invalid_receipt: "这份草稿的保存凭据已失效，请重新生成。",
  source_not_allowed: "当前设置下这份草稿不能保存。",
  expired: "保存凭据已过期，请重新生成草稿。",
  disabled: "保存暂不可用，请确认数据库已启动后重试。",
  acknowledgment_required: "请先勾选：营业、票务与预约需要自行确认。",
  draft_changed: "步行路线时间有变化，草稿已不准确，请重新生成。",
  intent_conflict: "这轮草稿已按另一份标题或确认内容保存，不能重复创建。",
  temporarily_unavailable: "尚未拿到保存结果，请使用相同内容手动重试。",
};
const UNAVAILABLE = {
  disabled: "保存尚未启用，草稿仍可查看。",
  source_not_allowed: "当前设置下这份草稿不能保存，仍可查看。",
  snapshot_invalid: "未拿到完整的保存依据，此草稿暂不能保存。",
  receipt_too_large: "草稿的保存依据超出大小限制，仍可阅读时间线。",
} as const;

export function DraftSavePanel({
  draft,
  offer,
}: {
  draft: DayDraft;
  offer?: DaySaveOffer;
}) {
  const router = useRouter();
  const [title, setTitle] = useState(`杭州一日行程 · ${draft.date}`);
  const [acknowledge, setAcknowledge] = useState(false);
  const [phase, setPhase] = useState<
    "editing" | "saving" | "uncertain" | "saved" | "rejected"
  >("editing");
  const [notice, setNotice] = useState("");
  const [saved, setSaved] = useState<Extract<ConfirmDayReply, { journeyId: string }> | null>(null);
  const intent = useRef<{
    receipt: string;
    title: string;
    acknowledgeUnknowns: boolean;
  } | null>(null);
  const busy = useRef(false);
  const request = useRef(0);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => {
    request.current += 1;
    controller.current?.abort();
  }, []);

  if (offer?.status !== "available") {
    return (
      <p className="mt-5 text-sm leading-6 text-[#52665c]">
        {offer ? UNAVAILABLE[offer.reason] : "这份草稿不能保存，仍可查看。"}
      </p>
    );
  }
  const locked = phase === "saving" || phase === "uncertain" || phase === "saved";
  async function save() {
    if (busy.current || phase === "saved" || offer?.status !== "available") return;
    if (!intent.current) {
      intent.current = {
        receipt: offer.receipt,
        title: title.trim(),
        acknowledgeUnknowns: acknowledge,
      };
    }
    busy.current = true;
    const current = ++request.current;
    const abort = new AbortController();
    controller.current = abort;
    setPhase("saving");
    setNotice("");
    try {
      const response = await fetch("/api/planning/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(intent.current),
        cache: "no-store",
        signal: abort.signal,
      });
      const text = await response.text();
      if (current !== request.current) return;
      if (new TextEncoder().encode(text).byteLength > 4096) throw new Error("response_limit");
      const reply = confirmDayReplySchema.parse(JSON.parse(text));
      if (reply.status === "saved" || reply.status === "already_saved") {
        if (!response.ok) throw new Error("inconsistent_response");
        setSaved(reply);
        setPhase("saved");
        setNotice(reply.status === "saved" ? "已保存。" : "这份行程之前已经保存过。");
        router.push(`/journeys/${reply.journeyId}`);
      } else if (reply.status === "temporarily_unavailable") {
        setPhase("uncertain");
        setNotice(ERRORS[reply.status]);
      } else {
        setNotice(ERRORS[reply.status]);
        setPhase("rejected");
        intent.current = null;
      }
    } catch {
      if (current === request.current) {
        setPhase("uncertain");
        setNotice("没收到保存结果，可能已经保存成功；请用相同内容再试一次。");
      }
    } finally {
      if (current === request.current) {
        busy.current = false;
        controller.current = null;
      }
    }
  }

  return (
    <section
      className="mt-6 space-y-4 rounded-2xl border border-[#b8cfc0] bg-[#f1f7f2] p-5"
      aria-labelledby="save-heading"
    >
      <h3 id="save-heading" className="text-lg font-semibold">
        保存这份安排
      </h3>
      <label className="block text-sm font-medium">
        行程标题
        <input
          className="mt-2 min-h-12 w-full rounded-xl border border-[#b8cfc0] bg-white px-3 disabled:bg-[#e6eee8]"
          value={title}
          maxLength={80}
          disabled={locked}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      {offer.acknowledgeUnknownsRequired && (
        <label className="flex items-start gap-3 text-sm leading-6">
          <input
            type="checkbox"
            className="mt-1 size-5 shrink-0 accent-[#236d55]"
            checked={acknowledge}
            disabled={locked}
            onChange={(event) => setAcknowledge(event.target.checked)}
          />
          <span>我知道营业时间、门票和预约需要自己确认。</span>
        </label>
      )}
      {!saved && (
        <button
          type="button"
          className={primaryButton}
          disabled={
            phase === "saving" ||
            !title.trim() ||
            (offer.acknowledgeUnknownsRequired && !acknowledge && phase !== "uncertain")
          }
          onClick={save}
        >
          {phase === "saving"
            ? "正在保存…"
            : phase === "uncertain"
            ? "使用相同内容重试保存"
            : "确认并保存"}
        </button>
      )}
      <p className="text-sm leading-6" role="status" aria-live="polite">
        {notice}
      </p>
      {saved && (
        <Link href={`/journeys/${saved.journeyId}`} className={primaryButton}>
          查看已保存行程
        </Link>
      )}
      <p className="text-xs leading-6 text-[#52665c]">
        请在 {new Date(offer.expiresAt).toLocaleTimeString("zh-CN", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "Asia/Shanghai",
        })} 前保存，之后需要重新生成。
      </p>
    </section>
  );
}
