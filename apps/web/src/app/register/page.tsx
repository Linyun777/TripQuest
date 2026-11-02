import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { sessionUser } from "../auth/session";
import { AuthForm } from "../login/auth-form";
import { AuthShell } from "../login/auth-shell";

export const runtime = "nodejs";
export const metadata: Metadata = { title: "注册 · TripQuest" };

export default async function RegisterPage() {
  if (await sessionUser(await headers())) redirect("/");
  return (
    <AuthShell title="加入 TripQuest" note="用收到的邀请码注册。用户名和密码就是之后登录用的，不需要邮箱或手机号。">
      <AuthForm mode="register" />
    </AuthShell>
  );
}
