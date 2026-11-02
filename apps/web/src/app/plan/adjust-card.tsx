"use client";

import { ArrowRight, Check, CircleCheck, GitCommitVertical, Plus, TriangleAlert, X } from "lucide-react";
import { motion } from "motion/react";
import Link from "next/link";
import { Button } from "../_ui/button";
import { Card, CardBody, CardFooter, CardHeader, CardTitle } from "../_ui/card";
import { cn } from "../_ui/cn";
import type { AdjustCardView } from "./view-models";

const KIND = {
  done: { label: "已完成", icon: CircleCheck, tone: "bg-sunken text-ink-faint" },
  kept: { label: "保留", icon: Check, tone: "bg-lake-50 text-lake-700" },
  moved: { label: "时间变了", icon: GitCommitVertical, tone: "bg-sun-50 text-sun-700" },
  added: { label: "新增", icon: Plus, tone: "bg-lake-600 text-white" },
  removed: { label: "去掉", icon: X, tone: "bg-danger-50 text-danger-600" },
} as const;

/**
 * V2.5: the change to the saved trip, old remainder beside the new one, row by row. Nothing
 * changes until "确认调整"; a suggestion to drop a stop is said plainly above the rows.
 */
export function AdjustCard({
  card,
  onConfirm,
  confirming = false,
}: {
  card: AdjustCardView;
  onConfirm?: () => void;
  confirming?: boolean;
}) {
  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <div>
          <p className="text-xs font-medium text-lake-600">调整方案 · 基于第 {card.basePlanVersion} 版</p>
          <CardTitle className="mt-0.5 text-base">{card.note}</CardTitle>
          <p className="tabular mt-1 text-sm text-ink-soft">{card.arriveAt} 到达{card.endName}</p>
        </div>
      </CardHeader>
      <CardBody className="space-y-3 pt-3">
        {card.suggestDrop && (
          <p className="flex items-start gap-2 rounded-(--radius-field) bg-sun-50 px-3.5 py-2.5 text-sm text-sun-700">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" />
            按原样排不开：建议去掉「{card.suggestDrop}」，其余照常。确认调整即同意去掉。
          </p>
        )}
        {/* Phones: the name on its own line, the old and new times below; columns from sm up. */}
        <div className="text-sm">
          <div className="hidden grid-cols-[minmax(0,1fr)_7.5rem_1rem_7.5rem] gap-x-2 pb-1.5 text-xs text-ink-faint sm:grid">
            <span>地点</span>
            <span className="text-right">原来</span>
            <span />
            <span>调整后</span>
          </div>
          <ul className="divide-y divide-line/70">
            {card.items.map((item, index) => {
              const kind = KIND[item.kind];
              const Icon = kind.icon;
              const gone = item.kind === "removed" || item.kind === "done";
              return (
                <motion.li
                  key={`${item.kind}-${item.name}-${index}`}
                  className="grid grid-cols-[auto_1rem_auto] items-center justify-start gap-x-2 gap-y-1 py-2 sm:grid-cols-[minmax(0,1fr)_7.5rem_1rem_7.5rem] sm:justify-stretch"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: index * 0.05 }}
                >
                  <span className="col-span-3 flex min-w-0 items-center gap-2 sm:col-span-1">
                    <span className={cn("inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium", kind.tone)}>
                      <Icon className="size-3" />
                      {kind.label}
                    </span>
                    <span className={cn("truncate", gone && "text-ink-faint line-through decoration-ink-faint/60")}>{item.name}</span>
                  </span>
                  <span className={cn("tabular whitespace-nowrap text-ink-soft sm:text-right", item.kind === "moved" && "line-through decoration-ink-faint/60")}>
                    {item.before ? `${item.before.startsAt}–${item.before.endsAt}` : "—"}
                  </span>
                  <ArrowRight className="size-3.5 text-ink-faint" />
                  <span className={cn("tabular whitespace-nowrap", item.kind === "moved" || item.kind === "added" ? "font-medium text-ink" : "text-ink-soft")}>
                    {item.after ? `${item.after.startsAt}–${item.after.endsAt}` : "—"}
                  </span>
                </motion.li>
              );
            })}
          </ul>
        </div>
        <p className="text-xs text-ink-faint">营业时间和路线已按现在的情况重新查过；确认时会再核对一次。</p>
      </CardBody>
      <CardFooter>
        {card.savedVersion ? (
          <Button asChild size="sm">
            <Link href={`/journeys/${card.journeyId}`}>
              <Check />
              已保存为第 {card.savedVersion} 版 · 查看行程
            </Link>
          </Button>
        ) : card.open ? (
          <Button size="sm" onClick={onConfirm} disabled={!onConfirm || confirming}>
            <Check />
            {confirming ? "保存中…" : "确认调整"}
          </Button>
        ) : (
          <span className="text-xs text-ink-faint">这个调整方案已经不能确认了（离开过页面或有了更新的消息），可以再跟我说一次</span>
        )}
      </CardFooter>
    </Card>
  );
}
