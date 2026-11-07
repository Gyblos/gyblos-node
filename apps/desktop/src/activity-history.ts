// Serializes private activity metadata. Failures never change or retry payment operations.
import {
  parseActivityResult,
  type ActivityEntry,
  type ActivityResult,
  type SessionActivity,
} from './activity-model';
import { DESKTOP_ACTIVITY } from './constants';

type Files = {
  read(): Promise<string | undefined>;
  write(text: string): Promise<void>;
};
export class ActivityHistory {
  private entries: ActivityEntry[] = [];
  private loaded = false;
  private available = true;
  private pending = Promise.resolve();
  constructor(
    private readonly files: Files,
    private readonly now: () => number = Date.now,
  ) {}
  private async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const text = await this.files.read();
      if (text === undefined) return;
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('Invalid history');
      const record = Object.fromEntries(Object.entries(value));
      if (
        Object.keys(record).sort().join(',') !== 'sessions,version' ||
        record.version !== DESKTOP_ACTIVITY.VERSION
      )
        throw new Error('Invalid history');
      const result = parseActivityResult({
        available: true,
        currentSessionId: null,
        sessions: record.sessions,
      });
      if (!result.available) throw new Error('Invalid history');
      this.entries = result.sessions;
    } catch {
      this.available = false;
    }
  }
  observe(value: SessionActivity | null) {
    const captured = value ? { ...value } : null;
    this.pending = this.pending
      .then(async () => {
        await this.load();
        if (!captured) return;
        const old = this.entries.find((entry) => entry.id === captured.id);
        if (
          old &&
          Object.entries(captured).every(([key, value]) =>
            Object.entries(old).some(
              ([oldKey, oldValue]) => key === oldKey && value === oldValue,
            ),
          )
        )
          return;
        const now = this.now();
        const next = {
          ...captured,
          firstObservedAt: old?.firstObservedAt ?? now,
          updatedAt: Math.max(old?.updatedAt ?? now, now),
        };
        this.entries = [
          ...this.entries.filter((entry) => entry.id !== next.id),
          next,
        ];
        if (this.entries.length > DESKTOP_ACTIVITY.MAX_SESSIONS) {
          this.available = false;
          this.entries = this.entries.slice(-DESKTOP_ACTIVITY.MAX_SESSIONS);
        }
        if (!this.available) return;
        try {
          await this.files.write(
            JSON.stringify({
              version: DESKTOP_ACTIVITY.VERSION,
              sessions: this.entries,
            }),
          );
        } catch {
          this.available = false;
        }
      })
      .catch(() => {
        this.available = false;
      });
    return this.pending;
  }
  async summary(currentSessionId: string | null): Promise<ActivityResult> {
    await this.pending;
    await this.load();
    return {
      available: this.available,
      currentSessionId,
      sessions: this.entries.map((entry) => ({ ...entry })),
    };
  }
}
