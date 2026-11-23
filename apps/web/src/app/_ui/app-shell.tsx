"use client";

import { Activity, Bookmark, Compass, Map as MapIcon, UserRound } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import Link from "next/link";
import type { ReactNode } from "react";
import { BrandMark } from "./brand";
import { cn } from "./cn";
import { SPRING_BOUNCY, SPRING_SNAPPY } from "./motion";

export type AppTab = "plan" | "trips" | "preferences" | "account";

const NAV_ITEMS: readonly {
  readonly id: AppTab;
  readonly href: string;
  readonly label: string;
  readonly icon: typeof Compass;
}[] = [
  { id: "plan", href: "/", label: "规划", icon: Compass },
  { id: "trips", href: "/trips", label: "行程", icon: MapIcon },
  { id: "preferences", href: "/preferences", label: "偏好", icon: Bookmark },
  { id: "account", href: "/account", label: "我的", icon: UserRound },
];

/**
 * 统一 App 壳层（莫兰迪毛玻璃版）：
 * - 手机端：顶部通透毛玻璃品牌条 + 底部悬浮毛玻璃胶囊 Dock（带弹性莫兰迪底囊与图标微弹）。
 * - 桌面端：顶部通透毛玻璃导航栏（居中无框 4-Tab + 底部弹性莫兰迪指示条 + 右侧轻盈入口）。
 */
