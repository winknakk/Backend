import { InboundMessage } from "../schemas/validation";
import { RedisSessionManager, GroupSessionState } from "../memory/RedisSessionManager";
import { createLogger } from "../observability/logger";

const logger = createLogger("ConversationResolver");

export class ConversationResolver {
  private sessionManager: RedisSessionManager;

  constructor(sessionManager = new RedisSessionManager()) {
    this.sessionManager = sessionManager;
  }

  /**
   * Resolves whether the inbound message is allowed to trigger the bot.
   * Applying the state-aware hybrid group conversation policy.
   */
  async shouldProcess(message: InboundMessage, conversationId: string): Promise<{
    shouldProcess: boolean;
    reason: string;
    session?: GroupSessionState;
  }> {
    const channelLower = message.channel.toLowerCase();
    
    // Only LINE_GROUP or line_group channel is restricted by group mention/session policy
    if (channelLower !== "line_group" && channelLower !== "line_group") {
      return { shouldProcess: true, reason: "bypass_non_group_channel" };
    }

    const isMentioned = message.isMentioned === true;
    const participantId = message.senderRef || message.senderId;

    const existingSession = await this.sessionManager.getSession(conversationId);

    if (isMentioned) {
      // 1. If explicitly mentioned, create or join the session
      if (!existingSession) {
        const newSession = await this.sessionManager.createSession(conversationId, participantId);
        return { shouldProcess: true, reason: "session_created_by_mention", session: newSession };
      } else {
        const updatedSession = await this.sessionManager.addParticipant(conversationId, participantId);
        return { shouldProcess: true, reason: "participant_joined_by_mention", session: updatedSession || existingSession };
      }
    }

    // 2. If not mentioned:
    if (!existingSession) {
      logger.info({ conversationId, participantId }, "Group message skipped: no active session and not mentioned");
      return { shouldProcess: false, reason: "no_active_session_and_not_mentioned" };
    }

    // Check if sender is an active participant in the session
    const isParticipant = existingSession.activeParticipants.includes(participantId);
    if (!isParticipant) {
      logger.info({ conversationId, participantId }, "Group message skipped: session active but sender is not a participant");
      return { shouldProcess: false, reason: "sender_not_in_active_participants" };
    }

    // If active participant, refresh the session and allow processing
    await this.sessionManager.refreshSession(conversationId);
    return { shouldProcess: true, reason: "session_active_participant_follow_up", session: existingSession };
  }
}
