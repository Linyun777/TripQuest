import Link from "next/link";

export default function JourneyNotFound() {
  return (
    <main className="flex min-h-dvh items-center bg-[#f7f9f7] px-6 text-[#21352e]">
      <div className="mx-auto w-full max-w-lg rounded-3xl border border-[#dce8e0] bg-white p-7 sm:p-10">
        <p className="text-sm font-semibold text-[#4f806e]">404 · 未找到行程</p>
        <h1 className="mt-3 text-2xl font-semibold">这份行程不存在</h1>
        <p className="mt-3 text-sm leading-7 text-[#62736c]">检查链接是否完整，或重新创建一份行程。</p>
        <Link href="/journeys/new" className="mt-6 inline-flex min-h-12 items-center rounded-2xl bg-[#236d55] px-5 font-medium text-white hover:bg-[#195740]">创建一日行程</Link>
      </div>
    </main>
  );
}
