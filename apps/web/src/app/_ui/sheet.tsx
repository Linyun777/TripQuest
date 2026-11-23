"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn";

/**
 * 响应式抽屉：手机端从底部滑出（配安全区与滚动隔离），桌面端可选右侧抽屉或底部弹层。
 */
export function Sheet({
  open,
  onOpenChange,
  title,
  subtitle,
  desktopSide = false,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  subtitle?: string;
  desktopSide?: boolean;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="sheet-overlay fixed inset-0 z-40 bg-ink/20 backdrop-blur-[3px]" />
        <Dialog.Content
          className={cn(
            "sheet-content fixed inset-x-0 bottom-0 z-50 flex max-h-[88dvh] flex-col rounded-t-[28px]",
            "border-t border-white/75 bg-paper/90 shadow-float backdrop-blur-2xl outline-none",
            desktopSide &&
              "sheet-side md:inset-y-0 md:left-auto md:right-0 md:max-h-dvh md:w-full md:max-w-lg md:rounded-none md:rounded-l-[28px] md:border-l md:border-t-0 md:border-white/75",
          )}
        >
          <div
            className={cn(
              "mx-auto mt-2.5 h-1.5 w-10 rounded-full bg-line-strong",
              desktopSide && "md:hidden",
            )}
            aria-hidden="true"
          />
          <div className="flex items-start justify-between gap-3 px-5 pb-3 pt-3.5 md:px-6 md:pt-5">
            <div className="min-w-0">
              <Dialog.Title className="text-base font-semibold text-ink">{title}</Dialog.Title>
              {subtitle && <p className="mt-0.5 text-xs text-ink-soft">{subtitle}</p>}
            </div>
            <Dialog.Close
              className="grid size-9 shrink-0 place-items-center rounded-full text-ink-soft outline-none transition-[background-color,transform] duration-150 hover:bg-sunken active:scale-[0.95] focus-visible:ring-2 focus-visible:ring-lake-600"
              aria-label="关闭"
            >
              <X className="size-4" />
            </Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">{subtitle ?? title}</Dialog.Description>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] md:px-6 md:pb-6">
            {children}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
