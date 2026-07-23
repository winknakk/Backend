import { SmsNotificationService } from "./services/SmsNotificationService";

async function runTest() {
  console.log("=== Testing SmsNotificationService with Simulator ===");

  const smsService = new SmsNotificationService(null);

  // Test simulator execution directly
  process.env.SMS_ENABLED = "true";
  process.env.SMS_HTTP_ENDPOINT = "mock";

  // Mock recipient for test
  smsService.findAdminsForConversation = async () => [
    { id: 14, name: "Admin Good", displayName: "Admin Good", phoneNumber: "0942415642", role: "admin" },
    { id: 15, name: "Admin Win", displayName: "Admin Win", phoneNumber: "0633628242", role: "super_admin" },
  ];

  const result = await smsService.sendTakeoverAlert({
    conversationId: "67",
    customerName: "LINE Customer Somchai",
    reasonCode: "CUSTOMER_REQUESTED_HUMAN",
  });

  console.log("Simulator Alert Result:", result);
  console.log("=== SmsNotificationService Test Completed ===");
}

runTest().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
