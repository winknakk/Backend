import { TenantService } from "./tenant/TenantService";

function assert(condition: any, message: string): void {
  if (!condition) throw new Error(message);
}

async function run() {
  const service = new TenantService();
  const tenant = await service.getTenantConfig("1");
  assert(tenant.companyId === "1", "Expected tenant 1 to validate.");
  assert(tenant.projects.length > 0, "Expected tenant projects to be present.");

  let denied = false;
  try {
    await service.getTenantConfig("missing");
  } catch {
    denied = true;
  }
  assert(denied, "Expected missing tenant validation to fail.");

  console.log("test-tenants passed");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
