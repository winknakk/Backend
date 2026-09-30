/**
 * LINE voice messages (2026-09-28): the pure decisions of VoiceTranscriptionService.
 * No database, no network. Run: npx tsx src/test-voice-transcription.ts
 */
import assert from "node:assert/strict";
import { isSilenceTranscript, parseTranscriptResponse, typedAnswerDecision, voiceCommandText } from "./services/VoiceTranscriptionService";
import { PROJECT_RELINK_COMMAND_TEXTS } from "./services/LineProjectOnboardingService";

let failures = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err: any) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${err.message}`);
  }
}

const CLOSE_CHIPS = [
  { label: "ยืนยันปิดเคส", text: "ยืนยันปิดเคส TCK-2026-0001" },
  { label: "ยังไม่ปิด", text: "ยังไม่ปิด" },
];

console.log("silence / hallucination");
check("empty is silence", () => assert.equal(isSilenceTranscript("  "), true));
check("Whisper outro is silence", () => assert.equal(isSilenceTranscript("ขอบคุณที่รับชมค่ะ"), true));
check("English outro is silence", () => assert.equal(isSilenceTranscript("Thank you for watching!"), true));
check("a real thanks is not silence", () => assert.equal(isSilenceTranscript("ขอบคุณค่ะ"), false));
check("a report is not silence", () => assert.equal(isSilenceTranscript("เข้าระบบไม่ได้ค่ะ ขึ้น error 500"), false));

console.log("flow response parsing");
check("{ text }", () => assert.equal(parseTranscriptResponse({ text: " สวัสดีค่ะ " }), "สวัสดีค่ะ"));
check("nested body.text", () => assert.equal(parseTranscriptResponse({ body: { text: "ok" } }), "ok"));
check("plain string", () => assert.equal(parseTranscriptResponse("hello"), "hello"));
check("garbage → empty", () => assert.equal(parseTranscriptResponse({ foo: 1 }), ""));
check("null → empty", () => assert.equal(parseTranscriptResponse(null), ""));

console.log("voice never confirms");
check("pending question → its chips back", () =>
  assert.deepEqual(typedAnswerDecision("ใช่ค่ะ", CLOSE_CHIPS), CLOSE_CHIPS));
check("pending question, even an unrelated report → chips back", () =>
  assert.deepEqual(typedAnswerDecision("เข้าระบบไม่ได้ค่ะ", CLOSE_CHIPS), CLOSE_CHIPS));
check("explicit ยืนยันปิดเคส with nothing pending → type/tap", () =>
  assert.deepEqual(typedAnswerDecision("ยืนยันปิดเคส TCK-2026-0001", null), []));
check("explicit ยืนยันยกเลิกเคส → type/tap", () =>
  assert.deepEqual(typedAnswerDecision("ยืนยันยกเลิกเคส TCK-2026-0001", null), []));
check("explicit ยืนยันเปิดเคสอีกครั้ง → type/tap", () =>
  assert.deepEqual(typedAnswerDecision("ยืนยันเปิดเคสอีกครั้ง TCK-2026-0001", null), []));
check("pending without rebuildable chips ([]) + explicit confirm → type/tap", () =>
  assert.deepEqual(typedAnswerDecision("ยืนยันปิดเคส", []), []));
check("close REQUEST passes (it only asks a question)", () =>
  assert.equal(typedAnswerDecision("ขอปิดเคสค่ะ", null), null));
check("cancel REQUEST passes", () =>
  assert.equal(typedAnswerDecision("ขอยกเลิกเคส TCK-2026-0001 ค่ะ", null), null));
check("ordinary report passes", () =>
  assert.equal(typedAnswerDecision("พิมพ์ใบเสร็จไม่ออกค่ะ", null), null));
check("bare ใช่ with nothing pending passes (handler ignores it)", () =>
  assert.equal(typedAnswerDecision("ใช่ค่ะ", null), null));

console.log("spoken menu commands");
const COMMANDS = PROJECT_RELINK_COMMAND_TEXTS;
check("เมนู", () => assert.equal(voiceCommandText("เมนู", COMMANDS), "เมนู"));
check("เมนูค่ะ.", () => assert.equal(voiceCommandText("เมนูค่ะ.", COMMANDS), "เมนู"));
check("Menu", () => assert.equal(voiceCommandText("Menu.", COMMANDS), "เมนู"));
check("เปลี่ยนโปรเจ็คหน่อยครับ", () => assert.equal(voiceCommandText("เปลี่ยนโปรเจ็คหน่อยครับ", COMMANDS), "เปลี่ยนโปรเจกต์"));
check("เชื่อมโปรเจคใหม่นะคะ", () => assert.equal(voiceCommandText("เชื่อมโปรเจคใหม่นะคะ", COMMANDS), "เชื่อมโปรเจกต์ใหม่"));
check("เริ่มใช้งานค่ะ", () => assert.equal(voiceCommandText("เริ่มใช้งานค่ะ", COMMANDS), "เริ่มใช้งาน"));
check("a report mentioning the menu is not a command", () =>
  assert.equal(voiceCommandText("กดเมนูแล้วไม่ขึ้นอะไรเลยค่ะ", COMMANDS), null));
check("ordinary report is not a command", () => assert.equal(voiceCommandText("เข้าระบบไม่ได้ค่ะ", COMMANDS), null));

if (failures > 0) {
  console.error(`\n${failures} voice-transcription check(s) failed`);
  process.exit(1);
}
console.log("\nAll voice-transcription checks passed");
process.exit(0);
