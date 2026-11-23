"use server";

import type { PlaceSummary, ProviderEvidence } from "@tripquest/providers";
import { pageUser } from "../auth/session";
import { createUserUsage, meteredAmap } from "../usage/usage";
import { readPlanningConfig } from "../planning/new/planning-config";
import { readRealPlaceMode } from "../real-places/real-mode";
import { issuePlaceToken } from "../planning/new/place-token";
import { readPlanningMapConfig } from "../journeys/map-config";

async function lookup() {
  const user = await pageUser("/plan/new");
  const config = readPlanningConfig();
  if (!config.enabled || config.source !== "amap" || !readRealPlaceMode().enabled) return null;
  const provider = meteredAmap({ key: config.key, usage: createUserUsage(user.id), purpose: "card-selection" });
  const { secret } = config;
  function choice(place: PlaceSummary, evidence: ProviderEvidence) {
    return {
      id: place.ref.externalId, name: place.name, cityCode: place.cityAdcode, address: place.address,
      longitude: place.location.longitude, latitude: place.location.latitude,
      token: issuePlaceToken({ place, evidence }, secret, "amap", Date.now()),
    };
  }
  return { provider, choice };
}

export async function openBoundaryMap(city: string) {
  const lookupCity = await lookup();
  if (!lookupCity) return { error: "地点查询暂不可用。" } as const;
  if (typeof city !== "string" || !city.trim() || city.length > 20) return { error: "请输入城市名称。" } as const;
  const result = await lookupCity.provider.resolveMapCity(city.trim());
  if (result.status !== "ok") return { error: "未能载入城市，请核对城市名称或稍后再试。" } as const;
  return { city: result.data, config: readPlanningMapConfig() } as const;
}

export async function searchBoundaryPlaces(query: string, city: string) {
  const service = await lookup();
  if (!service) return { error: "地点查询暂不可用。" } as const;
  if (typeof query !== "string" || !query.trim() || query.length > 80 || !/^\d{6}$/.test(city)) {
    return { error: "请填写地点关键词并选择搜索城市。" } as const;
  }
  const result = await service.provider.searchPlaces({ query: query.trim(), scope: { kind: "city", cityAdcode: city }, limit: 6 });
  if (result.status !== "ok") return { error: result.failure.safeMessage } as const;
  return { items: result.data.items.filter((item) => item.cityAdcode === city).map((item) => service.choice(item, result.evidence)) } as const;
}

export async function pickBoundaryAtPoint(longitude: number, latitude: number, city: string) {
  const service = await lookup();
  if (!service) return { error: "地点查询暂不可用。" } as const;
  if (!/^\d{6}$/.test(city) || !Number.isFinite(longitude) || Math.abs(longitude) > 180 ||
      !Number.isFinite(latitude) || Math.abs(latitude) > 90) return { error: "请在地图上重新选点。" } as const;
  const result = await service.provider.placeAtMapPoint({ longitude, latitude });
  if (result.status !== "ok") return { error: result.failure.safeMessage } as const;
  if (result.data.city.adcode !== city) return { error: "这个地点在其他城市，请核对搜索城市。" } as const;
  return { items: [service.choice(result.data.place, result.evidence)] } as const;
}
