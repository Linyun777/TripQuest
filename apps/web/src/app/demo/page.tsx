import type { Metadata } from "next";
import Link from "next/link";
import { BrandMark } from "../_ui/brand";
import { DemoJourney } from "./demo-journey";

export const metadata: Metadata = {
  title: "免登录体验 · TripQuest",
  description: "告诉 TripQuest 你的兴趣和时间，让它挑地点、排行程，再试试途中换一站。",
};

export default function DemoPage() {
  return (
    <div className="flex h-dvh flex-col bg-paper">
      <header className="shrink-0 border-b border-line bg-surface">
        <div className="mx-auto flex min-h-14 max-w-6xl items-center justify-between gap-3 px-4 sm:px-7">
          <Link href="/demo" className="flex min-h-11 items-center gap-2.5 rounded-md focus-visible:outline-2 focus-visible:outline-lake-600">
            <BrandMark size="sm" />
            <span className="font-semibold tracking-tight">TripQuest</span>
            <span className="border-l border-line pl-2.5 text-xs text-ink-soft">免登录演示</span>
          </Link>
          <Link href="/login" prefetch={false} className="inline-flex min-h-11 items-center rounded-full px-3.5 text-sm font-medium text-lake-700 hover:bg-lake-50 focus-visible:outline-2 focus-visible:outline-lake-600">
            登录
          </Link>
        </div>
      </header>
      <aside aria-label="正式使用说明" className="shrink-0 border-b border-line bg-lake-50">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-5 px-4 py-2 sm:px-7">
          <p className="max-w-4xl text-xs leading-5 text-ink-soft sm:text-sm">
            TripQuest 正在上线测试。为控制模型和地图费用、保障安全，正式使用需凭邀请码注册登录。可联系开发者获取。
          </p>
          <Link
            href="/register"
            prefetch={false}
            className="inline-flex min-h-9 shrink-0 items-center rounded text-xs font-medium text-lake-700 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-lake-600 sm:text-sm"
          >
            凭邀请码注册
          </Link>
        </div>
      </aside>
      <DemoJourney />
    </div>
  );
}
