// Coordinates local display-history hydration and autosave; never calls model or payment services.
import {
  parseChatArchiveLoad,
  parseChatArchiveStatus,
  projectChatArchive,
  unavailableChatArchive,
  type ChatArchiveLoad,
  type ChatArchivePort,
} from '../chat-archive-model';
import {
  CHAT_STORAGE,
  CHAT_STORAGE_STATE,
  type ChatArchiveState,
} from '../constants';
import type { ChatController } from './chat-controller';

export class ChatArchiveClient {
  private active = false;
  private generation = 0;
  private sequence = 0;
  private saved = 0;
  private last = '';
  private blocked = false;
  private remove = () => {};
  private loadTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  constructor(
    private readonly chat: ChatController,
    private readonly bridge: ChatArchivePort | undefined,
    private readonly onState: (state: ChatArchiveState) => void,
  ) {}
  async start() {
    this.active = true;
    this.chat.setRestoring(true);
    this.onState(CHAT_STORAGE_STATE.LOADING);
    const failed: ChatArchiveLoad = {
      ...unavailableChatArchive(),
      archive: null,
    };
    const result = await Promise.race([
      Promise.resolve()
        .then(() => this.bridge?.load())
        .then(parseChatArchiveLoad)
        .catch(() => failed),
      new Promise<ChatArchiveLoad>((resolve) => {
        this.loadTimer = setTimeout(
          () => resolve(failed),
          CHAT_STORAGE.LOAD_TIMEOUT_MS,
        );
      }),
    ]);
    clearTimeout(this.loadTimer);
    if (!this.active) return;
    if (result.archive) this.chat.restoreArchive(result.archive);
    this.chat.setRestoring(false);
    this.generation = result.available ? result.generation : 0;
    this.onState(
      result.available
        ? CHAT_STORAGE_STATE.SAVED
        : CHAT_STORAGE_STATE.UNAVAILABLE,
    );
    this.remove = this.chat.subscribe(this.save);
    this.pollTimer = setInterval(() => {
      void this.refresh();
    }, CHAT_STORAGE.POLL_MS);
  }
  private update = (value: unknown) => {
    if (!this.active || !this.generation) return;
    const result = parseChatArchiveStatus(value);
    if (!result.available || result.generation !== this.generation) {
      this.generation = 0;
      this.onState(CHAT_STORAGE_STATE.UNAVAILABLE);
      return;
    }
    this.saved = Math.max(this.saved, result.savedSequence);
    if (!this.blocked) this.markSaved();
  };
  private markSaved() {
    this.onState(
      this.saved >= this.sequence
        ? CHAT_STORAGE_STATE.SAVED
        : CHAT_STORAGE_STATE.SAVING,
    );
  }
  private save = () => {
    if (!this.active || !this.bridge || !this.generation) return;
    const archive = projectChatArchive(this.chat.getSnapshot());
    if (!archive) {
      this.blocked = true;
      this.onState(CHAT_STORAGE_STATE.UNAVAILABLE);
      return;
    }
    this.blocked = false;
    const encoded = JSON.stringify(archive);
    if (this.last === encoded) {
      this.markSaved();
      return;
    }
    this.last = encoded;
    this.sequence++;
    this.onState(CHAT_STORAGE_STATE.SAVING);
    void this.bridge
      .save({ generation: this.generation, sequence: this.sequence, archive })
      .then(this.update)
      .catch(() => this.update(unavailableChatArchive()));
  };
  async refresh() {
    if (
      this.active &&
      this.bridge &&
      this.generation &&
      this.saved < this.sequence
    ) {
      try {
        this.update(await this.bridge.status());
      } catch {
        this.update(unavailableChatArchive());
      }
    }
  }
  close = () => {
    this.active = false;
    this.remove();
    this.chat.setRestoring(false);
    clearTimeout(this.loadTimer);
    clearInterval(this.pollTimer);
  };
}
