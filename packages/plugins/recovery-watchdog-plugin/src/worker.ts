import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import { reconcileStaleBlockedParents } from "./watchdog.js";

let currentCtx: PluginContext | null = null;

const plugin = definePlugin({
  async setup(ctx) {
    currentCtx = ctx;

    ctx.jobs.register("check-stale-blocked-parents", async (_job) => {
      if (!currentCtx) return;
      await reconcileStaleBlockedParents(currentCtx);
    });
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
