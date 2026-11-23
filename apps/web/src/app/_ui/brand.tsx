import { useId } from "react";
import { cn } from "./cn";

type BrandMarkProps = {
  size?: "sm" | "md" | "lg";
  shape?: "squircle" | "circle";
  tone?: "brand" | "ink";
  className?: string;
};

const SIZE_CLASS: Record<NonNullable<BrandMarkProps["size"]>, string> = {
  sm: "size-7",
  md: "size-9",
  lg: "size-10",
};

/**
 * TripQuest 品牌徽标：起点锚点、蜿蜒旅途路径与四角星罗盘。
 * 随主题变量自动适配日常（湖绿 + 暖阳）与出游（赤陶 + 琥珀）配色。
 */
export function BrandMark({
  size = "md",
  shape = "squircle",
  tone = "brand",
  className,
}: BrandMarkProps) {
  const gradId = useId();
  const radius = shape === "circle" ? 19.5 : 11.5;

  return (
    <svg
      viewBox="0 0 40 40"
      fill="none"
      aria-hidden="true"
      className={cn(SIZE_CLASS[size], "shrink-0 select-none", className)}
    >
      <defs>
        <linearGradient id={gradId} x1="4" y1="3" x2="36" y2="38" gradientUnits="userSpaceOnUse">
          {tone === "ink" ? (
            <>
              <stop offset="0%" stopColor="var(--color-ink)" />
              <stop offset="100%" stopColor="var(--color-lake-900)" />
            </>
          ) : (
            <>
              <stop offset="0%" stopColor="var(--color-lake-500)" />
              <stop offset="55%" stopColor="var(--color-lake-600)" />
              <stop offset="100%" stopColor="var(--color-lake-700)" />
            </>
          )}
        </linearGradient>
      </defs>

      <rect x="0.5" y="0.5" width="39" height="39" rx={radius} fill={`url(#${gradId})`} />
      <rect
        x="1.25"
        y="1.25"
        width="37.5"
        height="37.5"
        rx={radius - 0.75}
        stroke="white"
        strokeOpacity="0.16"
        strokeWidth="1"
      />

      {/* 右下角轻地形等高弧线，平衡构图并呼应地图语境 */}
      <path
        d="M 21.5 32.2 C 26.2 31.2 30.4 27.6 32.2 22.8"
        stroke="white"
        strokeOpacity="0.22"
        strokeWidth="1.4"
        strokeLinecap="round"
      />

      {/* 起点光晕与实心圆点 */}
      <circle cx="11.5" cy="28.5" r="4.5" fill="white" fillOpacity="0.2" />
      <circle cx="11.5" cy="28.5" r="2.4" fill="white" />

      {/* 蜿蜒旅途路径 */}
      <path
        d="M 11.5 28.5 C 11.5 22.5 16.5 23.4 18.8 19.6 C 20.4 16.9 21.8 15.6 23.6 14.6"
        stroke="white"
        strokeWidth="2.8"
        strokeLinecap="round"
      />

      {/* 右上角四角罗盘星标（目的地 / Quest） */}
      <path
        d="M 28.5 6 Q 29.4 10.6 34 11.5 Q 29.4 12.4 28.5 17 Q 27.6 12.4 23 11.5 Q 27.6 10.6 28.5 6 Z"
        fill="#FAD293"
      />
    </svg>
  );
}
