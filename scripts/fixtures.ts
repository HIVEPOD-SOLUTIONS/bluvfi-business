/**
 * Writes the NEAR AI reviews demo mode replays, into fixtures/nearai/.
 *
 *   npm run fixtures           sign each review locally with the public demo key (source "demo-fixture")
 *   npm run fixtures:record    ask NEAR AI Cloud for real, and keep the exact bytes (source "recorded");
 *                              needs NEAR_AI_API_KEY. Replays then re-run every check, including Intel TDX and NVIDIA.
 */
process.env.BLUVFI_DEMO = "1";
process.env.BLUVFI_PERSIST = "0";
const record = process.argv.includes("--record");

async function main() {
  const { overrideService } = await import("../lib/services");
  const { DEMO_JUDGMENTS, runDemo } = await import("../lib/demo-scenario");
  const { demoBundle, fixturePath, saveFixture } = await import("../lib/demo");
  const { fetchNearAi, verifyNearAiBundle } = await import("../lib/nearai");
  const { buildRequest } = await import("../lib/nearai-core");
  const { NEAR_AI_KEY, NEAR_AI_MODEL } = await import("../lib/config");
  if (record && !NEAR_AI_KEY) throw new Error("Set NEAR_AI_API_KEY to record real reviews.");

  const written: string[] = [];
  overrideService("judge", async (redactedText, facts) => {
    const body = buildRequest(NEAR_AI_MODEL, redactedText, facts);
    const number = Object.keys(DEMO_JUDGMENTS).find((n) => redactedText.includes(`Invoice ${n}`));
    if (!number) throw new Error("Unknown demo invoice");
    const bundle = record ? { ...(await fetchNearAi(body)), source: "recorded" as const } : demoBundle(body, DEMO_JUDGMENTS[number]);
    saveFixture(bundle);
    written.push(`${number} -> ${fixturePath(body)}`);
    return verifyNearAiBundle(bundle);
  });
  await runDemo({ vendorReplies: true });
  console.log(`${record ? "Recorded" : "Signed"} ${written.length} reviews:\n${written.join("\n")}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

export {};
