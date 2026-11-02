import { CloudRain, Footprints, Sparkles } from "lucide-react";
import { Badge } from "./_ui/badge";

// Decorative sample for the home page; hand-written, not provider data.
const STOPS = [
  { time: "09:25", name: "中国越剧博物馆", reason: "满足“越剧相关”，室内", walk: 22 },
  { time: "11:20", name: "晓风书屋", reason: "满足“安静的书店”", walk: 18 },
  { time: "14:00", name: "浙江省博物馆", reason: "你的固定预约", walk: 22, fixed: true },
];

export function HomePreview() {
  return (
    <div className="relative mx-auto w-full max-w-sm select-none" aria-hidden="true">
      <div className="absolute -inset-6 rounded-[40px] bg-[radial-gradient(closest-side,var(--color-lake-100),transparent)]" />
      <div className="relative rotate-[1.5deg] rounded-[26px] border border-line bg-surface p-5 shadow-float">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-medium text-lake-600">示例方案</p>
            <p className="mt-0.5 font-semibold">西湖边的越剧与书店之旅</p>
          </div>
          <Badge tone="rain">
            <CloudRain />
            小雨 17–23°
          </Badge>
        </div>
        <ol className="mt-4 space-y-2.5">
          {STOPS.map((stop, index) => (
            <li key={stop.name}>
              <p className="mb-1.5 flex items-center gap-1 pl-12 text-[11px] text-ink-faint">
                <Footprints className="size-3" />
                步行约 {stop.walk} 分钟
              </p>
              <div className="flex items-center gap-3">
                <span className="tabular w-9 text-right text-sm font-medium">{stop.time}</span>
                <div className="flex-1 rounded-2xl border border-line px-3 py-2">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <span className="grid size-4.5 place-items-center rounded-full bg-lake-600 text-[10px] text-white">
                      {index + 1}
                    </span>
                    {stop.name}
                    {stop.fixed && <Badge tone="sun">固定</Badge>}
                  </p>
                  <p className="mt-0.5 flex items-center gap-1 text-xs text-ink-soft">
                    <Sparkles className="size-3 text-sun-500" />
                    {stop.reason}
                  </p>
                </div>
              </div>
            </li>
          ))}
        </ol>
      </div>
      <div className="relative -mt-4 ml-auto mr-[-12px] w-fit -rotate-[2deg] rounded-[20px] rounded-br-md bg-lake-600 px-4 py-2.5 text-sm text-white shadow-float">
        下午有点累，书店换个近一点的？
      </div>
    </div>
  );
}
