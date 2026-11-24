import {
  MAX_CLIENT_LOG_LINES,
  clientLogMessage,
  type ClientLogMessage,
} from "../protocol/parse.ts";

const MAX_PENDING = 500;
const FLUSH_MS = 1000;

export { FLUSH_MS as CLIENT_LOG_FLUSH_MS };

export type ClientLog = {
  setEnabled(enabled: boolean): void;
  enabled(): boolean;
  noteUnsupported(): void;
  push(message: string, at?: Date): void;
  flush(send: (message: ClientLogMessage) => boolean): ClientLogMessage[];
};

function stamp(at: Date): string {
  return at.toISOString().slice(11, 23);
}

export function createClientLog(options?: { enabled?: boolean }): ClientLog {
  let enabled = options?.enabled ?? false;
  let supported = true;
  let lines: string[] = [];
  let dropped = 0;

  return {
    setEnabled(next) {
      enabled = next;
      if (!next) {
        lines = [];
        dropped = 0;
      }
    },
    enabled() {
      return enabled && supported;
    },
    noteUnsupported() {
      supported = false;
      lines = [];
      dropped = 0;
    },
    push(message, at = new Date()) {
      if (!supported || !enabled) {
        return;
      }
      lines.push(`${stamp(at)} ${message}`);
      if (lines.length > MAX_PENDING) {
        dropped += lines.length - MAX_PENDING;
        lines = lines.slice(lines.length - MAX_PENDING);
      }
    },
    flush(send) {
      if (!supported || !enabled || lines.length === 0) {
        return [];
      }
      if (dropped > 0) {
        lines.unshift(`${dropped} TV log line(s) dropped while the PC was unreachable`);
        dropped = 0;
      }
      const sent: ClientLogMessage[] = [];
      while (lines.length > 0) {
        const batch = lines.slice(0, MAX_CLIENT_LOG_LINES);
        const message = clientLogMessage(batch);
        if (!send(message)) {
          return sent;
        }
        lines = lines.slice(batch.length);
        sent.push(message);
      }
      return sent;
    },
  };
}
