import { bootstrap, toolRegistry } from "./api/server";

async function runDiscoveryTest() {
  console.log("=========================================");
  console.log("  AutomationX V2 Tool Discovery Test     ");
  console.log("=========================================\n");

  // Call the server's bootstrap to trigger local registration and remote discovery
  await bootstrap();

  const registeredTools = toolRegistry.listTools();
  console.log(`\nRegistered Tools Count: ${registeredTools.length}`);

  console.log("\nDetails of Registered Tools:");
  registeredTools.forEach((tool, index) => {
    console.log(`\nTool #${index + 1}:`);
    console.log(`- Name: ${tool.definition.name}`);
    console.log(`- Source: ${tool.definition.source || "local"}`);
    console.log(`- Version: ${tool.definition.version || "1.0.0"}`);
    console.log(`- Description: ${tool.definition.description}`);
    console.log(`- Schema Properties: ${JSON.stringify(Object.keys(tool.definition.inputSchema.properties))}`);
  });

  // Verify core tools exist
  const coreTools = ["create_ticket", "search_project_docs", "activepieces.nocodb_create_record"];
  let allCoreExist = true;

  for (const core of coreTools) {
    const tool = toolRegistry.getTool(core);
    if (tool) {
      console.log(`\n✅ Core tool '${core}' is verified and present.`);
    } else {
      console.error(`\n❌ Core tool '${core}' is MISSING from registry.`);
      allCoreExist = false;
    }
  }

  // Check namespace requirements for remote tools
  let dynamicRemoteToolsFound = 0;
  for (const tool of registeredTools) {
    if (tool.definition.name.startsWith("promptx.")) {
      dynamicRemoteToolsFound++;
    }
  }

  console.log(`\nFound ${dynamicRemoteToolsFound} namespaced remote tools starting with 'promptx.'`);

  if (allCoreExist) {
    console.log("\n✅ Tool Discovery Test PASSED!");
  } else {
    console.error("\n❌ Tool Discovery Test FAILED due to missing core tools.");
    process.exit(1);
  }
}

runDiscoveryTest().catch((err) => {
  console.error(err);
  process.exit(1);
});
