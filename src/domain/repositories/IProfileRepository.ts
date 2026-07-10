import { Profile } from "../entities/Profile";

export interface IProfileRepository {
  findById(id: string): Promise<Profile | null>;
  save(profile: Profile): Promise<Profile>;
}
