export interface ProfileProps {
  id: string;
  companyId?: string | null;
  name?: string | null;
  createdAt?: Date;
}

export class Profile {
  public readonly id: string;
  public readonly companyId: string | null;
  public readonly name: string | null;
  public readonly createdAt: Date;

  constructor(props: ProfileProps) {
    if (!props.id) throw new Error("Profile ID is required");
    this.id = props.id;
    this.companyId = props.companyId || null;
    this.name = props.name || null;
    this.createdAt = props.createdAt || new Date();
  }
}
