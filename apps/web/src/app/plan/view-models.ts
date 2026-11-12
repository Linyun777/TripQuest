/**
 * What the chat page renders. Server code builds these from conversation rows plus live
 * lookups; nothing here is stored as-is (coordinates, routes and weather stay live, D-046).
 */

export type PlaceChoice = { readonly placeId: string; readonly name: string; readonly hint?: string };

export type CardPlace =
  | { readonly status: "bound"; readonly placeId: string; readonly name: string; readonly nearby?: boolean }
  | { readonly status: "choose"; readonly mention: string; readonly choices: readonly PlaceChoice[] }
  | { readonly status: "current" }
  | { readonly status: "missing" };

export type TravelModeView = "walking" | "transit" | "taxi" | "bicycling" | "driving";
export type TravelView = {
  readonly allowed: readonly TravelModeView[];
  readonly prefer: "balanced" | "fast" | "cheap" | "less_walking";
  /** True when the user has not said; the card shows it as a recommendation. */
  readonly recommended: boolean;
};

/** How one leg is travelled, for this render (live figures are never stored). */
export type LegView = {
  readonly mode: TravelModeView;
  /** null: unknown (or a plan read back from storage, where figures were never kept). */
  readonly minutes: number | null;
  readonly fareYuan?: number;
  readonly summary?: string;
  readonly samePlace?: boolean;
};

export type CardVisit = {
  readonly key: string;
  readonly place: CardPlace;
  readonly role: "optional" | "required" | "fixed";
  /** V2.11 出游：放在第几天。 */
  readonly day?: number;
  readonly stayMinutes?: number;
  /** V2.11：停留是估计的（不是用户说的），排不下时可以缩短。 */
  readonly estimated?: true;
  readonly startsAt?: string;
  readonly endsAt?: string;
};

export type WeatherChip = {
  readonly dayWeather: string;
  readonly highCelsius: number;
  readonly lowCelsius: number;
  readonly wet: boolean;
};

/** V2.11 出游卡片里日常没有的部分（stages/V2.11.md §3.3）。 */
export type OutingCardView = {
  /** V4.4：guessed 是日期是系统定的（用户没说哪天），卡片上写“暂定”。 */
  readonly dates: { readonly from: string; readonly to: string; readonly label: string; readonly days: number; readonly guessed?: true } | null;
  readonly startAt: string | null;
  readonly endAt: string | null;
  readonly dailyWindow: { readonly startsAt: string; readonly endsAt: string };
  /** 每一晚（第 1 晚到第“天数 − 1”晚）；没定的是 missing；suggested 是系统按高德结果暂定的（V3.3）。 */
  readonly lodging: readonly {
    readonly night: number;
    readonly place: CardPlace;
    readonly onBoard?: true;
    readonly suggested?: true;
    /** V3.6：暂定住处“换一个”的候选。 */
    readonly others?: readonly PlaceChoice[];
  }[];
  /** V3.3：只说了区域的住宿要求（“春熙路”），暂定住处在那一带找。 */
  readonly lodgingAreas?: readonly string[];
  /** V4.3：住在哪（“第 2–3 晚 松州”），从用户原话认出来的，可删。 */
  readonly stays?: readonly { readonly nights: readonly number[]; readonly text: string }[];
  readonly transports: readonly {
    readonly id: string;
    readonly day: number;
    readonly mode: "train" | "flight" | "other";
    readonly from: CardPlace;
    readonly to: CardPlace;
    readonly departAt: string | null;
    readonly arriveAt: string | null;
    /** 第二天到（夜车、红眼航班）；confirmed 是用户在卡片上确认过。 */
    readonly overnight: boolean;
    readonly confirmed: boolean;
    /**
     * V3.6：代码补的（ride 是这一趟是补的；from / to 是这一端的车站是暂定的，列的是“换一个”的候选）。
     * V4.3：day 是日子按住宿挪的。
     */
    readonly suggested?: { readonly ride?: true; readonly day?: true; readonly from?: readonly PlaceChoice[]; readonly to?: readonly PlaceChoice[] };
  }[];
  /**
   * V3.6：多城出游中间没有交通的段（“海澄到松州怎么去？”）；V4.3：给了时刻的车和住宿对不上（“第 3 天的车和第 3 晚住
   * 松州对不上”）。只提示，不挡住开始规划。
   */
  readonly rideHints?: readonly string[];
  /** 分到各天（§3.6）：每天去哪、为什么；problems 是代码检查发现的问题（移动之后可能有）。 */
  readonly allocation?: {
    readonly days: readonly {
      readonly day: number;
      readonly label: string;
      readonly items: readonly { readonly target: string; readonly name: string; readonly kind: "visit" | "interest" }[];
      readonly reason?: string;
    }[];
    readonly source: "model" | "rules";
    readonly problems: readonly string[];
  };
};

