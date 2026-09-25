/**
 * LINE stickers the bot sends (operator selection, 2026-09-24).
 *
 * Every sticker here is from LINE's Messaging API sticker list — the only
 * stickers a bot may send; purchased packs cannot be sent. IDs were checked
 * against each pack's productInfo.meta on 2026-09-24.
 *
 * A sticker always goes BEFORE the text in the same push, so a message's
 * quick-reply chips stay on the text bubble (operator decision).
 */
import type { CustomerNotificationType } from "./CustomerNotificationService";

export interface LineSticker {
  packageId: string;
  stickerId: string;
  /** What the sticker shows; written to the conversation record. */
  name: string;
}

const s = (packageId: string, stickerId: string, name: string): LineSticker => ({ packageId, stickerId, name });

export const STICKERS = {
  hello: s("6359", "11069853", "Hello?"),
  celebrate: s("11537", "52002734", "บราวน์จุดพลุ"),
  gotIt: s("8522", "16581280", "GOT IT!"),
  please: s("8522", "16581281", "PLEASE…?"),
  howAboutIt: s("8522", "16581270", "HOW ABOUT IT?"),
  nana: s("6359", "11069859", "นะๆๆ"),
  thankYou: s("8522", "16581267", "THANK YOU!"),
  sorryForTrouble: s("8522", "16581283", "SORRY FOR THE TROUBLE"),
  soSorry: s("8522", "16581274", "I'M SO SORRY.."),
  sweat: s("11537", "52002770", "บราวน์เหงื่อตก"),
  ofCourse: s("8522", "16581278", "OF COURSE!"),
  thumbsUp: s("11537", "52002735", "โคนี่ยกนิ้ว"),
  hearts: s("11537", "52002736", "แซลลี่หัวใจ"),
  hug: s("8522", "16581277", "บราวน์กอดหัวใจ"),
  goodNight: s("8522", "16581285", "GOOD NIGHT"),
  cheerful: s("11537", "52002741", "แซลลี่ร่าเริง"),
} as const;

/** Backend notifications that carry a sticker. Anything not listed never does. */
export const NOTIFICATION_STICKERS: Partial<Record<CustomerNotificationType, LineSticker>> = {
  greeting: STICKERS.hello,
  ticket_created: STICKERS.gotIt,
  waiting_customer: STICKERS.please,
  resolution_confirmation: STICKERS.howAboutIt,
  resolution_nudge: STICKERS.nana,
  closed: STICKERS.thankYou,
  reopened: STICKERS.sorryForTrouble,
  due_extension_notice: STICKERS.soSorry,
  ai_timeout_fallback: STICKERS.sweat,
  thanks: STICKERS.ofCourse,
  sticker_reminder: STICKERS.please,
};

/** Onboarding outcomes that mean "your project is linked". */
export const PROJECT_LINKED_REASONS = new Set(["valid_project_code", "project_switch_completed", "single_destination_project"]);

/**
 * Stickers the customer can trigger again and again (typing "สวัสดี" three
 * times, a sticker ping-pong) wait this long after any bot sticker. Case
 * events — created, delivered, closed, re-opened … — happen once each and
 * always carry theirs, so a quick "ใช้งานได้แล้ว" still gets its THANK YOU.
 */
export const STICKER_MIN_INTERVAL_MINUTES = 10;
export const THROTTLED_STICKER_TYPES: ReadonlySet<CustomerNotificationType> = new Set<CustomerNotificationType>([
  "greeting",
  "thanks",
  "sticker_reply",
  "sticker_reminder",
]);

export type StickerMood = "angry" | "sad" | "night" | "hello" | "thanks" | "love" | "ok" | "other";

// Negative moods first: a "sorry, angry" sticker must never get a party back.
const MOOD_RULES: Array<[StickerMood, RegExp]> = [
  ["angry", /angry|anger|mad|annoy|furious|rage|grr|irritat|hmph|โกรธ|หงุดหงิด|โมโห|เซ็ง|ไม่พอใจ/i],
  ["sad", /sad|cry|crying|tear|upset|depress|sob|ร้องไห้|เศร้า|เสียใจ|น้อยใจ/i],
  ["night", /night|sleep|bed|zzz|tired|ฝันดี|นอน|ง่วง|ราตรี/i],
  ["hello", /hello|\bhi\b|\bhey\b|morning|greet|สวัสดี|หวัดดี|ดีค่ะ|ดีครับ/i],
  ["thanks", /thank|thx|appreciat|ขอบคุณ|ขอบใจ|แต๊งกิ้ว/i],
  ["love", /love|heart|kiss|รัก|หัวใจ|จุ๊บ/i],
  ["ok", /\bok\b|okay|good|great|like|yes|thumb|cool|nice|got it|perfect|โอเค|ได้เลย|เยี่ยม|ดีมาก|สุดยอด|ตกลง/i],
];

/**
 * Reads a customer's sticker from what LINE sends with it: `keywords` (only
 * some stickers, mostly English) and `text` (message stickers only). The
 * picture itself is never seen, so anything unreadable is "other".
 */
export function classifyStickerMood(keywords: unknown, text?: unknown): StickerMood {
  const words = [
    ...(Array.isArray(keywords) ? keywords.map((k) => String(k || "")) : []),
    String(text || ""),
  ].join(" ");
  if (!words.trim()) return "other";
  for (const [mood, re] of MOOD_RULES) if (re.test(words)) return mood;
  return "other";
}

export const MOOD_STICKERS: Record<StickerMood, LineSticker> = {
  ok: STICKERS.thumbsUp,
  thanks: STICKERS.ofCourse,
  love: STICKERS.hearts,
  sad: STICKERS.hug,
  angry: STICKERS.sorryForTrouble,
  night: STICKERS.goodNight,
  hello: STICKERS.hello,
  other: STICKERS.cheerful,
};

/** Only an annoyed customer gets words with the sticker. */
export const ANGRY_FOLLOW_UP = "ถ้ามีอะไรติดขัด พิมพ์เล่ามาได้เลยนะคะ ทีมงานพร้อมช่วยค่ะ";

export function stickerMessage(sticker: LineSticker): Record<string, unknown> {
  return { type: "sticker", packageId: sticker.packageId, stickerId: sticker.stickerId };
}

/** The line written to `messages` for a sticker, readable in the admin chat. */
export function stickerRecord(sticker: LineSticker): string {
  return `[สติกเกอร์: ${sticker.name}]`;
}

/** The customer's sticker as a `messages` row. */
export function customerStickerRecord(keywords: unknown, text?: unknown): string {
  const t = String(text || "").trim();
  if (t) return `[สติกเกอร์] ${t}`;
  const k = Array.isArray(keywords) ? keywords.slice(0, 5).map((x) => String(x)).filter(Boolean) : [];
  return k.length ? `[สติกเกอร์] (${k.join(", ")})` : "[สติกเกอร์]";
}
