import { runBot } from "../lib/bot.mts";

// Manual test: https://YOUR-SITE.netlify.app/.netlify/functions/run-now?token=SECRET
// Add &force=1 to ignore the "candle just closed" check.
// With DRY_RUN=true (default) it only reports what it WOULD do.
export default async (req: Request) => {
  const url = new URL(req.url);
  const secret = process.env.RUN_TOKEN;
  if (!secret || url.searchParams.get("token") !== secret)
    return new Response("Unauthorized", { status: 401 });
  try {
    const result = await runBot({ force: url.searchParams.get("force") === "1" });
    return Response.json(result);
  } catch (err) {
    return Response.json({ error: String(err) }, { status: 500 });
  }
};
