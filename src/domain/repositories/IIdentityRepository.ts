import { Identity } from "../entities/Identity";

export interface IIdentityRepository {
  findById(id: string): Promise<Identity | null>;
  findByChannelAndRef(channel: string, channelRef: string): Promise<Identity | null>;
  save(identity: Identity): Promise<Identity>;
}
