/**
 * ValueObject is an immutable object whose identity is defined by its properties.
 * Comparison is performed using strict deep equality.
 */
export abstract class ValueObject<TProps> {
  /** The immutable properties of the value object */
  protected readonly props: TProps;

  /**
   * Initializes a new ValueObject, freezing its properties for immutability.
   *
   * @param props - The properties of the value object.
   */
  constructor(props: TProps) {
    this.props = Object.freeze(this.deepClone(props) as TProps);
  }

  /**
   * Checks equality of two ValueObject instances based on deep equality of properties.
   *
   * @param other - The other value object to compare.
   * @returns True if the properties are deeply equal.
   */
  public equals(other?: ValueObject<TProps>): boolean {
    if (other === null || other === undefined) {
      return false;
    }
    if (other.props === undefined) {
      return false;
    }
    return this.deepEquals(this.props, other.props);
  }

  /**
   * Recursively clones properties to guarantee immutability.
   */
  private deepClone(val: unknown): unknown {
    if (val === null || val === undefined) {
      return val;
    }
    if (val instanceof Date) {
      return new Date(val.getTime());
    }
    if (Array.isArray(val)) {
      return val.map((item) => this.deepClone(item));
    }
    if (typeof val === "object") {
      const obj = val as Record<string, unknown>;
      const clone = Object.create(Object.getPrototypeOf(val));
      for (const key of Object.keys(obj)) {
        clone[key] = this.deepClone(obj[key]);
      }
      return clone;
    }
    return val;
  }

  /**
   * Performs recursive deep equality comparison of two values.
   */
  private deepEquals(a: unknown, b: unknown): boolean {
    if (a === b) return true;

    if (a instanceof Date && b instanceof Date) {
      return a.getTime() === b.getTime();
    }

    if (a === null || a === undefined || b === null || b === undefined) {
      return false;
    }

    if (typeof a !== "object" || typeof b !== "object") {
      return false;
    }

    const objA = a as Record<string, unknown>;
    const objB = b as Record<string, unknown>;

    const keysA = Object.keys(objA);
    const keysB = Object.keys(objB);

    if (keysA.length !== keysB.length) return false;

    for (const key of keysA) {
      if (!keysB.includes(key)) return false;
      if (!this.deepEquals(objA[key], objB[key])) return false;
    }

    return true;
  }
}
