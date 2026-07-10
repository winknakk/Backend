export interface WebChatSessionProps {
  id: string;
  identityId: string;
  sessionToken: string;
  createdAt?: Date;
  lastActiveAt?: Date;
}

export class WebChatSession {
  public readonly id: string;
  public readonly identityId: string;
  public readonly sessionToken: string;
  public readonly createdAt: Date;
  public readonly lastActiveAt: Date;

  constructor(props: WebChatSessionProps) {
    if (!props.id) throw new Error("WebChatSession ID is required");
    if (!props.identityId) throw new Error("Identity ID is required");
    if (!props.sessionToken) throw new Error("Session token is required");

    this.id = props.id;
    this.identityId = props.identityId;
    this.sessionToken = props.sessionToken;
    this.createdAt = props.createdAt || new Date();
    this.lastActiveAt = props.lastActiveAt || new Date();
  }
}
