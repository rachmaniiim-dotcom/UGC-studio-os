const REDACTED = '[REDACTED]';

/**
 * Holds a secret string (e.g. a cookie value) so that it cannot leak through
 * JSON.stringify, String(), template literals or Node's util.inspect.
 * The plaintext is only reachable through reveal().
 */
export class SecretValue {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  equals(other: SecretValue): boolean {
    return this.#value === other.#value;
  }

  get length(): number {
    return this.#value.length;
  }

  toJSON(): string {
    return REDACTED;
  }

  toString(): string {
    return REDACTED;
  }

  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return REDACTED;
  }
}

export { REDACTED };
