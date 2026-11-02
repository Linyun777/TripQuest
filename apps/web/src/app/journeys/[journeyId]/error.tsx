"use client";

import Link from "next/link";

export default function JourneyError({ retry }: { retry: () => void }) {
  return (
    <main className="flex min-h-dvh items-center bg-[#f7f9f7] px-6 text-[#21352e]">
      <div className="mx-auto w-full max-w-lg rounded-3xl border border-[#dce8e0] bg-white p-7 sm:p-10">
        <p className="text-sm font-semibold text-[#a14435]">暂时无法读取</p>
        <h1 className="mt-3 text-2xl font-semibold">行程暂时无法显示</h1>
        <p className="mt-3 text-sm leading-7 text-[#62736c]">请稍后重试。已经保存的行程不会因这次读取失败而更改。</p>
        <div className="mt-6 flex flex-wrap gap-3">
          <button type="button" onClick={retry} className="min-h-12 rounded-2xl bg-[#236d55] px-5 font-medium text-white hover:bg-[#195740]">重试</button>
          <Link href="/" className="inline-flex min-h-12 items-center rounded-2xl px-5 font-medium text-[#476357] hover:bg-[#e9f4ed]">返回首页</Link>
        </div>
      </div>
    </main>
  );
}
