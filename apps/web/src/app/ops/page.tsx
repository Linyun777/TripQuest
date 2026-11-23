import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { pageUser } from "../auth/session";
import { Operations } from "./view";

export const metadata: Metadata = {
  title: "费用与运行 · TripQuest",
  description: "站长观测台：按用户查看用量与 Agent 运行轨迹，动态调整全站与个人每日额度。",
};

export default async function OpsPage() {
  if ((await pageUser("/ops")).role !== "admin") notFound();
  return <Operations />;
}
