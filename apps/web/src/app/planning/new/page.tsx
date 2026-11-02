import Link from "next/link";
import { connection } from "next/server";
import { readGenerationConfig } from "./generation-config";
import { readPlanningConfig } from "./planning-config";
import { RequirementsForm } from "./requirements-form";
import { ResumedDraftTask } from "./day-draft";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const runtime = "nodejs";

export default async function NewPlanningPage({
  searchParams,
}: {
  searchParams: Promise<{ task?: string }>;
}) {
  await connection();
  const { task } = await searchParams;
  return (
    <main className="min-h-dvh bg-[#f7f9f7] px-4 py-6 text-[#21352e] sm:px-6 sm:py-10">
      <div className="mx-auto max-w-3xl">
        <Link
          href="/"
          className="inline-flex min-h-11 items-center text-sm font-medium text-[#236d55]"
        >
          ← TripQuest 首页
        </Link>
        <header className="mb-7 mt-4">
          <p className="text-sm font-medium text-[#236d55]">
            从想法开始，一步步安排
          </p>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight">
            规划一天
          </h1>
          <p className="mt-3 text-sm leading-7 text-[#52665c]">
            先告诉我们时间、起终点和兴趣。你不需要提前排好一天的活动。
          </p>
          <p className="mt-3 text-sm leading-6 text-[#52665c]">
            核对需求后生成一日安排，满意再保存。离开或刷新页面会清空尚未保存的填写。
          </p>
        </header>
        {task && UUID.test(task) && <ResumedDraftTask taskId={task} />}
        <RequirementsForm
          availability={readPlanningConfig().availability}
          generation={readGenerationConfig().availability}
        />
      </div>
    </main>
  );
}
