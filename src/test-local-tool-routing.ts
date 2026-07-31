import assert from "assert";
import { z } from "zod";
import { ToolRegistry } from "./tools/ToolRegistry";
import { ITool } from "./tools/types";

function fakeTool(name: string, source: "local" | "promptx"): ITool {
  return {
    name,
    definition: {
      name,
      description: `${source} test tool`,
      inputSchema: { type: "object", properties: {} },
      source,
    },
    inputSchema: z.object({}).passthrough(),
    outputSchema: z.object({}).passthrough(),
    async execute() {
      return { source };
    },
  };
}

async function run(): Promise<void> {
  const registry = new ToolRegistry();
  const local = fakeTool("close_ticket", "local");
  const remote = fakeTool("promptx.close_ticket_Em1M", "promptx");

  registry.registerTool(local);
  registry.registerTool(remote);

  assert.strictEqual(
    registry.getTool("close_ticket"),
    remote,
    "agent routing should continue preferring the deployed PromptX tool"
  );
  assert.strictEqual(
    registry.getLocalTool("close_ticket"),
    local,
    "internal backend routes must select the exact local implementation"
  );

  console.log("Local tool routing tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
