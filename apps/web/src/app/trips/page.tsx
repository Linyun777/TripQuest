import { Plus } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import type { JourneySummary } from "@tripquest/application";
import { DrizzleJourneyRepository, getSharedJourneyDatabase } from "@tripquest/db";
import { AppShell } from "../_ui/app-shell";
import { pageUser } from "../auth/session";
import { TripsView } from "./trips-view";

export const runtime = "nodejs";
export const metadata: Metadata = { title: "我的行程 · TripQuest" };

async function readTrips(userId: string): Promise<readonly JourneySummary[] | null> {
  try {
    return await new DrizzleJourneyRepository(
      getSharedJourneyDatabase().database,
      userId,
    ).listJourneys(40);
  } catch {
    return null;
  }
}

export default async function TripsPage() {
  await connection();
  const user = await pageUser("/trips");
  const trips = await readTrips(user.id);

  return (
    <div className="min-h-dvh bg-paper">
      <AppShell
        active="trips"
        user={user}
        maxWidth="max-w-3xl"
        mobileHeaderRight={
          <Link
            href="/"
            className="morandi-cta inline-flex h-8 items-center gap-1 rounded-full px-3 text-xs font-medium text-white active:scale-[0.95]"
          >
            <Plus className="size-3.5" />
            <span>新规划</span>
          </Link>
        }
      >
        <main className="mx-auto max-w-3xl px-4 pt-6 sm:px-8 md:pt-8">
          <div className="flex items-end justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold text-ink sm:text-3xl">我的行程</h1>
              <p className="mt-1 text-sm text-ink-soft">
                已确认保存的一日与多日行程，可随时查看时间线或在旅途中调整。
              </p>
            </div>
            <Link
              href="/"
              className="morandi-cta hidden h-9 shrink-0 items-center gap-1.5 rounded-full px-4 text-sm font-medium text-white transition-transform duration-150 active:scale-[0.96] md:inline-flex"
            >
              <Plus className="size-4" />
              <span>新建规划</span>
            </Link>
          </div>

          <div className="mt-6">
            <TripsView trips={trips} />
          </div>
        </main>
      </AppShell>
    </div>
  );
}
