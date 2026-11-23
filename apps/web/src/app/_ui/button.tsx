import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./cn";

export const buttonVariants = cva(
  [
    "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap font-medium",
    "transition-[background-color,box-shadow,transform,color] duration-150 ease-(--ease-out-soft)",
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-lake-600",
    "active:scale-[0.96] disabled:pointer-events-none disabled:opacity-45",
    "[&_svg]:size-4 [&_svg]:shrink-0",
  ],
  {
    variants: {
      variant: {
        primary: "morandi-cta text-white",
        secondary: "glass-pill text-ink hover:bg-surface/85",
        ghost: "text-ink-soft hover:bg-ink/[0.05] hover:text-ink",
        accent: "bg-sun-500 text-white shadow-card hover:bg-sun-700",
      },
      size: {
        sm: "h-9 rounded-full px-4 text-sm",
        md: "h-11 rounded-full px-5 text-[15px]",
        lg: "h-12 rounded-full px-7 text-base",
        icon: "size-10 rounded-full",
      },
    },
    defaultVariants: { variant: "primary", size: "md" },
  },
);

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Component = asChild ? Slot : "button";
  return <Component className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}
