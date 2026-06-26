import { TrafficSplitter } from "./aiops/prompt-control/TrafficSplitter";
import { AbTestWeight } from "./schemas/aiops";
import * as fs from "fs";
import * as path from "path";

function assert(condition: any, message: string): void {
  if (!condition) throw new Error(message);
}

async function run() {
  console.log("=========================================");
  console.log("    AutomationX V2 Prompt A/B Testing Tests");
  console.log("=========================================");

  const dataDir = path.resolve(__dirname, "../data");
  const weightsFilePath = path.join(dataDir, "test_ab_weights.json");
  if (fs.existsSync(weightsFilePath)) {
    try {
      fs.unlinkSync(weightsFilePath);
    } catch {}
  }

  const splitter = new TrafficSplitter(weightsFilePath);

  // 1. Route when no weights configured -> should be undefined
  const defaultRoute = splitter.route("tenant-123", "support");
  console.log("Route when unconfigured:", defaultRoute);
  assert(defaultRoute === undefined, "Should return undefined for unconfigured weights.");

  // 2. Set invalid weights (sum is 0.8) -> should throw
  console.log("Testing invalid weights (sum is 0.8)...");
  try {
    splitter.setWeights({
      tenantId: "tenant-123",
      promptName: "support",
      variants: [
        { version: "v1", weight: 0.5 },
        { version: "v2", weight: 0.3 },
      ],
    });
    assert(false, "Should have thrown an error for weights not summing to 1.0.");
  } catch (err: any) {
    console.log("Successfully caught expected error:", err.message);
    assert(err.message.includes("must sum to 1.0"), "Error message should mention sum to 1.0.");
  }

  // 3. Set valid weights (30% v1, 70% v2)
  console.log("Setting valid weights (30% v1, 70% v2)...");
  const validWeights: AbTestWeight = {
    tenantId: "tenant-123",
    promptName: "support",
    variants: [
      { version: "v1", weight: 0.3 },
      { version: "v2", weight: 0.7 },
    ],
  };
  splitter.setWeights(validWeights);

  // 4. Test probability distribution
  console.log("Running 10,000 route tests to verify distribution...");
  let v1Count = 0;
  let v2Count = 0;
  for (let i = 0; i < 10000; i++) {
    const routed = splitter.route("tenant-123", "support");
    if (routed === "v1") v1Count++;
    else if (routed === "v2") v2Count++;
  }

  const v1Ratio = v1Count / 10000;
  const v2Ratio = v2Count / 10000;
  console.log(
    `Distribution results: v1 = ${v1Count} (${(v1Ratio * 100).toFixed(1)}%), v2 = ${v2Count} (${(v2Ratio * 100).toFixed(1)}%)`
  );

  // Ratios should be within a 3% margin of error (0.3 +- 0.03)
  assert(Math.abs(v1Ratio - 0.3) < 0.03, "v1 ratio should be close to 0.3.");
  assert(Math.abs(v2Ratio - 0.7) < 0.03, "v2 ratio should be close to 0.7.");

  // 5. Test persistence
  console.log("Verifying JSON weight persistence...");
  assert(fs.existsSync(weightsFilePath), "Weights file should be saved on disk.");

  // Instantiate new splitter instance pointing to the same file
  const splitter2 = new TrafficSplitter(weightsFilePath);
  const loadedWeights = splitter2.getWeights("tenant-123", "support");
  assert(loadedWeights !== undefined, "Should load previously saved weights.");
  assert(
    loadedWeights!.variants[0].version === "v1" && loadedWeights!.variants[0].weight === 0.3,
    "Loaded weights properties must match."
  );

  // Clean up
  if (fs.existsSync(weightsFilePath)) {
    try {
      fs.unlinkSync(weightsFilePath);
    } catch {}
  }

  console.log("\n✅ All Prompt A/B Testing tests PASSED successfully!");
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
