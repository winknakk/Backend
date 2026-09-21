/** READ-ONLY: ทำไม 12:14 ไม่เข้า deterministic handler แต่ 13:16 เข้า (ข้อความเดียวกันเป๊ะ) */
import { detectCancelIntent, CANCEL_TICKET_PATTERN } from "./domain/ticket/CustomerConfirmation";

const REAL = "แอดมินคะ ขอยกเลิกเคส TCK-2026-73046 ให้หน่อยค่ะ คุยกับเจ้าหน้าที่แล้วไม่ต้องย้อนสถานะแล้วค่ะ";

const CASES: string[] = [
  REAL,
  "ขอยกเลิกเคส TCK-2026-73046 ให้หน่อยค่ะ",
  "ขอยกเลิกเคส TCK-2026-73046",
  "ยกเลิกเคส TCK-2026-73046",
  "แอดมินคะ ขอยกเลิกเคส TCK-2026-73046",
  "ขอยกเลิกเคส TCK-2026-73046 ค่ะ คุยกับเจ้าหน้าที่แล้ว",
  "สวัสดีค่ะ ขอยกเลิกเคสหน่อยค่ะ",
  "ไม่เอาแล้วค่ะ ขอยกเลิกเคส",
  "ยกเลิกเคสให้หน่อย",
  "ยืนยันยกเลิกเคส TCK-2026-73046",
];

console.log("ข้อความจริงจากเดโม 12:14:13 / 13:16:39 (เหมือนกันทุกตัวอักษร)\n");
for (const t of CASES) {
  const i = detectCancelIntent(t, false);
  const raw = t.replace(/\s+/g, " ").trim();
  console.log(
    `${(i.kind === "NONE" ? "✗ NONE " : "✓ " + i.kind).padEnd(20)} regex=${String(CANCEL_TICKET_PATTERN.test(raw)).padEnd(5)} num=${String(i.ticketNumber).padEnd(15)} "${t}"`
  );
}
