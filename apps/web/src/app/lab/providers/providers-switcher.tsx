"use client";
import { useState } from "react";
import ProvidersLab from "./providers-lab";
import LiveLab from "./live-lab";
import type { LiveConfiguration } from "./live-types";
export default function ProvidersSwitcher({ configuration }: { configuration: LiveConfiguration }) {
  const [source, setSource] = useState<"fixture" | "live">("fixture");
  return <div className="min-h-dvh bg-[#f7f9f7]">
    <nav aria-label="数据来源" className="mx-auto flex max-w-3xl gap-3 px-5 py-5">
      {([ ["fixture", "虚构实验"], ["live", "杭州实时验证"] ] as const).map(([key, label]) => <button key={key} type="button" aria-pressed={source === key} onClick={() => setSource(key)} className={`rounded-xl border px-4 py-3 text-sm ${source === key ? "border-[#236d55] bg-[#edf6f0] text-[#195740]" : "border-[#dce8e0] bg-white"}`}>{label}</button>)}
    </nav>
    {source === "fixture" ? <ProvidersLab /> : <div className="px-5 pb-8"><LiveLab configuration={configuration} /></div>}
  </div>;
}
