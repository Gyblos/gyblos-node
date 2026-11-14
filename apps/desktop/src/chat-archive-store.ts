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
};
export class ChatArchiveStore {
  private archive: ChatArchive | null = null;
  private available = true;
  private generation = 0;
  private acceptedSequence = 0;
  private savedSequence = 0;
  private initialized = false;
  private opening: Promise<void> | null = null;
  private loading: Promise<ChatArchiveLoad> | null = null;
  private writing = Promise.resolve();
  private pending: {
    text: string;
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
      text: JSON.stringify(request.archive),
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
          await this.files.write(next.text);
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
  settled = () => this.writing;
  async close() {
    this.closed = true;
    await this.opening;
    await this.loading;
    await this.writing;
  }
}
