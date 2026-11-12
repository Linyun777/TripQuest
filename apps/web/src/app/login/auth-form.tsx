"use client";

import { ArrowRight, CircleAlert, Eye, EyeOff, LoaderCircle, LockKeyhole, Ticket, UserRound, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { useState, type ComponentProps, type FormEvent } from "react";
import { Button } from "../_ui/button";
import { cn } from "../_ui/cn";

/**
 * V2.12 登录和注册（stages/V2.12.md §3.2、§3.3）。登录走 Better Auth 的 /api/auth/sign-in/username，注册走我们的
 * /api/register（邀请码）。登录失败统一说“用户名或密码不对”，邀请码不对统一说“邀请码不可用”。
 */
const REGISTER_ERRORS: Record<string, string> = {
  invite_unavailable: "邀请码不可用。",
  username_taken: "这个用户名已经有人用了，换一个。",
  invalid_username: "用户名 2–24 个字，只能用汉字、字母、数字、下划线和点。",
  invalid_password: "密码至少 8 位。",
};

/** 登录后回到原来的页面；只接受站内路径，防止被带去别的网站。 */
function safeNext(next: string | undefined): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/";
}

/** 带图标的输入框；密码框右边可以切换显示。 */
function Field({ label, icon: Icon, type = "text", ...props }: { label: string; icon: LucideIcon } & ComponentProps<"input">) {
  const [shown, setShown] = useState(false);
  const secret = type === "password";
  return (
    <label className="grid gap-1.5 text-sm">
      <span className="font-medium text-ink-soft">{label}</span>
      <span
        className={cn(
          "group flex h-12 items-center gap-2.5 rounded-(--radius-field) border border-line bg-paper/70 px-3.5",
          "transition-[border-color,background-color,box-shadow] duration-150 ease-(--ease-out-soft)",
          "focus-within:border-lake-500 focus-within:bg-surface focus-within:ring-4 focus-within:ring-lake-100",
        )}
      >
        <Icon className="size-4 shrink-0 text-ink-faint transition-colors duration-150 group-focus-within:text-lake-600" />
        <input
          {...props}
          type={secret && shown ? "text" : type}
          className="h-full min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-ink-faint sm:text-[15px]"
        />
        {secret && (
          <button
            type="button"
            onClick={() => setShown((value) => !value)}
            aria-label={shown ? "隐藏密码" : "显示密码"}
            className="-mr-1.5 grid size-8 shrink-0 place-items-center rounded-full text-ink-faint transition-[color,transform] duration-150 hover:text-ink active:scale-95"
          >
            {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        )}
      </span>
    </label>
  );
}

export function AuthForm({ mode, next }: { mode: "login" | "register"; next?: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    const username = String(form.get("username") ?? "").trim();
    const password = String(form.get("password") ?? "");
    if (mode === "register" && password !== String(form.get("confirm") ?? "")) {
      setError("两次输入的密码不一样。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = mode === "login"
        ? await fetch("/api/auth/sign-in/username", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username, password }),
        })
        : await fetch("/api/register", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ inviteCode: String(form.get("invite") ?? ""), username, password }),
        });
      if (response.ok) {
        window.location.assign(safeNext(next));
        return;
      }
      if (mode === "login") {
        // 403 不都是停用：访问地址和网站配置的地址对不上时（换了域名、用局域网地址打开）库也回 403（INVALID_ORIGIN）。
        const code = response.status === 403 ? ((await response.json().catch(() => null)) as { code?: string } | null)?.code : undefined;
        setError(response.status === 429 ? "试得太频繁了，过一分钟再试。"
          : code === "BANNED_USER" ? "这个账号已停用。"
            : response.status === 403 ? "登录请求被拒绝了，请用网站的正式地址打开页面再试。"
              : "用户名或密码不对。");
      } else {
        const status = ((await response.json().catch(() => null)) as { status?: string } | null)?.status ?? "";
        setError(REGISTER_ERRORS[status] ?? "现在注册不了，请稍后再试。");
      }
    } catch {
      setError("连不上服务，请稍后再试。");
    }
    setBusy(false);
  }

  return (
    <form onSubmit={submit} className="mt-7 grid gap-4" noValidate>
      {mode === "register" && (
        <Field label="邀请码" icon={Ticket} name="invite" required autoComplete="off" autoCapitalize="characters" spellCheck={false} placeholder="XXXX-XXXX-XXXX" />
      )}
      <Field
        label="用户名"
        icon={UserRound}
        name="username"
        required
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        placeholder={mode === "register" ? "汉字、字母或数字，2–24 个字" : undefined}
      />
      <Field
        label="密码"
        icon={LockKeyhole}
        name="password"
        type="password"
        required
        autoComplete={mode === "login" ? "current-password" : "new-password"}
        placeholder={mode === "register" ? "至少 8 位" : undefined}
      />
      {mode === "register" && (
        <Field label="再输一次密码" icon={LockKeyhole} name="confirm" type="password" required autoComplete="new-password" />
      )}
      {error && (
        <p role="alert" className="flex items-start gap-2 rounded-xl bg-danger-50 px-3 py-2.5 text-sm leading-5 text-danger-600">
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          {error}
        </p>
      )}
      <Button type="submit" size="lg" disabled={busy} className="mt-2 w-full">
        {busy ? <LoaderCircle className="animate-spin" /> : null}
        {mode === "login" ? "登录" : "注册并登录"}
        {busy ? null : <ArrowRight />}
      </Button>
      <p className="text-center text-sm text-ink-soft">
        {mode === "login"
          ? <>收到邀请码了？<Link href="/register" className="font-medium text-lake-700 underline-offset-4 hover:underline">注册</Link></>
          : <>已有账号？<Link href="/login" className="font-medium text-lake-700 underline-offset-4 hover:underline">登录</Link></>}
      </p>
    </form>
  );
}