export type RequirementsCardView = {
  /** V2.4: "short" = going now, picking each place from a few options; no way back unless asked. V2.11: "outing" = 出游. */
  readonly mode: "day" | "short" | "outing";
  readonly outing?: OutingCardView;
  /** V2.10: the card's main city (default Hangzhou). */
  readonly city: string;
  readonly date: string | null;
  readonly dateLabel: string | null;
  /** V4.4：日期是系统定的（用户没说哪天），卡片上写“暂定”。 */
  readonly dateGuessed?: true;
  readonly window: { readonly startsAt: string; readonly endsAt: string } | null;
  readonly start: CardPlace;
  readonly end: CardPlace;
  readonly visits: readonly CardVisit[];
  /** V2.3: `when` (absent = any time) and `count` (absent = 1). */
  readonly interests: readonly {
    readonly id: string;
    readonly text: string;
    readonly when?: "morning" | "noon" | "afternoon" | "dusk" | "evening";
    readonly count?: number;
    /** V2.11 出游：第几天、每天都要、只在某个城市（城市名）。 */
    readonly day?: number;
    readonly perDay?: true;
    readonly city?: string;
  }[];
  readonly pace: "relaxed" | "standard";
  readonly notes: string | null;
  readonly travel: TravelView;
  readonly weather: WeatherChip | "unavailable" | null;
  /** Human-readable gaps that keep "开始规划" disabled. */
  readonly missing: readonly string[];
  /** Present on the latest card only: edits are based on this draft (stale edits are refused). */
  readonly fingerprint?: string;
};

export type ProgressStep = { readonly key: string; readonly text: string; readonly state: "done" | "active" };

export type PlanStop = {
  readonly key: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly name: string;
  readonly role: "optional" | "required" | "fixed" | "discovered";
  readonly reason?: string;
  readonly travelBefore: LegView | null;
  readonly waitMinutes: number;
  /** V2.3: free time after the previous stop, before setting off for this one (≥ 30 minutes). */
  readonly freeBefore?: number;
  /** V2.10: an outdoor stop on a day with rain, storms or strong wind (live plans only; never stored). */
  readonly alert?: string;
};

export type PlanCardView = {
  readonly runId: string;
  readonly title: string;
  readonly date: string;
  readonly startName: string;
  readonly endName: string;
  readonly departAt: string;
  readonly arriveAt: string;
  readonly travelBeforeEnd: LegView | null;
  /** Totals over the legs with known figures; null when the plan was read back. */
  readonly totals: { readonly travelMinutes: number; readonly fareYuan: number; readonly fareUnknown: boolean } | null;
  readonly stops: readonly PlanStop[];
  readonly notes: readonly string[];
  readonly pending: readonly string[];
  readonly saved: { readonly journeyId: string } | null;
  /** False for a plan read back from the conversation: walking figures were never stored. */
  readonly live: boolean;
};

/** V2.7 web page or V2.8 knowledge-base passage (by id; its text is fetched when opened). */
export type MessageSourceView =
  | { readonly kind: "web"; readonly url: string; readonly title: string; readonly site: string | null; readonly date: string | null }
  | { readonly kind: "kb"; readonly documentId: string; readonly chunkId: string; readonly title: string; readonly headingPath: string };

/** V2.8: an opened knowledge-base citation, with where the article's facts came from. */
export interface KnowledgePassageView {
  readonly chunkId: string;
  readonly title: string;
  readonly headingPath: string;
  readonly text: string;
  readonly sources: readonly { readonly url: string; readonly note: string; readonly accessed: string }[];
}

