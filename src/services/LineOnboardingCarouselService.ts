import axios from "axios";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  LineProjectLinkConfirmation,
  LineProjectMenu,
  LineQuickReply,
} from "./LineProjectOnboardingService";

export const LINE_ONBOARDING_CARD_SIZE = 1024;
export const LINE_ONBOARDING_CARD_MAX_BYTES = 10 * 1024 * 1024;

export const LINE_DESIGN = {
  background: "#F8F9FB",
  surface: "#FFFFFF",
  text: "#20242D",
  muted: "#667085",
  border: "#E1E4EA",
  primary: "#4B5FC7",
  primarySoft: "#E9ECF8",
  success: "#137A54",
  successSoft: "#E8F5EF",
  action: "#202A44",
} as const;

export const LINE_ONBOARDING_CARDS = [
  {
    fileName: "start.png",
    label: "เริ่มใช้งาน",
    postbackData: "ticketx:onboarding:menu:start",
  },
  {
    fileName: "connect.png",
    label: "เชื่อม",
    postbackData: "ticketx:onboarding:menu:connect",
  },
  {
    fileName: "connect-new.png",
    label: "เชื่อมใหม่",
    postbackData: "ticketx:onboarding:menu:connect_new",
  },
  {
    fileName: "change.png",
    label: "เปลี่ยน",
    postbackData: "ticketx:onboarding:menu:change",
  },
] as const;

export interface PngMetadata {
  width: number;
  height: number;
  bytes: number;
}

export function lineOnboardingCardDirectory(): string {
  return path.resolve(__dirname, "../../assets/line-onboarding");
}

export function inspectCarouselPng(imagePath: string): PngMetadata {
  const image = fs.readFileSync(imagePath);
  const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (image.length < 24 || !image.subarray(0, 8).equals(pngSignature)) {
    throw new Error(`${path.basename(imagePath)} must be a PNG file`);
  }
  const metadata = {
    width: image.readUInt32BE(16),
    height: image.readUInt32BE(20),
    bytes: image.length,
  };
  if (metadata.width !== LINE_ONBOARDING_CARD_SIZE || metadata.height !== LINE_ONBOARDING_CARD_SIZE) {
    throw new Error(
      `${path.basename(imagePath)} must be ${LINE_ONBOARDING_CARD_SIZE}x${LINE_ONBOARDING_CARD_SIZE}px`
    );
  }
  if (metadata.bytes > LINE_ONBOARDING_CARD_MAX_BYTES) {
    throw new Error(`${path.basename(imagePath)} exceeds LINE's 10 MB image limit`);
  }
  return metadata;
}

function normalizedPublicUrl(publicUrl: string): string {
  const parsed = new URL(publicUrl);
  if (parsed.protocol !== "https:") throw new Error("BACKEND_PUBLIC_URL must use HTTPS for LINE images");
  return parsed.toString().replace(/\/$/, "");
}

export function lineOnboardingCardVersion(fileName: string): string {
  const image = fs.readFileSync(path.join(lineOnboardingCardDirectory(), fileName));
  return crypto.createHash("sha256").update(image).digest("hex").slice(0, 12);
}

function postbackAction(label: string, data: string, showSelection = false): Record<string, unknown> {
  return {
    type: "postback",
    label,
    data,
    ...(showSelection ? { displayText: label } : {}),
  };
}

function actionPill(options: {
  label: string;
  data: string;
  tone?: "dark" | "outline";
  showSelection?: boolean;
  flex?: number;
}): Record<string, unknown> {
  const outline = options.tone === "outline";
  return {
    type: "box",
    layout: "vertical",
    flex: options.flex ?? 0,
    backgroundColor: outline ? LINE_DESIGN.surface : LINE_DESIGN.action,
    borderColor: outline ? LINE_DESIGN.border : LINE_DESIGN.action,
    borderWidth: "normal",
    cornerRadius: "xxl",
    paddingTop: "11px",
    paddingBottom: "11px",
    paddingStart: "14px",
    paddingEnd: "14px",
    action: postbackAction(options.label, options.data, options.showSelection),
    contents: [
      {
        type: "text",
        text: options.label,
        align: "center",
        color: outline ? LINE_DESIGN.text : "#FFFFFF",
        size: "sm",
        weight: "bold",
        adjustMode: "shrink-to-fit",
      },
    ],
  };
}

