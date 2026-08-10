import { config } from "../config/env";
import {
  buildLineOnboardingCarousel,
  LineOnboardingCarouselService,
} from "../services/LineOnboardingCarouselService";

function argument(name: string): string | undefined {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const command = process.argv[2] || "preview";
  const service = new LineOnboardingCarouselService(
    config.LINE_CHANNEL_ACCESS_TOKEN,
    config.BACKEND_PUBLIC_URL
  );

  if (command === "preview") {
    process.stdout.write(
      `${JSON.stringify({
        message: buildLineOnboardingCarousel(config.BACKEND_PUBLIC_URL),
        cards: service.inspectLocalCards(),
      }, null, 2)}\n`
    );
    return;
  }
  if (command === "verify-public") {
    await service.verifyPublicCards();
    process.stdout.write("All four public LINE onboarding card images are reachable.\n");
    return;
  }
  if (command === "push") {
    const userId = String(argument("user-id") || "").trim();
    await service.push(userId);
    process.stdout.write("LINE onboarding image carousel pushed to the requested user.\n");
    return;
  }
  if (command === "broadcast") {
    if (argument("confirm-broadcast") !== "SEND_TO_ALL_FRIENDS") {
      throw new Error("Broadcast requires --confirm-broadcast=SEND_TO_ALL_FRIENDS");
    }
    await service.broadcast();
    process.stdout.write("LINE onboarding image carousel broadcast accepted by LINE.\n");
    return;
  }
  throw new Error("Command must be preview, verify-public, push, or broadcast");
}

main().catch((error: any) => {
  const status = error?.response?.status;
  const lineMessage = error?.response?.data?.message;
  process.stderr.write(
    `${status ? `LINE HTTP ${status}: ` : ""}${lineMessage || error.message || "Carousel command failed"}\n`
  );
  process.exitCode = 1;
});