export type ChatMessageView =
  | { readonly id: string; readonly role: "user"; readonly kind: "text"; readonly text: string }
  | {
      readonly id: string;
      readonly role: "assistant";
      readonly kind: "text";
      readonly text: string;
      readonly asking?: boolean;
      /** V2.7: the web pages the answer cites; V2.8: or passages of our knowledge base. */
      readonly sources?: readonly MessageSourceView[];
      /** V2.9：建议里推荐的地点（编号和名称）。 */
      readonly places?: readonly { readonly externalId: string; readonly name: string; readonly city?: string }[];
    }
  | {
      readonly id: string;
      readonly role: "assistant";
      readonly kind: "requirements_card";
      readonly card: RequirementsCardView;
      /** Only the newest card is live and editable; older ones are history. */
      readonly latest: boolean;
    }
  | { readonly id: string; readonly role: "assistant"; readonly kind: "planning_progress"; readonly steps: readonly ProgressStep[]; readonly running: boolean }
  | { readonly id: string; readonly role: "assistant"; readonly kind: "plan_card"; readonly plan: PlanCardView }
  | {
      readonly id: string;
      readonly role: "assistant";
      readonly kind: "notice";
      readonly text: string;
      readonly tone: "info" | "warning";
      /** V2.11：提示里带“切到出游”（日常遇到外地时）。 */
      readonly outing?: true;
    }
  | PreferenceProposalView
  | ChoicesView
  | AdjustCardView
  | OutingDayView
  | OutingChangeView
  | OutingReviewView;

/** V3.2 审查的建议：每条一句话和理由，采纳后走改动流程（确认才保存），忽略就不再提示。 */
export type OutingReviewView = {
  readonly id: string;
  readonly role: "assistant";
  readonly kind: "outing_review";
  /** 这次生成最新的那张才能操作。 */
  readonly open: boolean;
  /** V4.7：“这趟符合你的要求吗”。 */
  readonly assessment?: {
    readonly summary: string;
    readonly items: readonly { readonly text: string; readonly status: "met" | "partly" | "unmet" | "unknown"; readonly note: string }[];
    readonly issues: readonly { readonly day: number; readonly severity: "minor" | "major"; readonly note: string }[];
  };
  readonly suggestions: readonly {
    readonly index: number;
    readonly text: string;
    readonly reason: string;
    readonly status: "pending" | "adopted" | "dismissed";
    /** V4.0：试排的结果（“已试排：第 3 天……”）。 */
    readonly tried?: string;
    /** V3.3 换住处：那家住处（只有名称和城市），页面给高德和点评平台的链接看评价。 */
    readonly place?: { readonly name: string; readonly city?: string };
  }[];
};

/** V2.11 跨天改动：受影响的天原来去哪、改成什么；确认后才保存。 */
export type OutingChangeView = {
  readonly id: string;
  readonly role: "assistant";
  readonly kind: "outing_change";
  readonly changeId: string;
  readonly note: string;
  readonly before: readonly { readonly day: number; readonly stops: readonly string[] }[];
  readonly days: readonly OutingDayView[];
  readonly saved: boolean;
  /** 本次页面里刚生成、还没确认的最新一张才能确认（保存凭据只在这次页面里）。 */
  readonly open: boolean;
};

/** V2.11 出游的一天：按固定交通分成几部分，每段地点是一张一日方案。 */
export type OutingDayPartView =
  | { readonly kind: "plan"; readonly plan: PlanCardView }
  | {
      readonly kind: "transfer";
      readonly mode: "train" | "flight" | "other";
      readonly from: string;
      readonly to: string;
      readonly departAt: string;
      readonly arriveAt: string;
      readonly nextDay: boolean;
      readonly estimated: boolean;
    }
  | { readonly kind: "connect"; readonly from: string; readonly to: string; readonly departAt: string; readonly arriveAt: string };
export type OutingDayView = {
  readonly id: string;
  readonly role: "assistant";
  readonly kind: "outing_day";
  readonly generationId: string;
  readonly day: number;
  readonly date: string;
  readonly title: string;
  readonly status: "draft" | "no_plan" | "failed";
  readonly parts: readonly OutingDayPartView[];
  readonly notes: readonly string[];
  readonly explanation?: string;
  readonly tripId: string | null;
};

