import Link from "next/link";
import type { ReactNode } from "react";
import { BrandMark } from "../_ui/brand";
import { Reveal } from "../_ui/reveal";
import { HomePreview } from "../home-preview";

/**
 * 登录、注册页的外框（V2.12 验收后重做：原来是灰底上一张裸表单）。和首页同一套视觉：顶部的柔和渐变、
 * 带阴影的圆角卡片。电脑上左边是品牌、一句话和首页的示例方案，右边是表单卡片；手机上只有卡片。
 */
export function AuthShell({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <div className="relative min-h-dvh overflow-hidden bg-paper">
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 overflow-hidden">
        <div className="morandi-drift absolute -left-24 -top-28 h-[480px] w-[540px] rounded-full bg-[#b9ced1]/55 blur-[95px]" />
        <div className="morandi-drift-alt absolute -right-20 top-10 h-[420px] w-[480px] rounded-full bg-[#e3d3c6]/58 blur-[100px]" />
        <div className="morandi-drift absolute bottom-0 left-1/3 h-[340px] w-[420px] rounded-full bg-[#c8d5ce]/42 blur-[110px]" />
      </div>
      <div className="relative mx-auto flex min-h-dvh max-w-5xl flex-col px-4 sm:px-8">
        <header className="flex h-16 shrink-0 items-center">
          <Link href="/" className="flex items-center gap-2.5" aria-label="TripQuest">
            <BrandMark size="md" />
            <span className="font-semibold tracking-tight">TripQuest</span>
          </Link>
          <Link
            href="/demo"
            className="glass-pill ml-auto inline-flex h-9 items-center rounded-full px-4 text-sm font-medium text-lake-700 transition-colors hover:bg-white/80 focus-visible:outline-2 focus-visible:outline-lake-600"
          >
            免登录体验
          </Link>
        </header>

        <main className="grid flex-1 content-start gap-8 pb-12 pt-6 lg:grid-cols-[minmax(0,1fr)_400px] lg:content-center lg:items-center lg:gap-16 lg:pb-20 lg:pt-4">
          <section className="hidden lg:block">
            <Reveal>
              <h2 className="text-5xl font-semibold leading-[1.15] tracking-tight">
                说一句话，
                <br />
                排好要去的每一天
              </h2>
            </Reveal>
            <Reveal order={1}>
              <p className="mt-5 max-w-md text-base leading-7 text-ink-soft">
                想法、预约和兴趣直接说。每段路都向高德核对，看着天气排，走得通才给你。
              </p>
            </Reveal>
            <Reveal order={2} className="mt-10 max-w-sm">
              <HomePreview />
            </Reveal>
          </section>

          <Reveal className="lg:hidden">
            <p className="text-[28px] font-semibold leading-[1.25] tracking-tight">
              说一句话，
              <br />
              排好要去的每一天
            </p>
          </Reveal>

          <Reveal order={1} className="w-full">
            <div className="glass-card mx-auto w-full max-w-[400px] rounded-[28px] p-6 sm:p-8">
              <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
              <p className="mt-2 text-sm leading-6 text-ink-soft">{note}</p>
              {children}
            </div>
          </Reveal>
        </main>
      </div>
    </div>
  );
}
