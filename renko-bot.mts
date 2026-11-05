import type { Config } from "@netlify/functions";
import { runBot } from "../lib/bot.mts";

export default async () => {
  try {
    const result = await runBot();
    console.log("Run finished:", JSON.stringify(result));
  } catch (err) {
    console.error("Run failed:", err);
  }
};

// Every hour at minute 2 (UTC). The bot itself skips the run unless a candle just closed.
export const config: Config = { schedule: "2 * * * *" };
