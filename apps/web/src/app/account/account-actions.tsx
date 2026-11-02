"use client";

import { LoaderCircle, LogOut } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Button } from "../_ui/button";

const input = "h-11 w-full rounded-xl border border-line bg-surface px-3.5 text-[15px] outline-none focus:border-lake-600 focus:ring-2 focus:ring-lake-100";

async function post(url: string, body: unknown, method = "POST"): Promise<{ ok: boolean; status: number; code: string }> {
  try {
    const response = await fetch(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = (await response.json().catch(() => null)) as { status?: string; code?: string } | null;
    return { ok: response.ok, status: response.status, code: json?.status ?? json?.code ?? "" };
  } catch {
    return { ok: false, status: 0, code: "unavailable" };
  }
}

/** 退出登录（这台设备）。 */
export function SignOutButton() {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      variant="secondary"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        await post("/api/auth/sign-out", {});
        // 整页跳转：不留登录时的页面缓存，退回也回不到账号页。
        window.location.replace("/login");
      }}
    >
      {busy ? <LoaderCircle className="animate-spin" /> : <LogOut />}
      退出登录
    </Button>
  );
}

/** 改密码：要输入旧密码；改完其他设备退出（这台保持登录）。 */
export function ChangePasswordForm() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const newPassword = String(form.get("new") ?? "");
    if (newPassword !== String(form.get("confirm") ?? "")) return setMessage({ tone: "error", text: "两次输入的新密码不一样。" });
    if (newPassword.length < 8) return setMessage({ tone: "error", text: "新密码至少 8 位。" });
    setBusy(true);
    const result = await post("/api/auth/change-password", {
      currentPassword: String(form.get("current") ?? ""),
      newPassword,
      revokeOtherSessions: true,
    });
    setBusy(false);
    if (result.ok) {
      formElement.reset();
      setMessage({ tone: "ok", text: "密码已改好，其他设备已退出。" });
    } else {
      setMessage({ tone: "error", text: result.status === 429 ? "试得太频繁了，过一分钟再试。" : "旧密码不对，或者现在改不了。" });
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3" noValidate>
      <input name="current" type="password" autoComplete="current-password" placeholder="旧密码" className={input} />
      <input name="new" type="password" autoComplete="new-password" placeholder="新密码（至少 8 位）" className={input} />
      <input name="confirm" type="password" autoComplete="new-password" placeholder="再输一次新密码" className={input} />
      {message && <p role={message.tone === "error" ? "alert" : "status"} className={message.tone === "error" ? "text-sm text-sun-700" : "text-sm text-lake-700"}>{message.text}</p>}
      <Button type="submit" variant="secondary" disabled={busy} className="justify-self-start">
        {busy && <LoaderCircle className="animate-spin" />}
        改密码
      </Button>
    </form>
  );
}

/** 删除我的全部数据：输入密码再确认一次；删完退出。 */
export function DeleteAccountForm() {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!confirming) return setConfirming(true);
    setBusy(true);
    const result = await post("/api/account", { password: String(new FormData(event.currentTarget).get("password") ?? "") }, "DELETE");
    if (result.ok) {
      // 整页跳转：不留登录时的页面缓存，退回也回不到账号页。
      window.location.replace("/login");
      return;
    }
    setBusy(false);
    setError(result.code === "wrong_password" ? "密码不对。" : "现在删不了，请稍后再试。");
  }

  return (
    <form onSubmit={submit} className="grid gap-3" noValidate>
      <input name="password" type="password" autoComplete="current-password" placeholder="输入密码确认" className={input} />
      {confirming && <p className="text-sm text-sun-700">会删掉你的账号和全部对话、行程、出游、偏好、用量记录，不能恢复。再点一次确认。</p>}
      {error && <p role="alert" className="text-sm text-sun-700">{error}</p>}
      <Button type="submit" variant="accent" disabled={busy} className="justify-self-start">
        {busy && <LoaderCircle className="animate-spin" />}
        {confirming ? "确认删除全部数据" : "删除我的全部数据"}
      </Button>
    </form>
  );
}
