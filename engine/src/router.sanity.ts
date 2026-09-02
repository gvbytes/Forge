// ── Router sanity check ────────────────────────────────────────────────────
// Prints three sample decisions across different roles/complexities.
// No network needed: registry.list() falls back to the curated zen list from
// settings, and if even that is empty decideRoute() returns a placeholder
// decision instead of throwing. Run with:
//   npx tsx src/router.sanity.ts

import { decideRoute } from "./router.js";

async function main(): Promise<void> {
  const samples: { title: string; input: Parameters<typeof decideRoute>[0] }[] = [
    {
      title: "1 · explorer / trivial lookup — expect a fast tier-1 model",
      input: {
        sessionId: "s-sanity-explorer",
        role: "explorer",
        userPrompt: "where is the login handler defined?",
        contextTokens: 6_000,
        tokensUsedSoFar: 12_000,
        costUsedSoFarUsd: 0,
      },
    },
    {
      title: "2 · coder / heavy refactor + repeated 429s on one model — expect preemption",
      input: {
        sessionId: "s-sanity-coder",
        role: "coder",
        userPrompt: `Refactor the auth middleware in server/src/auth.ts and sessions.ts to support rotating refresh tokens.

\`\`\`ts
export async function refresh(req: Request): Promise<Response> {
  // TODO rotate token here
}
\`\`\`

Then update router.ts to wire it and add tests.`,
        contextTokens: 45_000,
        tokensUsedSoFar: 180_000,
        costUsedSoFarUsd: 0,
        recentErrors: [
          "429 rate limited: deepseek-v4-flash-free",
          "llm.call failed 429 quota exceeded (deepseek-v4-flash-free)",
          "429 rate limited: muse-spark-1.2-contributor-free",
          "429 slow down: muse-spark-1.2-contributor-free",
        ],
      },
    },
    {
      title: "3 · planner / huge context — expect a longctx model after the ×1.3 ctx gate",
      input: {
        sessionId: "s-sanity-planner",
        role: "planner",
        userPrompt:
          "Architect a migration of the whole monorepo from REST to an event-driven pipeline; produce a step-by-step plan covering indexing, trace bus, approvals and diff review.",
        contextTokens: 700_000,
        tokensUsedSoFar: 900_000,
        costUsedSoFarUsd: 0,
        budgetCapUsd: 0.5,
      },
    },
  ];

  for (const s of samples) {
    const decision = await decideRoute(s.input);
    console.log(`\n${"=".repeat(74)}\n${s.title}\n${"-".repeat(74)}`);
    console.log(JSON.stringify(decision, null, 2));
  }
}

main().catch((err) => {
  console.error("router sanity failed:", err);
  process.exit(1);
});
