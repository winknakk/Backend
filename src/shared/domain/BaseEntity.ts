/**
 * BaseEntity represents a domain entity with a unique identifier.
 * Two entities are equal if they have the same ID.
 */
export abstract class BaseEntity<TId = string> {
  /**
   * Initializes a new BaseEntity instance.
   *
   * @param id - The unique identity of the entity.
   */
  constructor(public readonly id: TId) {
    if (id === null || id === undefined) {
      throw new Error("[Domain] Entity ID cannot be null or undefined");
    }
  }

  /**
   * Checks value equality between two Entity instances.
   *
   * @param other - The other entity to compare.
   * @returns True if the entity IDs match.
   */
  public equals(other?: BaseEntity<TId>): boolean {
    if (other === null || other === undefined) {
      return false;
    }
    if (this === other) {
      return true;
    }
    return this.id === other.id;
  }
}
