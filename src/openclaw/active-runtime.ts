import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { HerdrRuntime } from "./runtime.js";

// Discovery may register the plugin again without starting its services.
// Only the service lifecycle owns this slot; discovery must never replace it.
export const activeRuntime = createPluginRuntimeStore<HerdrRuntime>({
  key: "openclaw-herdr:active-service-runtime",
  errorMessage: "Herdr watcher service is not running.",
});
