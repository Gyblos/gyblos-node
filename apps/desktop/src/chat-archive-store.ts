// Holds descriptive conversations and coalesces private writes; never restores live operations.
import {
  parseChatArchive,
  parseChatArchiveSave,
  type ChatArchive,
  type ChatArchiveLoad,
  type ChatArchiveStatus,
} from './chat-archive-model';

type Files = {
  read(): Promise<string | undefined>;
  write(text: string): Promise<void>;
  writePins?(pins: readonly string[]): Promise<void>;
  readPins?(): Promise<readonly string[]>;
};
export class ChatArchiveStore {
  private archive: ChatArchive | null = null;
  private available = true;
  private pinsUnavailable = false;
  private pinsReadFailed = false;
  private embeddedPins = new Set<string>();
  private storedPins: string | undefined;
  private generation = 0;
  private acceptedSequence = 0;
  private savedSequence = 0;
  private initialized = false;
  private opening: Promise<void> | null = null;
  private loading: Promise<ChatArchiveLoad> | null = null;
  private writing = Promise.resolve();
  private pending: {
    archive: ChatArchive;
    pins: string[];
    sequence: number;
    generation: number;
  } | null = null;
  private draining = false;
  private closed = false;
  constructor(private readonly files: Files) {}
  private initialize() {
    this.opening ??= (async () => {
      try {
        const text = await this.files.read();
        if (text !== undefined) {
          const value: unknown = JSON.parse(text);
          this.archive = parseChatArchive(value);
          if (!this.archive) this.available = false;
          else if (this.files.readPins) {
            this.embeddedPins = new Set(
              this.archive.sessions
                .filter((session) => session.pinned)
                .map((session) => session.id),
            );
            try {
              const ids = await this.files.readPins();
              this.storedPins = JSON.stringify(ids);
              const pins = new Set(ids);
              for (const session of this.archive.sessions)
                if (pins.has(session.id)) session.pinned = true;
            } catch {
              this.pinsReadFailed = true;
              this.pinsUnavailable = true;
            }
          }
        }
      } catch {
        this.available = false;
      }
      this.initialized = true;
    })();
    return this.opening;
  }
  load(): Promise<ChatArchiveLoad> {
    this.loading ??= this.loadArchive().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }
  private async loadArchive(): Promise<ChatArchiveLoad> {
    await this.initialize();
    await this.writing;
    this.generation++;
    this.acceptedSequence = 0;
    this.savedSequence = 0;
    return {
      ...this.status(),
      available: this.available && !this.closed,
      archive: structuredClone(this.archive),
    };
  }
  status(): ChatArchiveStatus {
    return {
      available:
        this.initialized && this.available && !this.closed && !this.loading,
      generation: this.generation,
      savedSequence: this.savedSequence,
      ...(this.pinsUnavailable && { pinsUnavailable: true }),
    };
  }
  save(value: unknown): ChatArchiveStatus {
    const request = parseChatArchiveSave(value);
    if (
      !request ||
      !this.status().available ||
      request.generation !== this.generation ||
      request.sequence <= this.acceptedSequence
    )
      return { ...this.status(), available: false };
    this.archive = request.archive;
    this.acceptedSequence = request.sequence;
    this.pending = {
      archive: request.archive,
      pins: request.archive.sessions
        .filter((item) => item.pinned)
        .map((item) => item.id),
      sequence: request.sequence,
      generation: request.generation,
    };
    this.drain();
    return this.status();
  }
  private drain() {
    if (this.draining) return;
    this.draining = true;
    this.writing = (async () => {
      try {
        while (this.pending) {
          const next = this.pending;
          this.pending = null;
          const migrating =
            this.embeddedPins.size > 0 && !!this.files.writePins;
          if (migrating) await this.savePins(next.pins);
          const archive = next.archive;
          const sessions = this.files.writePins
            ? archive.sessions.map(({ pinned: _pinned, ...session }) =>
                migrating &&
                this.pinsUnavailable &&
                this.embeddedPins.has(session.id)
                  ? { ...session, pinned: true }
                  : session,
              )
            : archive.sessions;
          await this.files.write(JSON.stringify({ ...archive, sessions }));
          if (migrating && !this.pinsUnavailable) this.embeddedPins.clear();
          if (!migrating) await this.savePins(next.pins);
          if (next.generation === this.generation)
            this.savedSequence = next.sequence;
        }
      } catch {
        this.available = false;
        this.pending = null;
      } finally {
        this.draining = false;
      }
    })();
  }
  private async savePins(pins: readonly string[]) {
    const encoded = JSON.stringify(pins);
    if (
      this.pinsReadFailed ||
      !this.files.writePins ||
      encoded === this.storedPins
    )
      return;
    try {
      await this.files.writePins(pins);
      this.storedPins = encoded;
      this.pinsUnavailable = false;
    } catch {
      this.storedPins = undefined;
      this.pinsUnavailable = true;
    }
  }
  settled = () => this.writing;
  async close() {
    this.closed = true;
    await this.opening;
    await this.loading;
    await this.writing;
  }
}
