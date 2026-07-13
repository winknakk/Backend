import { BaseEntity } from "../../shared/domain/BaseEntity";

export interface ProfileProps {
  id: string;
  companyId?: string | null;
  name?: string | null;
  createdAt?: Date;
  metadata?: Record<string, any>;
}

export class Profile extends BaseEntity<string> {
  public readonly companyId: string | null;
  public readonly name: string | null;
  public readonly createdAt: Date;
  public readonly metadata: Record<string, any>;

  constructor(props: ProfileProps) {
    super(props.id);

    this.companyId = props.companyId || null;
    this.name = props.name || null;
    this.createdAt = props.createdAt || new Date();
    this.metadata = props.metadata || {};
  }
}
