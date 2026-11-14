// Tracks chat viewport following without owning inference or payment state.
import { CHAT_PREVIEW } from './ui/constants';

type ScrollViewport = {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
};

export class PaypalChatScroll {
  private following = true;

  observe(viewport: ScrollViewport) {
    this.following =
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <
      CHAT_PREVIEW.FOLLOW_THRESHOLD;
    return this.following;
  }

  follow(viewport: ScrollViewport) {
    if (this.following) viewport.scrollTop = viewport.scrollHeight;
  }

  latest(viewport: ScrollViewport) {
    this.following = true;
    this.follow(viewport);
  }
}
