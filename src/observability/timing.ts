/**
 * Start a high-resolution timer.
 * Returns a function that, when called, returns the elapsed time in milliseconds.
 */
export function startTimer(): () => number {
  const start = process.hrtime.bigint();
  return () => {
    const end = process.hrtime.bigint();
    return Number(end - start) / 1_000_000; // milliseconds
  };
}
