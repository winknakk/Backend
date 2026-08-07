export type VerificationStatus = "UNVERIFIED_GUEST" | "VERIFIED_CUSTOMER";

export interface IdentityProps {
  id: string;
  profileId: string;
  channel: string;
  channelRef: string;
  verificationStatus?: VerificationStatus;
  isVerified?: boolean;
  createdAt?: Date;
}

export class Identity {
  public readonly id: string;
  public readonly profileId: string;
  public readonly channel: string;
  public readonly channelRef: string;
  public readonly createdAt: Date;
  private _verificationStatus: VerificationStatus;
  private _isVerified: boolean;

  constructor(props: IdentityProps) {
    if (!props.id) throw new Error("Identity ID is required");
    if (!props.profileId) throw new Error("Profile ID is required");
    if (!props.channel) throw new Error("Identity channel is required");
    if (!props.channelRef) throw new Error("Identity channelRef is required");

    this.id = props.id;
    this.profileId = props.profileId;
    this.channel = props.channel;
    this.channelRef = props.channelRef;
    this.createdAt = props.createdAt || new Date();
    this._verificationStatus = props.verificationStatus || "UNVERIFIED_GUEST";
    this._isVerified = props.isVerified ?? false;
  }

  get verificationStatus(): VerificationStatus {
    return this._verificationStatus;
  }

  get isVerified(): boolean {
    return this._isVerified;
  }

  public verifyCustomer(): void {
    this._verificationStatus = "VERIFIED_CUSTOMER";
    this._isVerified = true;
  }
}