export function buildLineChoicePrompt(
  text: string,
  quickReplies: LineQuickReply[]
): Record<string, unknown> {
  return {
    type: "flex",
    altText: text,
    contents: {
      type: "bubble",
      size: "kilo",
      styles: { body: { backgroundColor: LINE_DESIGN.background } },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "10px",
        contents: [
          {
            type: "box",
            layout: "vertical",
            spacing: "md",
            backgroundColor: LINE_DESIGN.surface,
            borderColor: LINE_DESIGN.border,
            borderWidth: "normal",
            cornerRadius: "xl",
            paddingAll: "18px",
            contents: [
              {
                type: "text",
                text: "TicketX Support",
                size: "xs",
                weight: "bold",
                color: LINE_DESIGN.primary,
              },
              {
                type: "text",
                text,
                size: "sm",
                color: LINE_DESIGN.text,
                wrap: true,
                maxLines: 8,
              },
              {
                type: "box",
                layout: "horizontal",
                spacing: "sm",
                margin: "md",
                contents: quickReplies.map((item) =>
                  actionPill({
                    label: item.label,
                    data: item.data,
                    showSelection: true,
                    flex: 1,
                  })
                ),
              },
            ],
          },
        ],
      },
    },
  };
}

export function buildLineOnboardingCarousel(publicUrl: string): Record<string, unknown> {
  const baseUrl = normalizedPublicUrl(publicUrl);
  return {
    type: "flex",
    altText: "เมนูเริ่มใช้งานและจัดการโปรเจกต์ TicketX",
    contents: {
      type: "carousel",
      contents: LINE_ONBOARDING_CARDS.map((card) => ({
        type: "bubble",
        size: "kilo",
        styles: {
          hero: { backgroundColor: LINE_DESIGN.background },
          footer: { backgroundColor: LINE_DESIGN.surface },
        },
        hero: {
          type: "image",
          url: `${baseUrl}/api/v1/media/line-onboarding/cards/${card.fileName}?v=${lineOnboardingCardVersion(card.fileName)}`,
          size: "full",
          aspectRatio: "1:1",
          aspectMode: "cover",
          action: postbackAction(card.label, card.postbackData),
        },
        footer: {
          type: "box",
          layout: "vertical",
          paddingTop: "14px",
          paddingBottom: "16px",
          paddingStart: "16px",
          paddingEnd: "16px",
          contents: [
            actionPill({ label: card.label, data: card.postbackData }),
          ],
        },
      })),
    },
  };
}

function shortLabel(value: string, maxLength = 36): string {
  const characters = Array.from(String(value || ""));
  return characters.length <= maxLength
    ? characters.join("")
    : `${characters.slice(0, Math.max(1, maxLength - 1)).join("")}…`;
}

function projectBubble(
  project: LineProjectMenu["projects"][number],
  notice?: string
): Record<string, unknown> {
  const details = [
    `Project ID: ${project.projectId}`,
    `บริษัท: ${shortLabel(project.companyName, 54)}`,
    `ประเภท: ${shortLabel(project.projectType, 54)}`,
    `สภาพแวดล้อม: ${shortLabel(project.environment, 54)}`,
  ].join("\n");
  return {
    type: "bubble",
    size: "kilo",
    styles: { body: { backgroundColor: LINE_DESIGN.background } },
    body: {
      type: "box",
      layout: "vertical",
      paddingAll: "10px",
      contents: [
        {
          type: "box",
          layout: "vertical",
          spacing: "md",
          backgroundColor: LINE_DESIGN.surface,
          borderColor: project.isCurrent ? LINE_DESIGN.primary : LINE_DESIGN.border,
          borderWidth: project.isCurrent ? "medium" : "normal",
          cornerRadius: "xl",
          paddingAll: "18px",
          contents: [
            {
              type: "text",
              text: project.isCurrent ? "กำลังใช้งาน ✓" : "โปรเจกต์",
              size: "xs",
              weight: "bold",
              color: project.isCurrent ? LINE_DESIGN.primary : LINE_DESIGN.muted,
            },
            {
              type: "text",
              text: shortLabel(project.projectName, 80),
              size: "lg",
              weight: "bold",
              color: LINE_DESIGN.text,
              wrap: true,
              maxLines: 3,
            },
            {
              type: "text",
              text: details,
              size: "xs",
              color: LINE_DESIGN.muted,
              wrap: true,
              maxLines: 8,
            },
            {
              type: "text",
              text: notice || (project.isCurrent ? "โปรเจกต์ที่ใช้ในแชทนี้" : "เลือกใช้โปรเจกต์นี้"),
              size: "sm",
              color: LINE_DESIGN.muted,
              wrap: true,
              maxLines: 4,
            },
            {
              ...actionPill({
                label: project.isCurrent ? "กำลังใช้งาน" : "ใช้โปรเจกต์นี้",
                data: `ticketx:onboarding:switch_project:${project.projectId}`,
              }),
              margin: "lg",
            },
          ],
        },
      ],
    },
  };
}

