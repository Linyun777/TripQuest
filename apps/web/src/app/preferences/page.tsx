import type { Metadata } from "next";
import { connection } from "next/server";
import { AppShell } from "../_ui/app-shell";
import { createPreferencesService } from "../plan/preferences-service";
import type { PreferenceView } from "../plan/view-models";
import { PreferencesEditor } from "./preferences-editor";
import { pageUser } from "../auth/session";

export const runtime = "nodejs";
export const metadata: Metadata = { title: "我的偏好 · TripQuest" };

async function readPreferences(userId: string): Promise<PreferenceView[] | null> {
  try {
    return await createPreferencesService({ userId }).list();
  } catch {
    return null;
  }
}

/** V2.9：长期偏好的查看、修改与删除。 */
export default async function PreferencesPage() {
  await connection();
  const user = await pageUser("/preferences");
  const preferences = await readPreferences(user.id);
  return (
    <div className="min-h-dvh bg-paper">
      <AppShell active="preferences" user={user} maxWidth="max-w-3xl">
        <main className="mx-auto max-w-3xl px-4 pt-6 sm:px-8 md:pt-8">
          <h1 className="text-2xl font-semibold text-ink sm:text-3xl">我的偏好</h1>
          <p className="mt-1.5 text-sm leading-6 text-ink-soft">
            对话里说过、你点了“记住”的长期偏好。规划和建议会参考它们，但你当次说的话优先，也不会因此去掉必去的地方。
          </p>
          {preferences === null ? (
            <p className="mt-8 text-sm text-sun-700">现在读不到偏好，请稍后刷新。</p>
          ) : (
            <PreferencesEditor initial={preferences} />
          )}
          <p className="mt-10 text-xs leading-5 text-ink-faint">
            删除是永久的，不能恢复。对话里当初说过的原话不会随之删除，删除对话时才会一起删除。最多记 30 条。
          </p>
        </main>
      </AppShell>
    </div>
  );
}
