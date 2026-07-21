import { AsyncLocalStorage } from "async_hooks";
import { IssueSession } from "./IssueSession";

export class IssueSessionResolver {
  private static storage = new AsyncLocalStorage<IssueSession>();

  /**
   * Runs the given function inside the context of the provided IssueSession.
   */
  static run<T>(session: IssueSession, fn: () => Promise<T>): Promise<T> {
    return this.storage.run(session, fn);
  }

  /**
   * Returns the current active IssueSession in the current execution scope, or null.
   */
  static current(): IssueSession | null {
    return this.storage.getStore() ?? null;
  }
}