/** V2.5: a proposed change to the saved trip; the old remainder beside the new one. */
export type AdjustCardView = {
  readonly id: string;
  readonly role: "assistant";
  readonly kind: "adjust_card";
  readonly runId: string;
  readonly journeyId: string;
  readonly basePlanVersion: number;
  readonly note: string;
  readonly items: readonly {
    readonly kind: "done" | "kept" | "moved" | "added" | "removed";
    readonly name: string;
    readonly before?: { readonly startsAt: string; readonly endsAt: string };
    readonly after?: { readonly startsAt: string; readonly endsAt: string };
  }[];
  readonly suggestDrop: string | null;
  readonly arriveAt: string;
  readonly endName: string;
  readonly savedVersion: number | null;
  /** Only the newest unsaved card can still be confirmed. */
  readonly open: boolean;
};

/** V2.4: one candidate; distance and route are this response's, rating and price Amap's, never stored. */
export type ChoiceOptionView = {
  readonly externalId: string;
  readonly name: string;
  readonly reason: string;
  /** Straight-line meters from the anchor (the start or the stop chosen before). */
  readonly meters?: number;
  readonly travel?: LegView;
  readonly rating?: number;
  readonly costYuan?: number;
  readonly keytag?: string;
  readonly openToday?: string;
};

/** V2.4: one step of a short trip ("选一家偏辣的", then "附近的瑞幸"). */
export type ChoicesView = {
  readonly id: string;
  readonly role: "assistant";
  readonly kind: "choices";
  readonly tripId: string;
  readonly step: number;
  readonly total: number;
  readonly interest: string;
  /** "你的位置" for the first step, else the stop chosen before. */
  readonly anchorName: string;
  readonly round: number;
  readonly options: readonly ChoiceOptionView[];
  readonly chosen: string | null;
  /** Only the trip's newest, unanswered step takes a pick or "换一批". */
  readonly open: boolean;
  /** "换一批" is left (three rounds per step). */
  readonly canRefresh: boolean;
};

/** A point on the plan map, in order; coordinates are live and only held in memory. */
export type MapStop = {
  readonly key: string;
  readonly label: string;
  readonly name: string;
  readonly kind: "start" | "stop" | "end";
  readonly longitude: number;
  readonly latitude: number;
};

/** A leg's real route line for the map, by mode; in memory only (D-046). */
export type MapPath = { readonly mode: TravelModeView; readonly points: readonly (readonly [number, number])[] };

/** V2.3: gaps of half an hour or more read as free time (the planner leaves late on purpose). */
export function freeTime(minutes: number): { freeBefore?: number } {
  return minutes >= 30 ? { freeBefore: minutes } : {};
}

/** V2.7.2 "出发须知": per stop, short sourced notes and (from code) a closing-day warning. */
export interface TripNotesView {
  readonly date: string;
  readonly stops: readonly {
    /** The plan's place ID (a plan card) or activity ID (a saved trip). */
    readonly id: string;
    readonly name: string;
    /** Looked up: scenic, culture and theatre stops (the first five). */
    readonly checked: boolean;
    readonly notes: readonly {
      readonly kind: "reserve" | "ticket" | "hours" | "other";
      readonly text: string;
      readonly stale: boolean;
      readonly sources: readonly { readonly url: string; readonly title: string; readonly site: string | null; readonly date: string | null }[];
    }[];
    readonly warning: string | null;
  }[];
}

/** V2.9：“要记住吗？”卡片；用户点“记住”才保存进“我的偏好”。 */
export interface PreferenceProposalView {
  readonly id: string;
  readonly role: "assistant";
  readonly kind: "preference_proposal";
  readonly text: string;
  readonly category: "food" | "pace" | "travel" | "interest" | "other";
  readonly status: "pending" | "saved" | "dismissed";
}

/** V2.9：“我的偏好”页的一条。 */
export interface PreferenceView {
  readonly id: string;
  readonly text: string;
  readonly category: "food" | "pace" | "travel" | "interest" | "other";
  readonly fromConversation: boolean;
  readonly createdAt: string;
}