export function AppShell({
  active,
  user,
  mobileHeaderRight,
  desktopHeaderRight,
  maxWidth = "max-w-5xl",
  ambient = true,
  children,
}: {
  active: AppTab;
  user: { readonly displayUsername: string; readonly role: "admin" | "user" };
  mobileHeaderRight?: ReactNode;
  desktopHeaderRight?: ReactNode;
  maxWidth?: "max-w-3xl" | "max-w-5xl";
  ambient?: boolean;
  children: ReactNode;
}) {
  const reduced = useReducedMotion();

  return (
    <div className="relative flex min-h-dvh flex-col overflow-x-clip">
      {ambient && (
        <div aria-hidden="true" className="pointer-events-none fixed inset-0 overflow-hidden">
          <div className="morandi-drift absolute -left-24 -top-28 h-[420px] w-[500px] rounded-full bg-[#b9ced1]/42 blur-[95px]" />
          <div className="morandi-drift-alt absolute -right-24 top-12 h-[380px] w-[420px] rounded-full bg-[#e3d3c6]/45 blur-[100px]" />
        </div>
      )}
      {/* 顶部栏：通透莫兰迪毛玻璃，透出柔和光影与滚动内容 */}
      <header className="glass-bar sticky top-0 z-20 pt-[env(safe-area-inset-top)] transition-colors duration-300">
        <div className={cn("mx-auto flex h-14 items-center justify-between gap-3 px-4 sm:px-8 md:h-[62px]", maxWidth)}>
          <Link
            href="/"
            className="group flex shrink-0 items-center gap-2.5 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-600"
            aria-label="TripQuest 首页"
          >
            <span className="transition-transform duration-200 ease-(--ease-out) group-hover:scale-[1.04] group-active:scale-[0.96]">
              <BrandMark size="sm" className="md:size-9" />
            </span>
            <span className="text-[15px] font-semibold tracking-tight text-ink md:text-base">
              TripQuest
            </span>
          </Link>

          {/* 桌面端居中主导航：自然融入毛玻璃顶栏，选中带弹性莫兰迪指示条 */}
          <nav aria-label="主导航" className="hidden items-center gap-1 md:flex">
            {NAV_ITEMS.map((item) => {
              const isActive = active === item.id;
              return (
                <Link
                  key={item.id}
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "relative inline-flex h-9 items-center rounded-full px-4 text-sm transition-colors duration-150",
                    isActive
                      ? "font-semibold text-ink"
                      : "font-medium text-ink-soft hover:bg-ink/[0.045] hover:text-ink",
                    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-600",
                  )}
                >
                  <span>{item.label}</span>
                  {isActive && (
                    <motion.span
                      layoutId="desktop-nav-indicator"
                      aria-hidden="true"
                      transition={reduced ? { duration: 0.12 } : SPRING_BOUNCY}
                      className="absolute inset-x-4 bottom-0.5 h-[2.5px] rounded-full bg-lake-600"
                    />
                  )}
                </Link>
              );
            })}
          </nav>

          {/* 桌面端右侧操作 */}
          <div className="hidden items-center gap-1.5 md:flex">
            {user.role === "admin" && (
              <>
                <Link
                  href="/ops"
                  className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-ink-soft transition-colors duration-150 hover:bg-ink/[0.045] hover:text-lake-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-600"
                >
                  <Activity className="size-3.5 text-lake-600" />
                  <span>观测</span>
                </Link>
                <span className="h-3.5 w-px bg-ink/10" aria-hidden="true" />
              </>
            )}
            {desktopHeaderRight ?? (
              <Link
                href="/account"
                className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-sm text-ink-soft transition-colors duration-150 hover:bg-ink/[0.045] hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-600"
              >
                <span className="max-w-24 truncate">{user.displayUsername}</span>
              </Link>
            )}
          </div>

          {/* 手机端右侧操作 */}
          <div className="flex items-center gap-1.5 md:hidden">
            {mobileHeaderRight}
            {!mobileHeaderRight && user.role === "admin" && (
              <Link
                href="/ops"
                aria-label="站长观测"
                className="inline-flex h-8 items-center gap-1 rounded-full bg-lake-600/12 px-2.5 text-xs font-medium text-lake-700 transition-transform active:scale-[0.95]"
              >
                <Activity className="size-3.5" />
                <span>观测</span>
              </Link>
            )}
          </div>
        </div>
      </header>

      {/* 主内容区：手机端自动留出底部悬浮毛玻璃 Dock 与安全区高度 */}
      <div className="flex-1 pb-[calc(6.25rem+env(safe-area-inset-bottom))] md:pb-16">
        {children}
      </div>

      {/* 手机端悬浮毛玻璃 App Dock */}
      <nav
        aria-label="底部导航"
        className="pointer-events-none fixed inset-x-0 bottom-0 z-30 px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] md:hidden"
      >
        <ul className="glass-dock pointer-events-auto mx-auto grid max-w-sm grid-cols-4 rounded-[28px] p-1.5">
          {NAV_ITEMS.map((item) => {
            const isActive = active === item.id;
            const Icon = item.icon;
            return (
              <li key={item.id}>
                <Link
                  href={item.href}
                  aria-current={isActive ? "page" : undefined}
                  className={cn(
                    "relative flex flex-col items-center justify-center gap-0.5 rounded-[22px] py-1.5 transition-transform duration-150 ease-(--ease-out) active:scale-[0.92]",
                    "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-lake-600",
                    isActive ? "text-lake-700" : "text-ink-faint",
                  )}
                >
                  {isActive && (
                    <motion.span
                      layoutId="mobile-tab-pill"
                      aria-hidden="true"
                      transition={reduced ? { duration: 0.12 } : SPRING_SNAPPY}
                      className="absolute inset-0 -z-10 rounded-[22px] bg-lake-600/12 ring-1 ring-lake-600/12"
                    />
                  )}
                  <motion.span
                    animate={
                      reduced
                        ? undefined
                        : isActive
                          ? { transform: "translateY(-1px) scale(1.06)" }
                          : { transform: "translateY(0px) scale(1)" }
                    }
                    transition={SPRING_BOUNCY}
                    className="inline-flex"
                  >
                    <Icon className={cn("size-[19px]", isActive && "stroke-[2.2]")} />
                  </motion.span>
                  <span className={cn("text-[11px] leading-tight", isActive ? "font-semibold" : "font-medium")}>
                    {item.label}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}
