import { CalendarDays, ChevronRight } from "lucide-react";
import Link from "next/link";
import { connection } from "next/server";
import type { JourneySummary } from "@tripquest/application";
import { DrizzleJourneyRepository, getSharedJourneyDatabase } from "@tripquest/db";
import { AppShell } from "./_ui/app-shell";
import { CityName } from "./_ui/city";
import { ByMode, ModeScope } from "./_ui/mode";
import { pageUser } from "./auth/session";
import { HomePreview } from "./home-preview";
import { HomeStart } from "./home-start";

export const runtime = "nodejs";

async function readRecentTrips(userId: string): Promise<readonly JourneySummary[] | null> {
  try {
    return await new DrizzleJourneyRepository(
      getSharedJourneyDatabase().database,
      userId,
    ).listJourneys(12);
  } catch {
    return null;
  }
}

function summarizeTrips(trips: readonly JourneySummary[]) {
  const seenOutings = new Set<string>();
  const items: { id: string; title: string; date: string; href: string; isOuting: boolean }[] = [];
  for (const trip of trips) {
    if (trip.trip) {
      if (seenOutings.has(trip.trip.id)) continue;
      seenOutings.add(trip.trip.id);
      items.push({
        id: trip.trip.id,
        title: trip.trip.title,
        date: `${trip.trip.firstDate} 起`,
        href: "/trips",
        isOuting: true,
      });
    } else {
      items.push({
        id: trip.id,
        title: trip.title,
        date: trip.date,
        href: `/journeys/${trip.id}`,
        isOuting: false,
      });
    }
  }
  return items;
}

export default async function Home() {
  await connection();
  const user = await pageUser("/");
  const trips = await readRecentTrips(user.id);
  const recent = trips ? summarizeTrips(trips) : [];

  return (
    <ModeScope>
      <AppShell active="plan" user={user} ambient={false}>
        <main className="mx-auto max-w-5xl px-4 pt-6 sm:px-8 md:pt-14">
          <section className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_356px] lg:gap-14">
            <div className="min-w-0">
              <h1 className="max-w-xl text-[32px] font-semibold leading-[1.18] text-ink sm:text-5xl">
                说一句话，
                <br />
                <ByMode
                  daily={
                    <>
                      排好<CityName />的一天
                    </>
                  }
                  outing="排好几天的出游"
                />
              </h1>

              <p className="mt-3 max-w-lg text-sm leading-6 text-ink-soft sm:mt-4 sm:text-base sm:leading-7">
                <ByMode
                  daily="告诉我出发时间、固定预约和想逛的方向，每段路线与天气实时核对，走得通才给你。"
                  outing="告诉我日期、城市、高铁或航班与想玩的内容，按天分配并逐段核对交通与住处。"
                />
              </p>

              <div className="mt-6 max-w-2xl sm:mt-8">
                <HomeStart />
              </div>

              {/* 精简最近行程快捷条：不再把长列表堆在首页，一键切到 /trips */}
              {recent.length > 0 && (
                <div className="mt-6 max-w-2xl sm:mt-8">
                  <div className="flex items-center justify-between px-1 pb-2">
                    <span className="text-xs font-medium text-ink-soft">最近保存</span>
                    <Link
                      href="/trips"
                      className="inline-flex items-center gap-0.5 text-xs font-medium text-lake-700 hover:underline"
                    >
                      <span>全部 {recent.length} 个行程</span>
                      <ChevronRight className="size-3.5" />
                    </Link>
                  </div>
                  <div className="glass-card divide-y divide-ink/[0.06] overflow-hidden rounded-[22px]">
                    {recent.slice(0, 2).map((item) => (
                      <Link
                        key={item.id}
                        href={item.href}
                        className="group flex items-center gap-3 px-4 py-3 transition-colors hover:bg-white/55 active:bg-white/75"
                      >
                        <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-lake-50 text-lake-600">
                          <CalendarDays className="size-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-ink">
                            {item.title}
                          </span>
                          <span className="tabular block text-xs text-ink-faint">
                            {item.date} · {item.isOuting ? "多日出游" : "一日行程"}
                          </span>
                        </span>
                        <ChevronRight className="size-4 shrink-0 text-ink-faint transition-transform duration-150 group-hover:translate-x-0.5" />
                      </Link>
                    ))}
                  </div>
                </div>
              )}

              <p className="mt-6 text-xs text-ink-faint">
                地点与路线来自高德地图，营业、票务与预约请出发前确认。
              </p>
            </div>

            <div className="hidden lg:block">
              <HomePreview />
            </div>
          </section>
        </main>
      </AppShell>
    </ModeScope>
  );
}
