"use client";

import { Check, MapPin, RefreshCw, Star } from "lucide-react";
import { motion } from "motion/react";
import { Badge } from "../_ui/badge";
import { Button } from "../_ui/button";
import { Card, CardBody, CardFooter, CardHeader, CardTitle } from "../_ui/card";
import { cn } from "../_ui/cn";
import { MODE_STYLE } from "./plan-card";
import type { ChoiceOptionView, ChoicesView } from "./view-models";

/** "650 米" / "1.2 公里". */
function distance(meters: number): string {
  return meters < 1000 ? `${Math.round(meters / 10) * 10} 米` : `${(meters / 1000).toFixed(1)} 公里`;
}

/**
 * V2.4: one step of a short trip. Candidates best first; distance and route are live for this
 * step only, rating and price are Amap's and shown as a reference.
 */
export function ChoicesCard({
  view,
  onPick,
  onRefresh,
  busy = false,
}: {
  view: ChoicesView;
  onPick?: (option: ChoiceOptionView) => void;
  onRefresh?: () => void;
  busy?: boolean;
}) {
  const from = view.step === 1 ? "距你" : `离${view.anchorName}`;
  const live = view.options.some((option) => option.travel || option.rating !== undefined);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-baseline gap-x-2">
          <span>第 {view.step}/{view.total} 站 · {view.interest}</span>
          <span className="text-sm font-normal text-ink-soft">在{view.anchorName}附近{view.round > 1 ? ` · 第 ${view.round} 批` : ""}</span>
        </CardTitle>
      </CardHeader>
      <CardBody>
        <ol className="space-y-2.5">
          {view.options.map((option, index) => {
            const chosen = view.chosen === option.externalId;
            const style = option.travel ? MODE_STYLE[option.travel.mode] : null;
            const Icon = style?.icon;
            return (
              <motion.li
                key={option.externalId}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.06 * index, duration: 0.3 }}
                className={cn(
                  "rounded-(--radius-field) border p-3",
                  chosen ? "border-lake-600 bg-lake-50" : "border-line bg-surface",
                  view.chosen && !chosen && "opacity-55",
                )}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="flex flex-wrap items-center gap-1.5 font-medium">
                      <span className="grid size-5 place-items-center rounded-full bg-lake-600 text-[11px] font-semibold text-white">{index + 1}</span>
                      <span className="break-words">{option.name}</span>
                      {index === 0 && !view.chosen && <Badge tone="lake">推荐</Badge>}
                      {chosen && <Badge tone="lake"><Check className="size-3" />已选</Badge>}
                    </p>
                    <p className="mt-1 text-sm text-ink-soft">{option.reason}</p>
                    <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-soft">
                      {option.meters !== undefined && (
                        <span className="inline-flex items-center gap-1"><MapPin className="size-3.5" />{from} {distance(option.meters)}</span>
                      )}
                      {option.travel && style && Icon && (
                        <span className={cn("inline-flex items-center gap-1", style.className)}>
                          <Icon className="size-3.5" />
                          {option.travel.summary ?? style.label} 约 {option.travel.minutes} 分钟
                          {option.travel.fareYuan !== undefined ? ` · ${Math.round(option.travel.fareYuan)} 元` : ""}
                        </span>
                      )}
                      {option.keytag && <span>{option.keytag}</span>}
                      {option.rating !== undefined && (
                        <span className="inline-flex items-center gap-0.5"><Star className="size-3.5 text-sun-500" />{option.rating.toFixed(1)}</span>
                      )}
                      {option.costYuan !== undefined && <span>人均 {Math.round(option.costYuan)} 元</span>}
                      {option.openToday && <span>今天 {option.openToday}</span>}
                    </p>
                  </div>
                  {view.open && onPick && (
                    <Button size="sm" variant={index === 0 ? "primary" : "secondary"} disabled={busy} onClick={() => onPick(option)} className="shrink-0">
                      就去这家
                    </Button>
                  )}
                </div>
              </motion.li>
            );
          })}
        </ol>
      </CardBody>
      {(view.canRefresh || live) && (
        <CardFooter className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-ink-faint">{live ? "评分、人均和营业时间来自高德，仅供参考，出发前请确认。" : ""}</p>
          {view.canRefresh && onRefresh && (
            <Button size="sm" variant="ghost" disabled={busy} onClick={onRefresh}>
              <RefreshCw />
              换一批
            </Button>
          )}
        </CardFooter>
      )}
    </Card>
  );
}
