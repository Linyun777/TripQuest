import { notFound } from "next/navigation";
import ProvidersSwitcher from "./providers-switcher";
import { liveConfiguration } from "./live-config";

export default function ProvidersLabPage() {
  if (process.env.NODE_ENV !== "development") notFound();
  return <ProvidersSwitcher configuration={liveConfiguration()} />;
}
