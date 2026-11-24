export type LaunchLine = { ms: number; step: string; detail: string };

export function createLaunchTrace(now: () => number = () => performance.now()) {
  let origin = now();
  const rows: LaunchLine[] = [];
  return {
    begin() {
      origin = now();
      rows.length = 0;
    },
    note(step: string, detail = "") {
      rows.push({ ms: Math.max(0, Math.round(now() - origin)), step, detail });
      if (rows.length > 40) {
        rows.shift();
      }
    },
    rows(): readonly LaunchLine[] {
      return rows;
    },
    text(): string[] {
      return rows.map((row) => `+${row.ms}ms ${row.step}${row.detail ? ` ${row.detail}` : ""}`);
    },
  };
}
