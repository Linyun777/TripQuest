import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  json,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

const timestampWithTimeZone = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "date", precision: 0 });

/**
 * V2.12 账号（stages/V2.12.md §3.1）：users、sessions、accounts、verifications、rate_limits 是 Better Auth 的表，
 * 字段名按它的模型（属性名），表名和列名是我们的风格。id 是 uuid（库按 gen_random_uuid 生成）。
 * 邮箱是注册时填的不对外占位地址（<uuid>@users.invalid），页面不显示。拥有者账号由迁移 0014 创建。
 */
export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    createdAt: timestampWithTimeZone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimeZone("updated_at").notNull().defaultNow(),
    /** 用户名插件：小写去重的用户名和原样的显示名。 */
    username: text("username"),
    displayUsername: text("display_username"),
    /** 管理员插件：角色和停用。 */
    role: text("role"),
    banned: boolean("banned").default(false),
    banReason: text("ban_reason"),
    banExpires: timestampWithTimeZone("ban_expires"),
  },
  (table) => [
    unique("users_email_unique").on(table.email),
    unique("users_username_unique").on(table.username),
  ],
);

export const sessions = pgTable(
  "sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    expiresAt: timestampWithTimeZone("expires_at").notNull(),
    token: text("token").notNull(),
    createdAt: timestampWithTimeZone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimeZone("updated_at").notNull(),
    /** 登录限流按来源地址计，会话里也记着；随账号一起删除。 */
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
  },
  (table) => [
    unique("sessions_token_unique").on(table.token),
    index("sessions_user_idx").on(table.userId),
  ],
);

/** 密码登录的凭据（providerId = credential）；密码只存库的哈希。 */
export const accounts = pgTable(
  "accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestampWithTimeZone("access_token_expires_at"),
    refreshTokenExpiresAt: timestampWithTimeZone("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestampWithTimeZone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimeZone("updated_at").notNull(),
  },
  (table) => [index("accounts_user_idx").on(table.userId)],
);

export const verifications = pgTable(
  "verifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestampWithTimeZone("expires_at").notNull(),
    createdAt: timestampWithTimeZone("created_at").notNull().defaultNow(),
    updatedAt: timestampWithTimeZone("updated_at").notNull().defaultNow(),
  },
  (table) => [index("verifications_identifier_idx").on(table.identifier)],
);

/** 登录、注册限流的计数（库的 storage: "database"）；lastRequest 是毫秒时间戳。 */
export const rateLimits = pgTable(
  "rate_limits",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    count: integer("count").notNull(),
    lastRequest: bigint("last_request", { mode: "number" }).notNull(),
  },
  (table) => [unique("rate_limits_key_unique").on(table.key)],
);

/**
 * V2.12 邀请码（§3.2）：只存哈希，只用一次，缺省 7 天过期。注册时先占用（claimed_at）再建用户，
 * 建成写上使用者；建失败就释放。并发注册同一个码只有一个能占到。
 */
export const invites = pgTable(
  "invites",
  {
    id: uuid("id").primaryKey(),
    codeHash: text("code_hash").notNull(),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestampWithTimeZone("created_at").notNull(),
    expiresAt: timestampWithTimeZone("expires_at").notNull(),
    claimedAt: timestampWithTimeZone("claimed_at"),
    usedBy: uuid("used_by").references(() => users.id, { onDelete: "set null" }),
    usedAt: timestampWithTimeZone("used_at"),
  },
  (table) => [
    unique("invites_code_hash_unique").on(table.codeHash),
    check("invites_code_hash_check", sql`${table.codeHash} ~ '^[a-f0-9]{64}$'`),
    check("invites_expiry_check", sql`${table.expiresAt} > ${table.createdAt}`),
  ],
);

/**
 * V2.12 用量记录（§3.5，原来在本机文件 eval-results/local-usage.jsonl）：谁、哪天（北京时间）、哪一类、
 * 哪一种、什么用途。只记次数，不记请求内容。每次请求先预留一条，超过上限就不记、不发请求。
 */
export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    day: date("day", { mode: "string" }).notNull(),
    category: text("category").notNull(),
    kind: text("kind").notNull(),
    purpose: text("purpose").notNull(),
    createdAt: timestampWithTimeZone("created_at").notNull(),
    /** V3.0：发这次请求的根运行（agent_runs.id）。运行记录在请求结束时才写入，所以不设外键。 */
    runId: uuid("run_id"),
  },
  (table) => [
    check("usage_events_category_check", sql`${table.category} in ('amap', 'model', 'web', 'embed', 'jev')`),
    check("usage_events_text_check", sql`char_length(${table.kind}) between 1 and 40 and char_length(${table.purpose}) between 1 and 40`),
    index("usage_events_user_day_idx").on(table.userId, table.day, table.category),
    index("usage_events_day_idx").on(table.day, table.category),
    index("usage_events_run_idx").on(table.runId),
  ],
);

