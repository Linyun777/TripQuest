import type { Metadata } from "next";
import { MotionProvider } from "./_ui/motion";
import "./globals.css";

export const metadata: Metadata = {
  title: "TripQuest · 一日行程",
  description: "TripQuest 旅行助手：创建并查看一日行程。",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <MotionProvider>{children}</MotionProvider>
      </body>
    </html>
  );
}
