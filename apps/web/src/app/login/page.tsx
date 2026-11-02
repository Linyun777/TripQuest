import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { sessionUser } from "../auth/session";
import { AuthForm } from "./auth-form";
import { AuthShell } from "./auth-shell";

export const runtime = "nodejs";
export const metadata: Metadata = { title: "登录 · TripQuest" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next } = await searchParams;
  if (await sessionUser(await headers())) redirect("/");
  return (
    <AuthShell title="欢迎回来" note="用你的用户名和密码登录。忘了密码，请找发邀请码给你的人重置。">
      <AuthForm mode="login" {...(next ? { next } : {})} />
    </AuthShell>
  );
}