function connectNewBubble(): Record<string, unknown> {
  return {
    type: "bubble",
    size: "kilo",
    styles: { body: { backgroundColor: LINE_DESIGN.background } },
    body: {
      type: "box",
      layout: "vertical",
      paddingAll: "10px",
      contents: [
        {
          type: "box",
          layout: "vertical",
          spacing: "md",
          backgroundColor: LINE_DESIGN.surface,
          borderColor: LINE_DESIGN.border,
          borderWidth: "normal",
          cornerRadius: "xl",
          paddingAll: "18px",
          contents: [
            {
              type: "text",
              text: "เพิ่มสิทธิ์การใช้งาน",
              size: "xs",
              weight: "bold",
              color: LINE_DESIGN.success,
            },
            {
              type: "text",
              text: "เชื่อมโปรเจกต์ใหม่",
              size: "lg",
              weight: "bold",
              color: LINE_DESIGN.text,
              wrap: true,
            },
            {
              type: "text",
              text: "ใช้รหัสโปรเจกต์ หรือให้เจ้าหน้าที่ช่วยตรวจสอบ",
              size: "sm",
              color: LINE_DESIGN.muted,
              wrap: true,
            },
            {
              ...actionPill({
                label: "เชื่อมโปรเจกต์ใหม่",
                data: "ticketx:onboarding:menu:connect_new",
              }),
              margin: "lg",
            },
          ],
        },
      ],
    },
  };
}

function navigationBubble(page: number, totalPages: number): Record<string, unknown> {
  const actions: Array<Record<string, unknown>> = [];
  if (page > 0) {
    actions.push(
      actionPill({
        label: "หน้าก่อนหน้า",
        data: `ticketx:onboarding:projects_page:${page - 1}`,
        tone: "outline",
      })
    );
  }
  if (page + 1 < totalPages) {
    actions.push(
      actionPill({
        label: "หน้าถัดไป",
        data: `ticketx:onboarding:projects_page:${page + 1}`,
      })
    );
  }
  return {
    type: "bubble",
    size: "kilo",
    styles: { body: { backgroundColor: LINE_DESIGN.background } },
    body: {
      type: "box",
      layout: "vertical",
      paddingAll: "10px",
      contents: [
        {
          type: "box",
          layout: "vertical",
          spacing: "md",
          backgroundColor: LINE_DESIGN.surface,
          borderColor: LINE_DESIGN.border,
          borderWidth: "normal",
          cornerRadius: "xl",
          paddingAll: "18px",
          contents: [
            { type: "text", text: "โปรเจกต์เพิ่มเติม", size: "lg", weight: "bold", color: LINE_DESIGN.text },
            { type: "text", text: `หน้า ${page + 1} จาก ${totalPages}`, size: "sm", color: LINE_DESIGN.muted },
            ...actions.map((action, index) => ({ ...action, margin: index === 0 ? "lg" : "sm" })),
          ],
        },
      ],
    },
  };
}

export function buildLineProjectMenu(menu: LineProjectMenu): Array<Record<string, unknown>> {
  const heading = menu.kind === "selector"
    ? "เลือกโปรเจกต์ที่ต้องการใช้งานได้เลยค่ะ"
    : "โปรเจกต์ที่บัญชีนี้เชื่อมอยู่ค่ะ";
  const bubbles: Array<Record<string, unknown>> = [
    ...menu.projects.map((project, index) => projectBubble(project, index === 0 ? menu.notice : undefined)),
    connectNewBubble(),
  ];
  if (menu.totalPages > 1) bubbles.push(navigationBubble(menu.page, menu.totalPages));
  return [
    {
      type: "flex",
      altText: menu.notice ? `${menu.notice} ${heading}` : heading,
      contents: { type: "carousel", contents: bubbles },
    },
  ];
}