/** V2.12 拥有者给某人调的每日上限（没有就用环境变量的缺省）。 */
export const usageLimits = pgTable(
  "usage_limits",
  {
    userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
    dailyLimit: integer("daily_limit").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.category] }),
    check("usage_limits_category_check", sql`${table.category} in ('amap', 'model', 'web', 'embed', 'jev')`),
    check("usage_limits_daily_check", sql`${table.dailyLimit} between 0 and 100000`),
  ],
);

/** V2.12：数据归谁（§3.4）。顶层表都有这一列，删除用户时一起删；其余表通过外键归到它们。 */
const ownerId = () => uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" });

/**
 * V2.11 一趟出游（stages/V2.11.md §3.8）：日期、起终点、每晚住处、固定交通和每天的结构放在 details，
 * 只有地点编号、名称和我们自己的时刻。各天各段是普通的一日行程（journeys.trip_id），随出游删除。
 */
export const trips = pgTable(
  "trips",
  {
    id: uuid("id").primaryKey(),
    userId: ownerId(),
    /** 同一次生成只建一趟，重试按它幂等。 */
    generationId: uuid("generation_id").notNull(),
    title: text("title").notNull(),
    firstDate: date("first_date", { mode: "string" }).notNull(),
    lastDate: date("last_date", { mode: "string" }).notNull(),
    details: jsonb("details").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: timestampWithTimeZone("created_at").notNull(),
    updatedAt: timestampWithTimeZone("updated_at").notNull(),
  },
  (table) => [
    unique("trips_generation_id_unique").on(table.generationId),
    index("trips_user_idx").on(table.userId),
    check("trips_title_length_check", sql`${table.title} = btrim(${table.title}) and char_length(${table.title}) between 1 and 80`),
    check("trips_dates_check", sql`${table.lastDate} >= ${table.firstDate} and ${table.lastDate} - ${table.firstDate} <= 6`),
    check("trips_version_check", sql`${table.version} >= 1`),
    check("trips_updated_at_check", sql`${table.updatedAt} >= ${table.createdAt}`),
  ],
);

