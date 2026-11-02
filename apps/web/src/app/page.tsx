import { CloudSun, Footprints, MessagesSquare, Route } from "lucide-react";
import { connection } from "next/server";
import type { JourneySummary } from "@tripquest/application";
import { DrizzleJourneyRepository, getSharedJourneyDatabase } from "@tripquest/db";
import { CityName } from "./_ui/city";
import { ByMode, ModeScope } from "./_ui/mode";
import { Reveal } from "./_ui/reveal";
import { HomePreview } from "./home-preview";
import { HomeStart } from "./home-start";
import { TripList } from "./trip-list";
import { pageUser } from "./auth/session";

export const runtime = "nodejs";

async function readTrips(userId: string): Promise<readonly JourneySummary[] | null> {
  try {
    return await new DrizzleJourneyRepository(getSharedJourneyDatabase().database, userId).listJourneys(12);
  } catch {
    return null;
  }
}

const POINTS = [
  { icon: MessagesSquare, title: "说一句话就行", text: "不用一个个选地点，想法、预约和兴趣直接说。" },
  { icon: Route, title: "走得通才给你", text: "每段路都向高德核对，近的步行、远的坐地铁或打车，固定预约不会迟到。" },
  { icon: CloudSun, title: "看天气安排", text: "下雨优先室内，推荐的每个地方都说明理由。" },
];

export default async function Home() {
  await connection();
  const user = await pageUser("/");
  const trips = await readTrips(user.id);
  return (
    <ModeScope className="min-h-dvh">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-[radial-gradient(60%_60%_at_20%_0%,var(--color-lake-100),transparent_70%),radial-gradient(40%_50%_at_90%_10%,var(--color-sun-50),transparent_70%)]"
      />
      <div className="relative mx-auto max-w-5xl px-4 sm:px-8">
        <header className="flex h-16 items-center justify-between">
          <span className="flex items-center gap-2.5">
            <span className="grid size-9 place-items-center rounded-xl bg-lake-600 text-xs font-bold text-white">TQ</span>
            <span className="font-semibold tracking-tight">TripQuest</span>
          </span>
          <span className="flex items-center gap-1">
            <a href="/preferences" className="rounded-full px-3 py-1.5 text-sm text-ink-soft hover:bg-sunken hover:text-ink">
              我的偏好
            </a>
            <a href="#trips" className="rounded-full px-3 py-1.5 text-sm text-ink-soft hover:bg-sunken hover:text-ink">
              我的行程
            </a>
            <a href="/account" className="rounded-full px-3 py-1.5 text-sm text-ink-soft hover:bg-sunken hover:text-ink">
              {user.displayUsername}
            </a>
          </span>
        </header>

        <section className="grid items-center gap-12 pb-16 pt-12 sm:pt-20 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div>
            <Reveal>
              <p className="inline-flex items-center gap-1.5 rounded-full bg-surface/80 px-3 py-1 text-sm text-lake-700 shadow-card">
                <Footprints className="size-3.5" />
                <ByMode daily={<><CityName /> · 一日行程助手</>} outing="出游 · 1–7 天，可以跨城市" />
              </p>
            </Reveal>
            <Reveal order={1}>
              <h1 className="mt-5 max-w-2xl text-[40px] font-semibold leading-[1.15] tracking-tight sm:text-6xl">
                说一句话，
                <br />
                <ByMode daily={<>排好<CityName />的一天</>} outing="排好几天的出游" />
              </h1>
            </Reveal>
            <Reveal order={2}>
              <p className="mt-5 max-w-xl text-base leading-8 text-ink-soft sm:text-lg">
                <ByMode
                  daily="告诉我时间、想去的地方和兴趣。我会搜索地点、按你的出行方式核对每段路线和天气，排出一天走得通的安排。"
                  outing="告诉我哪几天、去哪些城市、怎么去，想玩什么。我会把地点分到各天，按高铁、航班的时间一天天排好，每段路线都核对过。"
                />
              </p>
            </Reveal>
            <Reveal order={3} className="mt-8 max-w-2xl">
              <HomeStart />
            </Reveal>
          </div>
          <Reveal order={4} className="hidden lg:block">
            <HomePreview />
          </Reveal>
        </section>

        <section className="grid gap-3 pb-16 sm:grid-cols-3">
          {POINTS.map((point, index) => (
            <Reveal key={point.title} order={5 + index}>
              <div className="h-full rounded-(--radius-card) border border-line bg-surface/70 p-5">
                <point.icon className="size-5 text-lake-600" />
                <p className="mt-3 font-medium">{point.title}</p>
                <p className="mt-1 text-sm leading-6 text-ink-soft">{point.text}</p>
              </div>
            </Reveal>
          ))}
        </section>

        <section id="trips" className="scroll-mt-6 pb-20">
          <h2 className="mb-4 text-lg font-semibold">我的行程</h2>
          <TripList trips={trips} />
        </section>

        <footer className="border-t border-line py-6 text-xs text-ink-faint">
          TripQuest · 地点与路线来自高德地图，营业、票务与预约请出发前确认。
        </footer>
      </div>
    </ModeScope>
  );
}
