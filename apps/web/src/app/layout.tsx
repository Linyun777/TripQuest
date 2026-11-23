import type { Metadata, Viewport } from "next";
import { MotionProvider } from "./_ui/motion";
import "./globals.css";

export const metadata: Metadata = {
  title: "TripQuest · 旅行规划助手",
  description: "说一句话，排好一天或几天的行程。每段路线与天气均实时核对。",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "TripQuest",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: "#eeece8",
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
