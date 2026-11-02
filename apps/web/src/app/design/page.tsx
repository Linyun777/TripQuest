import { notFound } from "next/navigation";
import { readPlanningMapConfig } from "../journeys/map-config";
import { DesignGallery } from "./gallery";

export const runtime = "nodejs";

/** Development-only review page for the V2.1 visual checkpoint; sample data, no requests. */
export default async function DesignPage({ searchParams }: { searchParams: Promise<{ state?: string }> }) {
  if (process.env.NODE_ENV !== "development") notFound();
  const { state } = await searchParams;
  return <DesignGallery state={state === "empty" ? "empty" : "full"} mapConfig={readPlanningMapConfig()} />;
}
