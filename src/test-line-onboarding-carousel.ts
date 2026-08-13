import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  buildLineChoicePrompt,
  buildLineOnboardingCarousel,
  buildLineProjectLinkConfirmation,
  buildLineProjectMenu,
  inspectCarouselPng,
  LINE_DESIGN,
  LINE_ONBOARDING_CARDS,
  LINE_ONBOARDING_CARD_SIZE,
  lineOnboardingCardVersion,
  lineOnboardingCardDirectory,
} from "./services/LineOnboardingCarouselService";

function postbackData(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(postbackData);
  const record = value as Record<string, unknown>;
  const own = record.type === "postback" && typeof record.data === "string" ? [record.data] : [];
  return [...own, ...Object.values(record).flatMap(postbackData)];
}

function boxesWithCornerRadius(value: unknown, radius: string): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((item) => boxesWithCornerRadius(item, radius));
  const record = value as Record<string, unknown>;
  const own = record.type === "box" && record.cornerRadius === radius ? [record] : [];
  return [...own, ...Object.values(record).flatMap((item) => boxesWithCornerRadius(item, radius))];
}

function textValues(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(textValues);
  const record = value as Record<string, unknown>;
  const own = record.type === "text" && typeof record.text === "string" ? [record.text] : [];
  return [...own, ...Object.values(record).flatMap(textValues)];
}

const message = buildLineOnboardingCarousel("https://support.example.com") as any;
assert.equal(message.type, "flex");
assert.equal(message.contents.type, "carousel");
assert.equal(message.contents.contents.length, 4);
assert.deepEqual(
  message.contents.contents.map((bubble: any) => bubble.hero.action.data),
  LINE_ONBOARDING_CARDS.map((card) => card.postbackData)
);
for (const [index, bubble] of message.contents.contents.entries()) {
  assert.equal(bubble.type, "bubble");
  assert.equal(bubble.hero.type, "image");
  assert.equal(bubble.hero.aspectRatio, "1:1");
  assert.equal(
    bubble.hero.url,
    `https://support.example.com/api/v1/media/line-onboarding/cards/${LINE_ONBOARDING_CARDS[index].fileName}?v=${lineOnboardingCardVersion(LINE_ONBOARDING_CARDS[index].fileName)}`
  );
  assert.match(bubble.hero.url, /\?v=[0-9a-f]{12}$/);
  assert.equal(bubble.footer.contents[0].cornerRadius, "xxl");
  assert.equal(bubble.footer.contents[0].backgroundColor, LINE_DESIGN.action);
  assert.equal(bubble.footer.contents[0].action.data, LINE_ONBOARDING_CARDS[index].postbackData);
}
assert.equal((message as any).template, undefined);
assert.throws(() => buildLineOnboardingCarousel("http://support.example.com"), /HTTPS/);

const choice = buildLineChoicePrompt("เลือกวิธีเชื่อมโปรเจกต์ได้เลยค่ะ", [
  { label: "มีรหัสโปรเจกต์", data: "ticketx:onboarding:has_code" },
  { label: "ไม่มี/ไม่ทราบรหัส", data: "ticketx:onboarding:no_code" },
]) as any;
assert.equal(choice.type, "flex");
assert.equal(choice.quickReply, undefined, "Flex choices must not duplicate their actions as Quick Reply buttons");
assert.deepEqual(postbackData(choice).sort(), [
  "ticketx:onboarding:has_code",
  "ticketx:onboarding:no_code",
].sort());
assert.equal(boxesWithCornerRadius(choice, "xxl").length, 2);

const projectMenu = buildLineProjectMenu({
  kind: "selector",
  projects: [
    {
      projectId: 8,
      projectName: "24/7",
      companyName: "Avalant Co.,Ltd.",
      projectType: "Support Project",
      environment: "Avalant 24/7 Production",
      isCurrent: true,
    },
    {
      projectId: 101,
      projectName: "EXC03 - ระบบสารสนเทศกรมสรรพสามิต",
      companyName: "กรมสรรพสามิต",
      projectType: "Enterprise Application",
      environment: "Production",
      isCurrent: false,
    },
  ],
  page: 0,
  totalPages: 2,
  notice: "เลือกโปรเจกต์ได้เลยค่ะ",
}) as any[];
assert.equal(projectMenu.length, 1, "Project intro and controls must stay in one LINE message");
assert.equal(projectMenu[0].type, "flex");
assert.equal(projectMenu[0].contents.type, "carousel");
assert.equal(projectMenu[0].contents.contents.length, 4);
assert.deepEqual(postbackData(projectMenu[0]), [
  "ticketx:onboarding:switch_project:8",
  "ticketx:onboarding:switch_project:101",
  "ticketx:onboarding:menu:connect_new",
  "ticketx:onboarding:projects_page:1",
]);
assert.ok(boxesWithCornerRadius(projectMenu[0], "xl").length >= 4);
assert.ok(boxesWithCornerRadius(projectMenu[0], "xxl").length >= 4);
assert.ok(textValues(projectMenu[0]).includes("เลือกโปรเจกต์ได้เลยค่ะ"));
assert.ok(textValues(projectMenu[0]).some((text) => text.includes("บริษัท: กรมสรรพสามิต")));
assert.ok(textValues(projectMenu[0]).some((text) => text.includes("ประเภท: Enterprise Application")));
assert.ok(textValues(projectMenu[0]).some((text) => text.includes("สภาพแวดล้อม: Production")));

const linkConfirmation = buildLineProjectLinkConfirmation({
  currentProjectId: 8,
  currentProjectName: "24/7",
  linkedProjectId: 11,
  linkedProjectName: "SSO Project",
  linkedCompanyName: "Avalant Co.,Ltd.",
  linkedProjectType: "Support Project",
  linkedEnvironment: "SSO Production",
}) as any;
assert.equal(linkConfirmation.type, "flex");
assert.deepEqual(postbackData(linkConfirmation), [
  "ticketx:onboarding:switch_project:11",
  "ticketx:onboarding:switch_project:8",
]);
assert.equal(boxesWithCornerRadius(linkConfirmation, "xxl").length, 2);
assert.ok(textValues(linkConfirmation).some((text) => text.includes("บริษัท: Avalant Co.,Ltd.")));

for (const card of LINE_ONBOARDING_CARDS) {
  const directory = lineOnboardingCardDirectory();
  const metadata = inspectCarouselPng(path.join(directory, card.fileName));
  assert.equal(metadata.width, LINE_ONBOARDING_CARD_SIZE);
  assert.equal(metadata.height, LINE_ONBOARDING_CARD_SIZE);
  assert.ok(metadata.bytes > 0);
  assert.ok(metadata.bytes < 1024 * 1024, `${card.fileName} should stay below LINE's recommended 1 MB`);

  const svg = fs.readFileSync(path.join(directory, card.fileName.replace(/\.png$/, ".svg")), "utf8");
  assert.match(svg, /#F8F9FB/);
  assert.match(svg, /#20242D/);
  assert.doesNotMatch(svg, /linearGradient/);
}

process.stdout.write("LINE onboarding unified Flex design contract tests passed.\n");