export const journeys = pgTable(
  "journeys",
  {
    id: uuid("id").primaryKey(),
    userId: ownerId(),
    title: text("title").notNull(),
    creationKind: text("creation_kind").notNull().default("manual"),
    creationRunId: uuid("creation_run_id"),
    creationIntentFingerprint: text("creation_intent_fingerprint"),
    journeyDate: date("date", { mode: "string" }).notNull(),
    timeZone: text("time_zone").notNull(),
    createdAt: timestampWithTimeZone("created_at").notNull(),
    updatedAt: timestampWithTimeZone("updated_at").notNull(),
    currentObservationVersion: integer("current_observation_version").notNull().default(0),
    /** V2.10：行程的主要城市（地级市一级的行政区编码和名称）；旧行程回填杭州。进度面板和天气按它查。 */
    cityAdcode: text("city_adcode").notNull().default("330100"),
    cityName: text("city_name").notNull().default("杭州市"),
    /** V2.11：属于哪趟出游、第几天、当天第几段（按固定交通分段）；日常的一日行程三项都为空。 */
    tripId: uuid("trip_id").references(() => trips.id, { onDelete: "cascade" }),
    tripDay: integer("trip_day"),
    tripPart: integer("trip_part"),
  },
  (table) => [
    unique("journeys_trip_part_unique").on(table.tripId, table.tripDay, table.tripPart),
    index("journeys_user_idx").on(table.userId),
    check("journeys_trip_check", sql`
      (${table.tripId} is null and ${table.tripDay} is null and ${table.tripPart} is null)
      or (${table.tripId} is not null and ${table.tripDay} between 1 and 7 and ${table.tripPart} between 0 and 6)
    `),
    check("journeys_city_check", sql`${table.cityAdcode} ~ '^[0-9]{6}$' and char_length(${table.cityName}) between 1 and 40`),
    check(
      "journeys_title_length_check",
      sql`${table.title} = btrim(${table.title}) and char_length(${table.title}) between 1 and 80`,
    ),
    check(
      "journeys_time_zone_check",
      sql`${table.timeZone} = 'Asia/Shanghai'`,
    ),
    check(
      "journeys_updated_at_check",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
    check("journeys_observation_version_check", sql`${table.currentObservationVersion} >= 0`),
    unique("journeys_creation_run_id_unique").on(table.creationRunId),
    check("journeys_creation_identity_check", sql`
      (${table.creationKind} = 'manual'
        and ${table.creationRunId} is null and ${table.creationIntentFingerprint} is null)
      or (${table.creationKind} in ('generated_day', 'real_day')
        and ${table.creationRunId} is not null
        and ${table.creationIntentFingerprint} is not null
        and ${table.creationIntentFingerprint} ~ '^[a-f0-9]{64}$')
    `),
  ],
);

/**
 * 计划版本追加保存，isCurrent 标记当前安排；实际进度使用另一套观察版本。
 * 两个版本各自变化，所以候选确认必须绑定两者，不能只检查计划有没有更新。
 */
export const planVersions = pgTable(
  "plan_versions",
  {
    journeyId: uuid("journey_id")
      .notNull()
      .references(() => journeys.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    parentVersion: integer("parent_version"),
    changeReason: text("change_reason"),
    isCurrent: boolean("is_current").notNull(),
    createdAt: timestampWithTimeZone("created_at").notNull(),
  },
  (table) => [
    primaryKey({
      name: "plan_versions_pkey",
      columns: [table.journeyId, table.version],
    }),
    foreignKey({
      name: "plan_versions_parent_fkey",
      columns: [table.journeyId, table.parentVersion],
      foreignColumns: [table.journeyId, table.version],
    }),
    check("plan_versions_version_check", sql`${table.version} > 0`),
    check(
      "plan_versions_parent_version_check",
      sql`${table.parentVersion} is null or (${table.parentVersion} > 0 and ${table.parentVersion} < ${table.version})`,
    ),
    check(
      "plan_versions_change_reason_check",
      sql`${table.changeReason} is null or (${table.changeReason} = btrim(${table.changeReason}) and char_length(${table.changeReason}) > 0)`,
    ),
    uniqueIndex("plan_versions_one_current_per_journey")
      .on(table.journeyId)
      .where(sql`${table.isCurrent} = true`),
  ],
);

export const dayPlanDetails = pgTable(
  "day_plan_details",
  {
    journeyId: uuid("journey_id").notNull(),
    planVersion: integer("plan_version").notNull(),
    details: jsonb("details").notNull(),
  },
  (table) => [
    primaryKey({ name: "day_plan_details_pkey", columns: [table.journeyId, table.planVersion] }),
    foreignKey({
      name: "day_plan_details_plan_version_fk",
      columns: [table.journeyId, table.planVersion],
      foreignColumns: [planVersions.journeyId, planVersions.version],
    }).onDelete("cascade"),
    check("day_plan_details_version_check", sql`${table.planVersion} > 0`),
  ],
);

export const reservations = pgTable(
  "reservations",
  {
    id: uuid("id").primaryKey(),
    journeyId: uuid("journey_id")
      .notNull()
      .references(() => journeys.id, { onDelete: "cascade" }),
    placeId: uuid("place_id").notNull(),
    placeName: text("place_name").notNull(),
    startsAt: timestampWithTimeZone("starts_at").notNull(),
    endsAt: timestampWithTimeZone("ends_at").notNull(),
    confirmationStatus: text("confirmation_status").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceReference: text("source_reference"),
    recordedAt: timestampWithTimeZone("recorded_at").notNull(),
  },
  (table) => [
    unique("reservations_journey_id_id_unique").on(table.journeyId, table.id),
    check(
      "reservations_place_name_length_check",
      sql`${table.placeName} = btrim(${table.placeName}) and char_length(${table.placeName}) between 1 and 80`,
    ),
    check(
      "reservations_time_window_check",
      sql`${table.startsAt} < ${table.endsAt}`,
    ),
    check(
      "reservations_confirmation_status_check",
      sql`${table.confirmationStatus} in ('confirmed', 'pending', 'cancelled', 'unknown')`,
    ),
    check(
      "reservations_source_kind_check",
      sql`${table.sourceKind} in ('fixture', 'user_reported', 'provider_record')`,
    ),
    index("reservations_journey_id_idx").on(table.journeyId),
  ],
);

export const planActivities = pgTable(
  "plan_activities",
  {
    journeyId: uuid("journey_id").notNull(),
    planVersion: integer("plan_version").notNull(),
    activityId: uuid("activity_id").notNull(),
    position: integer("position").notNull(),
    placeId: uuid("place_id").notNull(),
    placeName: text("place_name").notNull(),
    startsAt: timestampWithTimeZone("starts_at").notNull(),
    endsAt: timestampWithTimeZone("ends_at").notNull(),
    priority: text("priority").notNull(),
    locked: boolean("locked").notNull(),
    reservationId: uuid("reservation_id"),
  },
  (table) => [
    primaryKey({
      name: "plan_activities_pkey",
      columns: [table.journeyId, table.planVersion, table.activityId],
    }),
    foreignKey({
      name: "plan_activities_plan_version_fkey",
      columns: [table.journeyId, table.planVersion],
      foreignColumns: [planVersions.journeyId, planVersions.version],
    }).onDelete("cascade"),
    foreignKey({
      name: "plan_activities_reservation_fkey",
      columns: [table.journeyId, table.reservationId],
      foreignColumns: [reservations.journeyId, reservations.id],
    }),
    unique("plan_activities_position_unique").on(
      table.journeyId,
      table.planVersion,
      table.position,
    ),
    check("plan_activities_position_check", sql`${table.position} >= 0`),
    check(
      "plan_activities_place_name_length_check",
      sql`${table.placeName} = btrim(${table.placeName}) and char_length(${table.placeName}) between 1 and 80`,
    ),
    check(
      "plan_activities_time_window_check",
      sql`${table.startsAt} < ${table.endsAt}`,
    ),
    check(
      "plan_activities_priority_check",
      sql`${table.priority} in ('high', 'normal', 'low')`,
    ),
    check(
      "plan_activities_reservation_lock_check",
      sql`${table.reservationId} is null or (${table.locked} = true and ${table.priority} = 'high')`,
    ),
    index("plan_activities_reservation_idx").on(
      table.journeyId,
      table.reservationId,
    ),
  ],
);

export const journeyObservations = pgTable("journey_observations", {
  journeyId: uuid("journey_id").notNull().references(() => journeys.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  observedAt: timestampWithTimeZone("observed_at").notNull(),
  completedActivityIds: uuid("completed_activity_ids").array().notNull(),
  skippedActivityIds: uuid("skipped_activity_ids").array().notNull(),
  currentActivityId: uuid("current_activity_id"),
  locationPlaceId: uuid("location_place_id").notNull(),
  source: text("source").notNull(),
  recordedAt: timestampWithTimeZone("recorded_at").notNull(),
}, (table) => [
  primaryKey({ name: "journey_observations_pkey", columns: [table.journeyId, table.version] }),
  check("journey_observations_version_check", sql`${table.version} > 0`),
  check("journey_observations_source_check", sql`${table.source} = 'user_reported'`),
  check("journey_observations_current_activity_check", sql`${table.currentActivityId} is null`),
  check("journey_observations_skipped_check", sql`cardinality(${table.skippedActivityIds}) = 0`),
]);

export const planConfirmations = pgTable("plan_confirmations", {
  journeyId: uuid("journey_id").notNull().references(() => journeys.id, { onDelete: "cascade" }),
  idempotencyKey: uuid("idempotency_key").notNull(),
  intentFingerprint: text("intent_fingerprint").notNull(),
  basePlanVersion: integer("base_plan_version").notNull(),
  baseObservationVersion: integer("base_observation_version").notNull(),
  resultPlanVersion: integer("result_plan_version").notNull(),
  resultObservationVersion: integer("result_observation_version").notNull(),
  normalizedInput: jsonb("normalized_input").notNull(),
  strategy: text("strategy").notNull(),
  previewFingerprint: text("preview_fingerprint").notNull(),
  travelSource: text("travel_source").notNull(),
  transferBufferMinutes: integer("transfer_buffer_minutes").notNull(),
  confirmedAt: timestampWithTimeZone("confirmed_at").notNull(),
}, (table) => [
  primaryKey({ name: "plan_confirmations_pkey", columns: [table.journeyId, table.idempotencyKey] }),
  foreignKey({ name: "plan_confirmations_result_plan_fkey", columns: [table.journeyId, table.resultPlanVersion], foreignColumns: [planVersions.journeyId, planVersions.version] }),
  foreignKey({ name: "plan_confirmations_result_observation_fkey", columns: [table.journeyId, table.resultObservationVersion], foreignColumns: [journeyObservations.journeyId, journeyObservations.version] }),
  check("plan_confirmations_versions_check", sql`${table.basePlanVersion} > 0 and ${table.baseObservationVersion} >= 0 and ${table.resultPlanVersion} = ${table.basePlanVersion} + 1 and ${table.resultObservationVersion} = ${table.baseObservationVersion} + 1`),
  check("plan_confirmations_strategy_check", sql`${table.strategy} in ('shift', 'omit')`),
  check("plan_confirmations_travel_source_check", sql`${table.travelSource} in ('user_estimate', 'same_place')`),
  check("plan_confirmations_buffer_check", sql`${table.transferBufferMinutes} = 10`),
]);

export const generatedDayEditConfirmations = pgTable(
  "generated_day_edit_confirmations",
  {
    journeyId: uuid("journey_id")
      .notNull()
      .references(() => journeys.id, { onDelete: "cascade" }),
    editId: uuid("edit_id").notNull(),
    intentFingerprint: text("intent_fingerprint").notNull(),
    basePlanVersion: integer("base_plan_version").notNull(),
    baseObservationVersion: integer("base_observation_version").notNull(),
    resultPlanVersion: integer("result_plan_version").notNull(),
    change: jsonb("change").notNull(),
    candidateFingerprint: text("candidate_fingerprint").notNull(),
    confirmedAt: timestampWithTimeZone("confirmed_at").notNull(),
  },
  (table) => [
    primaryKey({
      name: "generated_day_edit_confirmations_pkey",
      columns: [table.journeyId, table.editId],
    }),
    foreignKey({
      name: "generated_day_edits_base_plan_fk",
      columns: [table.journeyId, table.basePlanVersion],
      foreignColumns: [planVersions.journeyId, planVersions.version],
    }),
    foreignKey({
      name: "generated_day_edits_result_plan_fk",
      columns: [table.journeyId, table.resultPlanVersion],
      foreignColumns: [planVersions.journeyId, planVersions.version],
    }),
    check(
      "generated_day_edits_versions_check",
      sql`
    ${table.basePlanVersion} > 0 and ${table.baseObservationVersion} = 0
    and ${table.resultPlanVersion} = ${table.basePlanVersion} + 1
  `,
    ),
    check(
      "generated_day_edits_fingerprints_check",
      sql`
    ${table.intentFingerprint} ~ '^[a-f0-9]{64}$' and ${table.candidateFingerprint} ~ '^[a-f0-9]{64}$'
  `,
    ),
  ],
);

/** 每条记录是一版累计用户报告，保存截至该观测版本的完整事实。 */
export const generatedDayProgress = pgTable(
  "generated_day_progress",
  {
    journeyId: uuid("journey_id")
      .notNull()
      .references(() => journeys.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    previousVersion: integer("previous_version").notNull(),
    basePlanVersion: integer("base_plan_version").notNull(),
    reportId: uuid("report_id").notNull(),
    intentFingerprint: text("intent_fingerprint").notNull(),
    observedAt: timestampWithTimeZone("observed_at").notNull(),
    earliestResumeAt: timestampWithTimeZone("earliest_resume_at").notNull(),
    completedActivityIds: uuid("completed_activity_ids").array().notNull(),
    skippedActivityIds: uuid("skipped_activity_ids").array().notNull(),
    locationPlaceId: uuid("location_place_id"),
    source: text("source").notNull(),
    recordedAt: timestampWithTimeZone("recorded_at").notNull(),
  },
  (table) => [
    primaryKey({
      name: "generated_day_progress_pkey",
      columns: [table.journeyId, table.version],
    }),
    unique("generated_day_progress_report_unique").on(table.journeyId, table.reportId),
    foreignKey({
      name: "generated_day_progress_base_plan_fk",
      columns: [table.journeyId, table.basePlanVersion],
      foreignColumns: [planVersions.journeyId, planVersions.version],
    }),
    check(
      "generated_day_progress_versions_check",
      sql`${table.version} > 0 and ${table.previousVersion} = ${table.version} - 1 and ${table.basePlanVersion} > 0`,
    ),
    check(
      "generated_day_progress_times_check",
      sql`${table.earliestResumeAt} >= ${table.observedAt}`,
    ),
    check(
      "generated_day_progress_sets_check",
      sql`cardinality(${table.completedActivityIds}) <= 6 and cardinality(${table.skippedActivityIds}) <= 6
        and not (${table.completedActivityIds} && ${table.skippedActivityIds})`,
    ),
    check("generated_day_progress_source_check", sql`${table.source} = 'user_reported'`),
    check(
      "generated_day_progress_fingerprint_check",
      sql`${table.intentFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

/** 每次重排确认一条记录，结果版本指向本次生成的新计划，供相同 runId 重试回放。 */
export const generatedDayReplanConfirmations = pgTable(
  "generated_day_replan_confirmations",
  {
    journeyId: uuid("journey_id")
      .notNull()
      .references(() => journeys.id, { onDelete: "cascade" }),
    runId: uuid("run_id").notNull(),
    intentFingerprint: text("intent_fingerprint").notNull(),
    basePlanVersion: integer("base_plan_version").notNull(),
    baseObservationVersion: integer("base_observation_version").notNull(),
    resultPlanVersion: integer("result_plan_version").notNull(),
    confirmedAt: timestampWithTimeZone("confirmed_at").notNull(),
  },
  (table) => [
    primaryKey({
      name: "generated_day_replan_confirmations_pkey",
      columns: [table.journeyId, table.runId],
    }),
    foreignKey({
      name: "generated_day_replans_base_plan_fk",
      columns: [table.journeyId, table.basePlanVersion],
      foreignColumns: [planVersions.journeyId, planVersions.version],
    }),
    foreignKey({
      name: "generated_day_replans_result_plan_fk",
      columns: [table.journeyId, table.resultPlanVersion],
      foreignColumns: [planVersions.journeyId, planVersions.version],
    }),
    foreignKey({
      name: "generated_day_replans_base_progress_fk",
      columns: [table.journeyId, table.baseObservationVersion],
      foreignColumns: [generatedDayProgress.journeyId, generatedDayProgress.version],
    }),
    check(
      "generated_day_replans_versions_check",
      sql`${table.basePlanVersion} > 0 and ${table.baseObservationVersion} > 0
        and ${table.resultPlanVersion} = ${table.basePlanVersion} + 1`,
    ),
    check(
      "generated_day_replans_fingerprint_check",
      sql`${table.intentFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
  ],
);

/**
 * 后台规划任务表：request_key 标识页面意图，Worker 通过租约领取。
 * 所有 Worker 写入都用 lease_token 隔离过期进程，终态通过条件更新只落一次。
 */
export const planningTasks = pgTable(
  "planning_tasks",
  {
    id: uuid("id").primaryKey(),
    userId: ownerId(),
    kind: text("kind").notNull(),
    journeyId: uuid("journey_id").references(() => journeys.id, { onDelete: "cascade" }),
    requestKey: uuid("request_key").notNull(),
    intentFingerprint: text("intent_fingerprint").notNull(),
    // 使用 json 保留键顺序，兼容确认快照原协议的文本指纹；改用 jsonb 会改变此语义。
    input: json("input").notNull(),
    status: text("status").notNull(),
    progress: json("progress"),
    result: json("result"),
    offer: json("offer"),
    stopReason: text("stop_reason"),
    attempts: integer("attempts").notNull().default(0),
    leaseOwner: text("lease_owner"),
    leaseToken: uuid("lease_token"),
    leaseExpiresAt: timestampWithTimeZone("lease_expires_at"),
    cancelRequestedAt: timestampWithTimeZone("cancel_requested_at"),
    deadlineAt: timestampWithTimeZone("deadline_at").notNull(),
    createdAt: timestampWithTimeZone("created_at").notNull(),
    startedAt: timestampWithTimeZone("started_at"),
    finishedAt: timestampWithTimeZone("finished_at"),
  },
  (table) => [
    unique("planning_tasks_request_key_unique").on(table.requestKey),
    check("planning_tasks_kind_check", sql`
      (${table.kind} = 'day_draft' and ${table.journeyId} is null)
      or (${table.kind} = 'day_replan' and ${table.journeyId} is not null)
    `),
    check(
      "planning_tasks_status_check",
      sql`${table.status} in ('queued', 'running', 'completed', 'failed', 'cancelled')`,
    ),
    check(
      "planning_tasks_stop_reason_check",
      sql`${table.stopReason} is null or ${table.stopReason} in ('cancelled', 'deadline', 'worker_lost')`,
    ),
    check("planning_tasks_attempts_check", sql`${table.attempts} between 0 and 3`),
    check(
      "planning_tasks_fingerprint_check",
      sql`${table.intentFingerprint} ~ '^[a-f0-9]{64}$'`,
    ),
    check("planning_tasks_lease_check", sql`
      (${table.status} = 'running') = (${table.leaseToken} is not null)
      and (${table.leaseToken} is null) = (${table.leaseExpiresAt} is null)
      and (${table.leaseToken} is null) = (${table.leaseOwner} is null)
    `),
    check("planning_tasks_terminal_check", sql`
      (${table.status} in ('completed', 'failed', 'cancelled')) = (${table.finishedAt} is not null)
      and (${table.status} <> 'completed' or ${table.result} is not null)
      and (${table.status} not in ('failed', 'cancelled') or ${table.result} is not null or ${table.stopReason} is not null)
      and (${table.offer} is null or ${table.status} = 'completed')
    `),
    index("planning_tasks_claim_idx").on(table.status, table.createdAt),
    index("planning_tasks_user_idx").on(table.userId),
    index("planning_tasks_finished_idx").on(table.finishedAt),
  ],
);

/** 对话只存用户文字、我们生成的说明和高德地点编号、名称；地点详情、路线与天气保持实时查询（D-046）。 */
export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey(),
    userId: ownerId(),
    title: text("title").notNull(),
    status: text("status").notNull().default("active"),
    journeyId: uuid("journey_id").references(() => journeys.id, { onDelete: "set null" }),
    draft: jsonb("draft").notNull(),
    messageCount: integer("message_count").notNull().default(0),
    /** V2.9：窗口之外旧对话的滚动摘要 {text, throughSeq}；原消息不删。 */
    summary: jsonb("summary"),
    createdAt: timestampWithTimeZone("created_at").notNull(),
    updatedAt: timestampWithTimeZone("updated_at").notNull(),
  },
  (table) => [
    check(
      "conversations_title_length_check",
      sql`${table.title} = btrim(${table.title}) and char_length(${table.title}) between 1 and 80`,
    ),
    check("conversations_status_check", sql`${table.status} in ('active', 'planned', 'archived')`),
    check("conversations_message_count_check", sql`${table.messageCount} >= 0`),
    check("conversations_updated_at_check", sql`${table.updatedAt} >= ${table.createdAt}`),
    index("conversations_updated_idx").on(table.updatedAt),
    index("conversations_user_idx").on(table.userId, table.updatedAt),
  ],
);

export const conversationMessages = pgTable(
  "conversation_messages",
  {
    id: uuid("id").primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    role: text("role").notNull(),
    kind: text("kind").notNull(),
    body: jsonb("body").notNull(),
    createdAt: timestampWithTimeZone("created_at").notNull(),
  },
  (table) => [
    unique("conversation_messages_seq_unique").on(table.conversationId, table.seq),
    check("conversation_messages_seq_check", sql`${table.seq} > 0`),
    check("conversation_messages_role_check", sql`${table.role} in ('user', 'assistant')`),
    check(
      "conversation_messages_kind_check",
      sql`${table.kind} in ('text', 'requirements_card', 'planning_progress', 'plan_card', 'notice', 'choices', 'adjust_card', 'preference_proposal', 'outing_day', 'outing_change', 'outing_review')`,
    ),
  ],
);

/** 关键词列生成全文检索向量；Drizzle 没有内建 tsvector 类型，因此显式声明。 */
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

/**
 * 知识库只存我们自有的稳定知识语料，排除高德数据与网页原文（D-059/D-060）。
 * 段落正文是自有内容，需要存储以支持点击引用后查看原段落。
 */
export const knowledgeDocuments = pgTable(
  "knowledge_documents",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    topic: text("topic").notNull(),
    /** 文章头部的来源列表，记录来源地址、访问日期与说明。 */
    sources: jsonb("sources").notNull(),
    /** 正文、分块器与向量模型一起决定内容指纹；均未变化时跳过重复向量化。 */
    contentHash: text("content_hash").notNull(),
    ingestedAt: timestampWithTimeZone("ingested_at").notNull(),
    /** V2.10：文档讲的是哪个城市；检索只查卡片城市的文档（现有 20 篇都是杭州）。 */
    cityAdcode: text("city_adcode").notNull().default("330100"),
  },
  (table) => [
    check("knowledge_documents_id_check", sql`${table.id} ~ '^[a-z0-9-]{1,80}$'`),
    check("knowledge_documents_city_check", sql`${table.cityAdcode} ~ '^[0-9]{6}$'`),
  ],
);

/**
 * 同一段正文建立两种索引：HNSW 用于语义近邻，GIN 用于关键词匹配。
 * 它们只负责召回候选；是否足以回答问题，由 RAG 的重排分数和阈值判断。
 */
export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: text("id").primaryKey(),
    documentId: text("document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    headingPath: text("heading_path").notNull(),
    body: text("body").notNull(),
    embedding: vector("embedding", { dimensions: 1024 }).notNull(),
    /** 用空格分隔中文相邻双字词，补足 PostgreSQL 默认配置无法切分中文的问题。 */
    keywords: text("keywords").notNull(),
    keywordVector: tsvector("keyword_vector")
      .notNull()
      .generatedAlwaysAs(sql`to_tsvector('simple', keywords)`),
  },
  (table) => [
    unique("knowledge_chunks_seq_unique").on(table.documentId, table.seq),
    check("knowledge_chunks_seq_check", sql`${table.seq} >= 0`),
    index("knowledge_chunks_embedding_idx").using("hnsw", table.embedding.op("vector_cosine_ops")),
    index("knowledge_chunks_keyword_idx").using("gin", table.keywordVector),
  ],
);

/**
 * V2.9 长期偏好：本机单用户，最多 30 条（应用层限制）。只存用户自己的话，不存高德数据；
 * 只有用户能改和删，删除即物理删除。来源对话删除后，偏好保留、来源置空。
 */
export const preferences = pgTable(
  "preferences",
  {
    id: uuid("id").primaryKey(),
    userId: ownerId(),
    text: text("text").notNull(),
    category: text("category").notNull(),
    sourceConversationId: uuid("source_conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    createdAt: timestampWithTimeZone("created_at").notNull(),
    updatedAt: timestampWithTimeZone("updated_at").notNull(),
  },
  (table) => [
    check("preferences_text_check", sql`${table.text} = btrim(${table.text}) and char_length(${table.text}) between 1 and 40`),
    check("preferences_category_check", sql`${table.category} in ('food', 'pace', 'travel', 'interest', 'other')`),
    check("preferences_updated_at_check", sql`${table.updatedAt} >= ${table.createdAt}`),
    index("preferences_user_idx").on(table.userId),
  ],
);

/**
 * V2.9 每轮决策记录（只追加）：分流、模型动作、校验提示码、工具调用、计数与用量。
 * 不存地址、坐标、网页摘要或资料库正文；随对话一起删除。
 */
export const chatTraces = pgTable(
  "chat_traces",
  {
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    record: jsonb("record").notNull(),
    createdAt: timestampWithTimeZone("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.seq] }),
    check("chat_traces_seq_check", sql`${table.seq} > 0`),
  ],
);

/** 运行记录要毫秒：一步只有几十毫秒。 */
const preciseTime = (name: string) => timestamp(name, { withTimezone: true, mode: "date", precision: 3 });

/**
 * V3.0 运行记录（stages/V3.0.md §3.2）：一次 Agent 执行一行，结构参照 OpenTelemetry 的 span（编号、父、根、
 * 起止、状态、属性）。根运行带触发入口和关联的对话 / 行程 / 出游，删掉它们时整棵树一起删（子运行经 root_id）；
 * 删除用户时也一起删。次数是这个运行这棵子树的合计。
 */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey(),
    rootId: uuid("root_id").notNull(),
    parentId: uuid("parent_id"),
    userId: ownerId(),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "cascade" }),
    journeyId: uuid("journey_id").references(() => journeys.id, { onDelete: "cascade" }),
    tripId: uuid("trip_id").references(() => trips.id, { onDelete: "cascade" }),
    agent: text("agent").notNull(),
    agentVersion: text("agent_version"),
    trigger: text("trigger"),
    status: text("status").notNull(),
    outcome: text("outcome"),
    attributes: jsonb("attributes").notNull(),
    startedAt: preciseTime("started_at").notNull(),
    finishedAt: preciseTime("finished_at"),
    modelRequests: integer("model_requests").notNull(),
    inputTokens: integer("input_tokens").notNull(),
    outputTokens: integer("output_tokens").notNull(),
    cacheHitTokens: integer("cache_hit_tokens").notNull(),
    mapRequests: integer("map_requests").notNull(),
    webRequests: integer("web_requests").notNull(),
    knowledgeRequests: integer("knowledge_requests").notNull(),
    jevRequests: integer("jev_requests").notNull(),
  },
  (table) => [
    foreignKey({ columns: [table.rootId], foreignColumns: [table.id], name: "agent_runs_root_id_fk" }).onDelete("cascade"),
    check(
      "agent_runs_status_check",
      sql`${table.status} in ('running', 'ok', 'none', 'failed', 'fallback', 'budget_exhausted', 'cancelled')`,
    ),
    check("agent_runs_text_check", sql`char_length(${table.agent}) between 1 and 40 and char_length(coalesce(${table.outcome}, '')) <= 80`),
    index("agent_runs_root_idx").on(table.rootId),
    index("agent_runs_user_idx").on(table.userId, table.startedAt),
    index("agent_runs_conversation_idx").on(table.conversationId),
  ],
);

