import { dayMinutes } from "@tripquest/domain";
import { describe, expect, it } from "vitest";
import {
  FIRST_REQUEST,
  LAKE_REQUEST,
  LATE_REQUEST,
  TEA_REQUEST,
  decideDemoOffer,
  generateDemo,
  newDemoConversation,
  sendDemoMessage,
} from "../demo-conversation";
import { demoMapStops } from "../demo-schedule";

function planned(request = FIRST_REQUEST) {
  const first = sendDemoMessage(newDemoConversation(), request);
  return generateDemo(sendDemoMessage(first, "17:00 前到"));
}

describe("the public demo conversation", () => {
  it("asks for the arrival deadline and uses the reply in the plan", () => {
    const first = sendDemoMessage(newDemoConversation(), FIRST_REQUEST);
    expect(first.requirements.interests).toEqual(["food", "culture"]);
    expect(first.requirements.namedStops).toEqual([]);
    expect(first.messages.at(-1)?.text).toContain("最晚几点要到松风湖站");
    expect(generateDemo(first)).toBe(first);
    const result = generateDemo(sendDemoMessage(first, "下午五点前到"));
    expect(result.plan?.returnBy).toBe(dayMinutes("17:00"));
    expect(result.plan?.schedule.activities.map((activity) => activity.activityId)).toEqual(["market", "books", "museum"]);
    expect(result.plan?.schedule.endArrival).toBe(dayMinutes("15:21"));
  });

  it("selects a different route and walking order when only the interest changes", () => {
    const food = planned().plan!;
    const lake = planned(LAKE_REQUEST).plan!;
    expect(food.stops).toEqual(["market", "books"]);
    expect(lake.stops).toEqual(["books", "boardwalk"]);
    expect(lake.trials).toEqual(expect.arrayContaining([
      expect.objectContaining({ stops: ["boardwalk", "books"], result: expect.objectContaining({ status: "scheduled" }) }),
    ]));
    expect(lake.schedule.activities.at(-1)).toMatchObject({
      activityId: "museum", startsAt: dayMinutes("14:00"), endsAt: dayMinutes("15:00"),
    });
    expect(lake.returnBy).toBe(food.returnBy);
  });

  it("previews a preference change and preserves the appointment until adoption", () => {
    const original = planned();
    const revised = sendDemoMessage(original, "想沿湖散步，也想看看当地文化");
    expect(revised.plan).toBe(original.plan);
    expect(revised.offer?.next.stops).toEqual(["books", "boardwalk"]);
    expect(decideDemoOffer(revised, revised.offer!, true).plan?.interests).toEqual(["lake", "culture"]);
  });

  it("keeps the appointment and reports unfilled interests when a late start leaves no time", () => {
    const result = planned(FIRST_REQUEST.replace("10:45", "13:10"));
    expect(result.plan?.stops).toEqual([]);
    expect(result.plan?.schedule.activities.map(({ activityId }) => activityId)).toEqual(["museum"]);
    expect(result.messages.at(-1)?.text).toContain("当地小吃、人文体验暂缓");
  });

  it("keeps named stops as constraints alongside the independent selection path", () => {
    const result = planned("10:45 出发，想逛市集和书店，14:00 有博物馆导览");
    expect(result.plan?.namedStops).toEqual(["market", "books"]);
    expect(result.plan?.stops).toEqual(["market", "books"]);
  });

  it.each([
    ["10:45", "10:58"],
    ["11:00", "11:13"],
    ["11:15", "11:28"],
  ])("schedules from a user-edited start of %s and keeps the booking", (start, visit) => {
    const result = planned(FIRST_REQUEST.replace("10:45", start));
    const activities = result.plan?.schedule.activities;
    expect(activities?.[0].startsAt).toBe(dayMinutes(visit));
    expect(activities?.[2]).toMatchObject({ startsAt: dayMinutes("14:00"), endsAt: dayMinutes("15:00") });
  });

  it("replans from the reported location and compares real trial results before confirmation", () => {
    const initial = planned();
    const next = sendDemoMessage(initial, TEA_REQUEST);
    const offer = next.offer!;
    expect(next.plan).toBe(initial.plan);
    expect(next.report).toEqual({ completedStop: "market", resumeAt: dayMinutes("12:50") });
    expect(offer.next.schedule.legs[0]).toMatchObject({ fromPlaceId: "market", departsAt: dayMinutes("12:50") });
    expect(offer.next.schedule.activities.map((activity) => activity.activityId)).toEqual(["near-tea", "museum"]);
    expect(offer.next.schedule.activities[1]).toMatchObject({
      arrivesAt: dayMinutes("13:43"),
      startsAt: dayMinutes("14:00"),
      endsAt: dayMinutes("15:00"),
    });
    expect(offer.next.trials[1].result).toMatchObject({
      status: "not_scheduled",
      issues: [{ code: "day_fixed_late", actual: dayMinutes("14:07") }],
    });
    expect(demoMapStops(offer.next.schedule).map((stop) => stop.name)).toEqual([
      "松风市集", "临湖茶馆", "湖畔博物馆导览", "松风湖站",
    ]);
    const confirmed = decideDemoOffer(next, offer, true);
    expect(confirmed.plan?.version).toBe(2);
    expect(confirmed.report).toBe(next.report);
    expect(confirmed.offer).toBeNull();
    expect(decideDemoOffer(confirmed, offer, true)).toBe(confirmed);
  });

  it("uses the actual first stop when a different route is underway", () => {
    const initial = planned(LAKE_REQUEST);
    const otherLocation = sendDemoMessage(initial, "市集逛完了，现在 12:50 还在市集");
    expect(otherLocation.report).toBe(initial.report);
    expect(otherLocation.offer).toBeNull();
    const next = sendDemoMessage(initial, TEA_REQUEST);
    expect(next.report.completedStop).toBe("books");
    expect(next.offer?.next.schedule.legs[0].fromPlaceId).toBe("books");
    expect(next.offer?.next.stops).toEqual(["books", "near-tea"]);
  });

  it("keeps a change request across turns while asking for the time to leave the market", () => {
    const initial = sendDemoMessage(planned(), "书店换成茶馆，16:30 前到");
    expect(initial.messages.at(-1)?.text).toContain("市集已经逛完了吗");
    const observed = sendDemoMessage(initial, "市集逛完了");
    expect(observed.messages.at(-1)?.text).toContain("松风市集逛完了。你想几点继续");
    const resumed = sendDemoMessage(observed, "12:50");
    expect(resumed.offer?.next.stops).toEqual(["market", "near-tea"]);
    expect(resumed.offer?.next.returnBy).toBe(dayMinutes("16:30"));
    expect(resumed.offer?.next.schedule.legs[0].departsAt).toBe(dayMinutes("12:50"));
  });

  it("lets the visitor keep the original plan and preserves the completion report", () => {
    const original = planned();
    const state = sendDemoMessage(original, TEA_REQUEST);
    const dismissed = decideDemoOffer(state, state.offer!, false);
    expect(dismissed.plan).toBe(original.plan);
    expect(dismissed.report.completedStop).toBe("market");
    expect(dismissed.offer).toBeNull();
  });

  it("blocks an impossible late departure and invalidates the earlier offer", () => {
    const initial = sendDemoMessage(planned(), TEA_REQUEST);
    const tooLate = sendDemoMessage(initial, LATE_REQUEST);
    expect(tooLate.plan).toBe(initial.plan);
    expect(tooLate.report).toEqual({ completedStop: "market", resumeAt: dayMinutes("13:55") });
    expect(tooLate.offer).toBeNull();
    expect(tooLate.messages.at(-1)?.text).toContain("14:20");
    expect(decideDemoOffer(tooLate, initial.offer!, true)).toBe(tooLate);
  });

  it("retains the selected tea house and plan version after a rejected follow-up", () => {
    const state = sendDemoMessage(planned(), TEA_REQUEST);
    const confirmed = decideDemoOffer(state, state.offer!, true);
    const tooLate = sendDemoMessage(confirmed, LATE_REQUEST);
    expect(tooLate.plan).toBe(confirmed.plan);
    expect(tooLate.plan?.stops).toEqual(["market", "near-tea"]);
    expect(tooLate.offer).toBeNull();
  });

  it("keeps the current plan when the requested deadline is too early", () => {
    const original = planned();
    const updated = sendDemoMessage(original, "15:10 前到");
    expect(updated.plan).toBe(original.plan);
    expect(updated.offer).toBeNull();
    expect(updated.messages.at(-1)?.text).toContain("超过了你的截止时间");
  });

  it("does not infer unsupported changes, move the booking, or accept contradictory times", () => {
    const state = sendDemoMessage(newDemoConversation(), FIRST_REQUEST);
    const unsupported = sendDemoMessage(state, "11:15 出发，顺便去杭州");
    const movedBooking = sendDemoMessage(state, "下午三点有博物馆导览");
    const conflicting = sendDemoMessage(state, "11:00 出发，11:15 出发");
    const invalid = sendDemoMessage(state, "11:75 出发");
    for (const next of [unsupported, movedBooking, conflicting, invalid]) {
      expect(next.requirements).toBe(state.requirements);
    }
    expect(movedBooking.messages.at(-1)?.text).toContain("已预约在 14:00–15:00");
  });
});
