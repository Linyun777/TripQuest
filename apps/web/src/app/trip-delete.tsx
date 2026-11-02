"use client";

import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "./_ui/button";

/** V2.11：删除一趟出游，各天的行程一起删除（D-046 的一键删除）；先确认一次。 */
export function DeleteTrip({ tripId }: { tripId: string }) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "confirm" | "deleting" | "failed">("idle");
  async function remove() {
    setState("deleting");
    try {
      const response = await fetch(`/api/trips/${tripId}`, { method: "DELETE" });
      if (!response.ok) throw new Error("failed");
      router.refresh();
    } catch {
      setState("failed");
    }
  }
  if (state === "confirm" || state === "deleting") {
    return (
      <span className="flex items-center gap-2 text-sm">
        <span className="text-ink-soft">整趟和各天都会删除</span>
        <Button size="sm" variant="secondary" onClick={() => setState("idle")} disabled={state === "deleting"}>
          取消
        </Button>
        <Button size="sm" onClick={() => void remove()} disabled={state === "deleting"}>
          {state === "deleting" ? "删除中…" : "确定删除"}
        </Button>
      </span>
    );
  }
  return (
    <Button size="sm" variant="ghost" onClick={() => setState("confirm")}>
      <Trash2 />
      {state === "failed" ? "没删掉，再试一次" : "删除这趟出游"}
    </Button>
  );
}