/** V3.0 运行里的一步：只存短的结构化摘要，不存地址、坐标、网页正文和摘要、资料库正文、用户消息全文。 */
export const agentSteps = pgTable(
  "agent_steps",
  {
    runId: uuid("run_id").notNull().references(() => agentRuns.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    latencyMs: integer("latency_ms"),
    summary: jsonb("summary").notNull(),
    at: preciseTime("at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.runId, table.seq] }),
    check("agent_steps_kind_check", sql`${table.kind} in ('model_call', 'tool_call', 'check', 'repair', 'handoff', 'fallback')`),
  ],
);

/**
 * V3.5 对话里的长任务（stages/V3.5.md §3.1）：开始规划、出游生成、跨天改动、调整今天的行程各登记一行。一段对话同时只有一个
 * running（部分唯一索引）；页面生成的请求键重试时找到同一行。进度只有我们自己的步骤文字（最多 30 条）和出游已排好的
 * 天号，不存坐标、地址、路线、网页正文（D-045 / D-046）；随对话、随账号一起删除。心跳停了 30 秒的 running 由查询的一方
 * 改成 interrupted（进程重启后），由用户点“继续”，不自动重跑。
 */
export const conversationJobs = pgTable(
  "conversation_jobs",
  {
    id: uuid("id").primaryKey(),
    userId: ownerId(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    requestKey: uuid("request_key").notNull(),
    status: text("status").notNull(),
    /** 步骤文字（最多 30 条）。 */
    steps: jsonb("steps").notNull(),
    /** 出游已排好的天（天号，升序）；其他种类是空数组。 */
    days: jsonb("days").notNull(),
    /** 这次要排的天（出游）；整趟时是全部天。 */
    planned: jsonb("planned").notNull(),
    /** V3.0 这一次的根运行（运行记录可能被单独清掉，不加外键）。 */
    rootRunId: uuid("root_run_id"),
    startedAt: preciseTime("started_at").notNull(),
    heartbeatAt: preciseTime("heartbeat_at").notNull(),
    finishedAt: preciseTime("finished_at"),
  },
  (table) => [
    check("conversation_jobs_kind_check", sql`${table.kind} in ('plan', 'outing', 'outing_change', 'adjust')`),
    check("conversation_jobs_status_check", sql`${table.status} in ('running', 'done', 'failed', 'cancelled', 'interrupted')`),
    unique("conversation_jobs_request_unique").on(table.conversationId, table.requestKey),
    uniqueIndex("conversation_jobs_one_running").on(table.conversationId).where(sql`${table.status} = 'running'`),
    index("conversation_jobs_conversation_idx").on(table.conversationId, table.startedAt),
    index("conversation_jobs_user_idx").on(table.userId),
  ],
);

export const schema = {
  users,
  sessions,
  accounts,
  verifications,
  rateLimits,
  invites,
  usageEvents,
  usageLimits,
  trips,
  dayPlanDetails,
  journeys,
  planVersions,
  reservations,
  planActivities,
  journeyObservations,
  planConfirmations,
  generatedDayEditConfirmations,
  generatedDayProgress,
  generatedDayReplanConfirmations,
  planningTasks,
  conversations,
  conversationMessages,
  knowledgeDocuments,
  knowledgeChunks,
  preferences,
  chatTraces,
  agentRuns,
  agentSteps,
  conversationJobs,
};
