import type { PeriodicJob } from "@/worker/registry";
import { syncDueFeeds } from "./service";

export const periodic: PeriodicJob[] = [
  {
    name: "ical-sync",
    everyMs: 5 * 60_000,
    run: () => syncDueFeeds(),
  },
];
