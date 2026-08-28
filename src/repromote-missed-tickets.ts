/**
 * One-off remediation: re-promote tickets that were created in the DB while the
 * Plane leg failed ("no response" — backend/tunnel was down at 2026-08-27 07:21).
 * Calls planeService directly, bypassing HTTP auth the same way other one-off
 * scripts in this folder do. Safe to re-run: promoteTicketToPlane reports
 * alreadyPromoted when the issue exists.
 *
 * Run from system/backend:  npx tsx src/repromote-missed-tickets.ts
 */
import * as dotenv from "dotenv";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function main() {
  const { PlaneService } = await import("./services/planeService");
  const { AdapterFactory } = await import("./adapters/AdapterFactory");
  const planeService = new PlaneService(AdapterFactory.getAdapter());
  // 2026-08-27 16:51 miss: promote went out with an empty Bearer (broken
  // configs[] template in the Hub) and an empty execution token (queue path).
  const targets = ["TCK-2026-41002"];

  for (const ticketNumber of targets) {
    try {
      const result = await planeService.promoteTicketToPlane({
        ticketId: ticketNumber,
        ticket_number: ticketNumber,
        project_id: 101,
        created_via: "ai",
        // The real HTTP path gets these from the execution context; this direct
        // call must name them itself. Mapping for project 101 lives under org_excise.
        org_id: "org_excise",
        orgId: "org_excise",
        conversation_id: 1193,
      });
      console.log(`[repromote] ${ticketNumber}:`, JSON.stringify(result));
    } catch (err: any) {
      console.error(`[repromote] ${ticketNumber} FAILED:`, err?.message || err);
    }
  }
  process.exit(0);
}

main();
