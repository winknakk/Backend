import * as fs from "fs";
import * as path from "path";
import { AbTestWeight } from "../../schemas/aiops";

export class TrafficSplitter {
  private weights = new Map<string, AbTestWeight>();
  private filePath: string;

  constructor(filePath = path.resolve(__dirname, "../../../data/ab_test_weights.json")) {
    this.filePath = filePath;
    this.loadWeights();
  }

  getWeights(tenantId: string, promptName: string): AbTestWeight | undefined {
    const key = `${tenantId}:${promptName}`;
    return this.weights.get(key);
  }

  setWeights(weight: AbTestWeight): void {
    // Validate weights sum to 1
    const totalWeight = weight.variants.reduce((acc, v) => acc + v.weight, 0);
    if (Math.abs(totalWeight - 1.0) > 0.001) {
      throw new Error(`Total variants weight must sum to 1.0 (got ${totalWeight.toFixed(3)})`);
    }

    const key = `${weight.tenantId}:${weight.promptName}`;
    this.weights.set(key, weight);
    this.saveWeights();
  }

  /**
   * Routes a request to a variant based on configured weights.
   * Returns the version name, or undefined/default if not configured.
   */
  route(tenantId: string, promptName: string): string | undefined {
    const weightConfig = this.getWeights(tenantId, promptName);
    if (!weightConfig || weightConfig.variants.length === 0) {
      return undefined;
    }

    const r = Math.random();
    let cumulativeWeight = 0;

    for (const variant of weightConfig.variants) {
      cumulativeWeight += variant.weight;
      if (r <= cumulativeWeight) {
        return variant.version;
      }
    }

    // Fallback to the last variant if random number selection bounds issues
    return weightConfig.variants[weightConfig.variants.length - 1].version;
  }

  private loadWeights(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, "utf-8");
        const parsed = JSON.parse(raw);
        for (const key of Object.keys(parsed)) {
          this.weights.set(key, parsed[key]);
        }
      }
    } catch (e) {
      console.warn("[TrafficSplitter] Failed to load A/B weights:", e);
    }
  }

  private saveWeights(): void {
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const data: Record<string, AbTestWeight> = {};
      for (const [k, v] of this.weights.entries()) {
        data[k] = v;
      }
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf-8");
    } catch (e) {
      console.warn("[TrafficSplitter] Failed to save A/B weights:", e);
    }
  }
}
