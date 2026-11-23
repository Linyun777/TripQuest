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
      <p className="mb-4 text-sm text-ink-soft">为了解规划是否正常、统计 API 用量，站长可查看任务阶段、耗时和调用费用。该视图不展示聊天内容和位置。</p>
      <AuthForm mode="register" />
    </AuthShell>
  );
}
