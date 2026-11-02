import type { Metadata } from "next";
import Link from "next/link";

import { JourneyForm } from "./journey-form";

export const metadata: Metadata = {
  title: "创建一日行程 · TripQuest",
  description: "录入并保存一日行程与固定预约。",
};

export default function NewJourneyPage() {
  return (
    <main className="min-h-dvh bg-[#f7f9f7] px-4 py-6 text-[#21352e] sm:px-6 sm:py-10">
      <div className="mx-auto max-w-3xl">
        <header className="mb-10 flex items-center justify-between gap-4">
          <Link href="/" className="flex items-center gap-3 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#236d55]" aria-label="返回 TripQuest 首页">
            <span className="grid size-10 place-items-center rounded-2xl bg-[#236d55] text-sm font-bold text-white">TQ</span>
            <span className="font-semibold">TripQuest</span>
          </Link>
          <span className="rounded-full border border-[#dce8e0] bg-white px-3 py-1.5 text-xs font-medium text-[#476357]">创建行程</span>
        </header>
        <div className="mb-8">
          <p className="mb-3 text-xs font-semibold tracking-[0.16em] text-[#4f806e]">一次出发，从清晰安排开始</p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">创建一日行程</h1>
          <p className="mt-4 max-w-2xl text-sm leading-7 text-[#62736c] sm:text-base">
            先保存你已知的活动与固定预约。之后可以随时回来查看这份安排。
          </p>
        </div>
        <JourneyForm />
      </div>
    </main>
  );
}
