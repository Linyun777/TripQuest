"use client";

import { startTransition, useEffect, useRef, useState } from "react";
import type { PlanningInterest } from "@tripquest/application";
import { searchPlanningPlaces } from "./actions";
import {
  INTEREST_LABELS,
  INTEREST_QUERIES,
  type PlacePurpose,
  type SearchReply,
  type SelectedPlace,
} from "./contracts";

export const secondaryButton =
  "min-h-11 rounded-2xl border border-[#b8cfc0] bg-white px-4 py-2 text-sm font-medium text-[#236d55] hover:bg-[#edf6ef] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#236d55] disabled:opacity-50";
export const primaryButton =
  "min-h-12 rounded-2xl bg-[#236d55] px-5 py-3 font-semibold text-white hover:bg-[#195740] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#236d55] disabled:opacity-50";

export function PlaceDescription({ item }: { item: SelectedPlace }) {
  const { place, evidence } = item.selection;
  return (
    <div className="min-w-0 break-words">
      <p className="font-semibold">{place.name}</p>
      <p className="mt-1 text-sm leading-6 text-[#52665c]">
        {place.address ?? "地址未提供"}
      </p>
      <p className="mt-1 text-xs leading-5 text-[#52665c]">
        {evidence.sourceKind === "fixture" ? "演示地点" : evidence.attribution}
      </p>
    </div>
  );
}

export function PlaceSearch({
  enabled,
  interests,
  onSelect,
}: {
  enabled: boolean;
  interests: PlanningInterest[];
  onSelect: (item: SelectedPlace, purpose: PlacePurpose) => string;
}) {
  const [query, setQuery] = useState("");
  const [purpose, setPurpose] = useState<PlacePurpose>("start");
  const [reply, setReply] = useState<SearchReply | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const sequence = useRef(0);
  useEffect(
    () => () => {
      sequence.current += 1;
    },
    [],
  );

  function invalidate() {
    sequence.current += 1;
    setReply(null);
    setBusy(false);
    setNotice("");
  }
  function search() {
    if (busy || !enabled || !query.trim()) return;
    const request = ++sequence.current;
    setBusy(true);
    setReply(null);
    setNotice("");
    startTransition(async () => {
      try {
        const result = await searchPlanningPlaces(query);
        if (request === sequence.current) setReply(result);
      } catch {
        if (request === sequence.current) {
          setReply({ status: "error", message: "搜索暂时失败，请手动重试" });
        }
      } finally {
        if (request === sequence.current) setBusy(false);
      }
    });
  }

  return (
    <section
      className="rounded-3xl border border-[#dce8e0] bg-white p-5 sm:p-6"
      aria-labelledby="search-heading"
    >
      <h2 id="search-heading" className="text-xl font-semibold">
        2. 想去哪里
      </h2>
      <p className="mt-2 text-sm leading-6 text-[#52665c]">
        搜索后明确选择用途。活动地点可以暂时不选，只填兴趣即可核对需求。
      </p>
      <div className="mt-5 space-y-4">
        <label className="block text-sm font-medium" htmlFor="search-purpose">
          这次选作
        </label>
        <select
          id="search-purpose"
          className="journey-input"
          value={purpose}
          onChange={(event) => {
            invalidate();
            setPurpose(event.target.value as PlacePurpose);
          }}
        >
          <option value="start">起点</option>
          <option value="end">终点</option>
          <option value="optional">可选活动</option>
          <option value="required">必去活动</option>
          <option value="fixed">固定事项</option>
        </select>
        <label className="block text-sm font-medium" htmlFor="place-query">
          杭州地点关键词
        </label>
        <input
          id="place-query"
          className="journey-input"
          value={query}
          maxLength={80}
          placeholder="输入地点名称，或使用下方兴趣词"
          onChange={(event) => {
            invalidate();
            setQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            // Inside the requirements form, Enter here must search instead of
            // submitting a review. Skip Enter that commits an IME composition.
            if (
              event.key !== "Enter" ||
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229
            ) {
              return;
            }
            event.preventDefault();
            search();
          }}
        />
        {interests.length > 0 && (
          <div className="flex flex-wrap gap-2" aria-label="兴趣搜索词">
            {interests.map((interest) => (
              <button
                key={interest}
                type="button"
                className={secondaryButton}
                onClick={() => {
                  invalidate();
                  setQuery(INTEREST_QUERIES[interest]);
                }}
              >
                {INTEREST_LABELS[interest]}：{INTEREST_QUERIES[interest]}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          className={primaryButton}
          disabled={!enabled || busy || !query.trim()}
          onClick={search}
        >
          {busy ? "正在搜索…" : "搜索地点"}
        </button>
      </div>
      <div className="mt-4 text-sm leading-6" role="status" aria-live="polite">
        {busy && <p>正在搜索杭州地点…</p>}
        {reply?.status === "error" && (
          <p className="text-[#8f392e]">{reply.message}</p>
        )}
        {reply?.status === "ok" && reply.items.length === 0 && (
          <p>没有找到地点，可以换个关键词。</p>
        )}
        {reply?.status === "ok" && reply.truncated && (
          <p>只展示部分结果，可改关键词缩小范围。</p>
        )}
        {notice && <p>{notice}</p>}
      </div>
      {reply?.status === "ok" && (
        <ul className="mt-4 space-y-3" aria-label="地点搜索结果">
          {reply.items.map((item) => (
            <li
              key={`${item.selection.place.ref.provider}/${item.selection.place.ref.externalId}`}
              className="rounded-2xl border border-[#dce8e0] p-4"
            >
              <PlaceDescription item={item} />
              <button
                type="button"
                className={`${secondaryButton} mt-3`}
                onClick={() => setNotice(onSelect(item, purpose))}
              >
                选择此地点
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