export function buildLineProjectLinkConfirmation(
  confirmation: LineProjectLinkConfirmation
): Record<string, unknown> {
  const linkedDetails = [
    `Project ID: ${confirmation.linkedProjectId}`,
    `บริษัท: ${shortLabel(confirmation.linkedCompanyName, 54)}`,
    `ประเภท: ${shortLabel(confirmation.linkedProjectType, 54)}`,
    `สภาพแวดล้อม: ${shortLabel(confirmation.linkedEnvironment, 54)}`,
  ].join("\n");
  return {
    type: "flex",
    altText: `เชื่อมโปรเจกต์ ${confirmation.linkedProjectName} แล้ว`,
    contents: {
      type: "bubble",
      size: "kilo",
      styles: { body: { backgroundColor: LINE_DESIGN.background } },
      body: {
        type: "box",
        layout: "vertical",
        paddingAll: "10px",
        contents: [
          {
            type: "box",
            layout: "vertical",
            spacing: "md",
            backgroundColor: LINE_DESIGN.surface,
            borderColor: LINE_DESIGN.border,
            borderWidth: "normal",
            cornerRadius: "xl",
            paddingAll: "18px",
            contents: [
              { type: "text", text: "เชื่อมโปรเจกต์สำเร็จ ✓", size: "xs", weight: "bold", color: LINE_DESIGN.success },
              { type: "text", text: shortLabel(confirmation.linkedProjectName, 80), size: "xl", weight: "bold", color: LINE_DESIGN.text, wrap: true },
              { type: "text", text: linkedDetails, size: "xs", color: LINE_DESIGN.muted, wrap: true, maxLines: 8 },
              {
                type: "text",
                text: `ตอนนี้ยังใช้โปรเจกต์ “${shortLabel(confirmation.currentProjectName, 80)}” อยู่ค่ะ ต้องการเปลี่ยนไปโปรเจกต์ใหม่เลยไหมคะ`,
                size: "sm",
                color: LINE_DESIGN.muted,
                wrap: true,
              },
              {
                ...actionPill({
                  label: "เปลี่ยนไปโปรเจกต์ใหม่",
                  data: `ticketx:onboarding:switch_project:${confirmation.linkedProjectId}`,
                }),
                margin: "lg",
              },
              {
                ...actionPill({
                  label: "ใช้โปรเจกต์เดิม",
                  data: `ticketx:onboarding:switch_project:${confirmation.currentProjectId}`,
                  tone: "outline",
                }),
                margin: "sm",
              },
            ],
          },
        ],
      },
    },
  };
}

export class LineOnboardingCarouselService {
  constructor(
    private readonly channelAccessToken: string,
    private readonly publicUrl: string
  ) {
    if (!channelAccessToken.trim()) throw new Error("LINE_CHANNEL_ACCESS_TOKEN is required");
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.channelAccessToken.trim()}`,
      "Content-Type": "application/json",
    };
  }

  inspectLocalCards(): Array<{ fileName: string; metadata: PngMetadata }> {
    const directory = lineOnboardingCardDirectory();
    return LINE_ONBOARDING_CARDS.map((card) => ({
      fileName: card.fileName,
      metadata: inspectCarouselPng(path.join(directory, card.fileName)),
    }));
  }

  async verifyPublicCards(): Promise<void> {
    const message = buildLineOnboardingCarousel(this.publicUrl) as any;
    for (const bubble of message.contents.contents) {
      const response = await axios.get(bubble.hero.url, {
        responseType: "arraybuffer",
        timeout: 10000,
      });
      if (!String(response.headers["content-type"] || "").startsWith("image/png")) {
        throw new Error(`Public card did not return image/png: ${bubble.hero.url}`);
      }
      const fileName = new URL(bubble.hero.url).pathname.split("/").pop() || "";
      const local = fs.readFileSync(path.join(lineOnboardingCardDirectory(), fileName));
      const remote = Buffer.from(response.data);
      if (!crypto.timingSafeEqual(crypto.createHash("sha256").update(local).digest(), crypto.createHash("sha256").update(remote).digest())) {
        throw new Error(`Public card content does not match the local asset: ${fileName}`);
      }
    }
  }

  async push(userId: string): Promise<void> {
    if (!/^U[0-9a-f]{32}$/i.test(userId)) throw new Error("A valid LINE user ID is required");
    await this.verifyPublicCards();
    await axios.post(
      "https://api.line.me/v2/bot/message/push",
      { to: userId, messages: [buildLineOnboardingCarousel(this.publicUrl)] },
      { headers: this.headers, timeout: 10000 }
    );
  }

  async broadcast(): Promise<void> {
    await this.verifyPublicCards();
    await axios.post(
      "https://api.line.me/v2/bot/message/broadcast",
      { messages: [buildLineOnboardingCarousel(this.publicUrl)] },
      { headers: this.headers, timeout: 10000 }
    );
  }
}
