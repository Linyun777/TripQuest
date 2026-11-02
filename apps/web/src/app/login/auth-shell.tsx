import Link from "next/link";
import type { ReactNode } from "react";
import { Reveal } from "../_ui/reveal";
import { HomePreview } from "../home-preview";

/**
 * 登录、注册页的外框（V2.12 验收后重做：原来是灰底上一张裸表单）。和首页同一套视觉：顶部的柔和渐变、
 * 带阴影的圆角卡片。电脑上左边是品牌、一句话和首页的示例方案，右边是表单卡片；手机上只有卡片。
 */
export function AuthShell({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <div className="relative min-h-dvh overflow-hidden bg-paper">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[560px] bg-[radial-gradient(60%_60%_at_20%_0%,var(--color-lake-100),transparent_70%),radial-gradient(40%_50%_at_90%_10%,var(--color-sun-50),transparent_70%)]"
      />
      <div className="relative mx-auto flex min-h-dvh max-w-5xl flex-col px-4 sm:px-8">
        <header className="flex h-16 shrink-0 items-center">
          <Link href="/" className="flex items-center gap-2.5" aria-label="TripQuest">
            <span className="grid size-9 place-items-center rounded-xl bg-lake-600 text-xs font-bold text-white">TQ</span>
            <span className="font-semibold tracking-tight">TripQuest</span>
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
            <p className="font-heading text-[28px] font-semibold leading-[1.25]">
              说一句话，
              <br />
              排好要去的每一天
            </p>
          </Reveal>

          <Reveal order={1} className="w-full">
            <div className="mx-auto w-full max-w-[400px] rounded-[28px] border border-line bg-surface/90 p-6 shadow-float backdrop-blur-sm sm:p-8">
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
