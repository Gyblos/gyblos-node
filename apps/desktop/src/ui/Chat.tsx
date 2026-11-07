// One buyer conversation surface with a shared draft, history and payment provenance.
// USDC remains simulated; real Sandbox requests use the guarded PayPal coordinator.
import {
  ArrowDown,
  ArrowUp,
  ChatCircle,
  Check,
  Clock,
  Code,
  Copy,
  PencilSimple,
  Plus,
  Sparkle,
  Square,
} from '@phosphor-icons/react';
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type Ref,
} from 'react';

import { CHAT_STORAGE_STATE, DESKTOP_ACTIVITY } from '../constants';
import {
  PAYMENT_METHOD,
  paypalDollars,
  type PaymentMethod,
} from '../paypal-model';
import { activityDate, sessionOutcome } from './activity-presentation';
import { modelArtwork } from './announced-models';
import type { ChatController } from './chat-controller';
import { conversationSummary } from './chat-history';
import { canSendPaypal, sendPaypalMessage } from './chat-paypal';
import {
  chatReasoningChoice,
  reasoningLabel,
  type ReasoningSelection,
} from './chat-reasoning';
import { toggleToolSelection, type ChatMessage } from './chat-state';
import { ChatAnswer } from './ChatAnswer';
import { ChatComposer } from './ChatComposer';
import { ToolsDropdown } from './ChatTools';
import { ChatUserMessage } from './ChatUserMessage';
import { BUTTON_VARIANT, CHAT_PREVIEW, CHAT_ROLE } from './constants';
import type { DemoAuthorizationStatus } from './demo-account';
import { Modal } from './Modal';
import { ModelDropdown, type ModelOption } from './ModelDropdown';
import { MotionPresence } from './Motion';
import { ReasoningDropdown } from './ReasoningDropdown';
import { SIGNAL_STATE, SignalMark, SignalTrace } from './Signal';
import { toolName, TOOLS, type ToolId } from './tools';
import {
  Avatar,
  Button,
  IconButton,
  List,
  ListRow,
  Note,
  RowCopy,
  SearchField,
} from './UI';
import type { ActivityView } from './useActivity';
import { chatArchiveLabel } from './useChatArchive';
import type { PaypalSessionView } from './usePaypalSession';

export type ChatHandle = {
  newChat: () => void;
  prefill: (text: string) => void;
  openChat: (id: string) => void;
};
type Props = {
  ref?: Ref<ChatHandle>;
  chat: ChatController;
  storageState: (typeof CHAT_STORAGE_STATE)[keyof typeof CHAT_STORAGE_STATE];
  activity: ActivityView;
  onActivity(id: string): void;
  model: ModelOption;
  online: boolean;
  active?: boolean;
  showToolbar?: boolean;
  connectedTools: ToolId[];
  onBrowseApplications: () => void;
  models: readonly ModelOption[];
  onSelectModel: (id: string) => void;
  onBrowseModels: () => void;
  onReviewPaypal: () => void;
  onAuthorize: () => DemoAuthorizationStatus;
  paymentMethod: PaymentMethod;
  paymentControl: ReactNode;
  paypal: PaypalSessionView;
  onBusyChange: (busy: boolean) => void;
};
type PendingSend = { text: string; tools: ToolId[] };
const QUICK_PROMPTS = [
  {
    icon: Sparkle,
    text: 'Explain an idea',
    prompt: 'Explain how neural networks learn, using a simple example.',
  },
  {
    icon: Code,
    text: 'Build something',
    prompt: 'Help me plan a small project I can build this weekend.',
  },
  {
    icon: ChatCircle,
    text: 'Think it through',
    prompt: 'Help me think through an idea step by step.',
  },
];
type ChatTurn = { id: string; user?: ChatMessage; answer?: ChatMessage };
// Groups each request with the answer it produced so the transcript has turns.
function groupTurns(messages: readonly ChatMessage[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  for (const message of messages) {
    const last = turns.at(-1);
    if (!last || message.role === CHAT_ROLE.USER || last.answer) {
      turns.push({ id: message.id });
    }
    const turn = turns.at(-1);
    if (!turn) continue;
    if (message.role === CHAT_ROLE.USER) turn.user = message;
    else turn.answer = message;
  }
  return turns;
}
export function Chat({
  ref,
  chat,
  storageState,
  activity,
  onActivity,
  model,
  online,
  active = true,
  connectedTools,
  onBrowseApplications,
  models,
  onSelectModel,
  onBrowseModels,
  onReviewPaypal,
  onAuthorize,
  paymentMethod,
  paymentControl,
  paypal,
  onBusyChange,
  showToolbar = true,
}: Props) {
  const { sessions, activeId } = useSyncExternalStore(
    chat.subscribe,
    chat.getSnapshot,
  );
  const session = sessions.find((item) => item.id === activeId)!;
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historySearch, setHistorySearch] = useState('');
  const [selectedTools, setSelectedTools] = useState<ToolId[]>([]);
  const [allowedTools, setAllowedTools] = useState<ToolId[]>([]);
  const [pendingSend, setPendingSend] = useState<PendingSend | null>(null);
  const [details, setDetails] = useState<string | null>(null);
  const [copied, setCopied] = useState('');
  const [reasoning, setReasoning] = useState<ReasoningSelection | null>(null);
  const usingPaypal = paymentMethod === PAYMENT_METHOD.PAYPAL;
  const notice = usingPaypal
    ? paypal.state.notice || session.notice
    : session.notice;
  const [nearBottom, setNearBottom] = useState(true);
  const [modelPulse, setModelPulse] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const composer = useRef<HTMLFormElement>(null);
  const composerOrigin = useRef<DOMRect | null>(null);
  const composerMotion = useRef<Animation | null>(null);
  const previousSession = useRef(activeId);
  const conversationMotion = useRef<Animation | null>(null);
  const conversationOpacity = useRef('0');
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const run = session.run;
  const loadingHistory = storageState === CHAT_STORAGE_STATE.LOADING;
  const busy = Boolean(run || session.paypalRun);
  const canSend =
    !loadingHistory &&
    online &&
    !busy &&
    (!usingPaypal || canSendPaypal(paypal.state));
  const sandboxModel: ModelOption = {
    id: paypal.state.model ?? 'Local model',
    name: paypal.state.model ?? 'Local model',
    image: modelArtwork(paypal.state.model ?? ''),
    free: false,
    input: 0,
    output: 0,
  };
  const composerModel = usingPaypal ? sandboxModel : model;
  const thinking = chatReasoningChoice(composerModel, paymentMethod, reasoning);
  const chosenTools = selectedTools.filter((id) => connectedTools.includes(id));
  const lastUser = [...session.messages]
    .reverse()
    .find((message) => message.role === CHAT_ROLE.USER);
  const turns = groupTurns(session.messages);

  function setDraft(text: string) {
    if (loadingHistory) return;
    chat.setDraft(text);
  }
  function stop() {
    chat.stop();
  }
  function captureComposer() {
    conversationOpacity.current =
      conversationMotion.current?.playState === 'running' && scroller.current
        ? getComputedStyle(scroller.current).opacity
        : '0';
    composerOrigin.current = composer.current?.getBoundingClientRect() ?? null;
  }
  function reset(text = '') {
    if (loadingHistory) return;
    captureComposer();
    const id = crypto.randomUUID();
    chat.newChat(id, text);
    setSelectedTools([]);
    setAllowedTools([]);
    setPendingSend(null);
    setDetails(null);
    follow.current = true;
    setNearBottom(true);
  }
  useImperativeHandle(ref, () => ({
    newChat: () => reset(),
    prefill: (text) => reset(text),
    openChat: (id) => {
      if (!loadingHistory) openSession(id);
    },
  }));

  useEffect(
    () =>
      chat.attachScheduler({
        schedule(callback, delay) {
          const timer = window.setTimeout(callback, delay);
          return () => window.clearTimeout(timer);
        },
      }),
    [chat],
  );
  useEffect(() => chat.setOnline(online), [chat, online]);
  useEffect(() => {
    onBusyChange(
      loadingHistory || sessions.some((item) => !!item.run || !!item.paypalRun),
    );
  }, [sessions, onBusyChange, loadingHistory]);
  useEffect(() => chat.modelChanged(model.free), [chat, model.id, model.free]);
  useEffect(() => {
    if (!active) return;
    function key(event: KeyboardEvent) {
      if (
        event.key === 'Escape' &&
        !event.isComposing &&
        !document.querySelector('dialog[open]')
      )
        stop();
    }
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [active, activeId]);
  useEffect(() => {
    setModelPulse(true);
    const timer = window.setTimeout(
      () => setModelPulse(false),
      CHAT_PREVIEW.MODEL_PULSE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [model.id]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(
      () => setCopied(''),
      CHAT_PREVIEW.COPY_NOTICE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [copied]);
  useLayoutEffect(() => {
    if (!input.current) return;
    input.current.style.height = 'auto';
    input.current.style.height = `${Math.min(CHAT_PREVIEW.INPUT_MAX_HEIGHT, Math.max(CHAT_PREVIEW.INPUT_MIN_HEIGHT, input.current.scrollHeight))}px`;
  }, [session.draft, active]);
  useLayoutEffect(() => {
    if (follow.current && scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [session.messages, active]);

  useLayoutEffect(() => {
    const origin = composerOrigin.current;
    composerOrigin.current = null;
    composerMotion.current?.cancel();
    conversationMotion.current?.cancel();
    const changedSession = previousSession.current !== activeId;
    previousSession.current = activeId;
    if (!origin || !composer.current) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const target = composer.current.getBoundingClientRect();
    const style = getComputedStyle(composer.current);
    composerMotion.current = composer.current.animate(
      [
        {
          transform: `translate(${origin.x - target.x}px, ${origin.y - target.y}px)`,
        },
        { transform: 'translate(0, 0)' },
      ],
      {
        duration: Number.parseFloat(style.getPropertyValue('--motion-push')),
        easing: style.getPropertyValue('--motion-ease').trim(),
      },
    );
    if (changedSession && scroller.current) {
      conversationMotion.current = scroller.current.animate(
        [{ opacity: conversationOpacity.current }, { opacity: 1 }],
        {
          duration: Number.parseFloat(style.getPropertyValue('--motion-push')),
          easing: style.getPropertyValue('--motion-ease').trim(),
        },
      );
    }
  }, [activeId, session.messages.length > 0]);

  function start(text: string, tools: ToolId[]) {
    if (!text.trim() || busy) return;
    if (!session.messages.length) captureComposer();
    const runId = crypto.randomUUID();
    if (!chat.start(text, model, tools, runId, onAuthorize, thinking?.value)) {
      composerOrigin.current = null;
      return;
    }
    follow.current = true;
    setNearBottom(true);
    input.current?.focus();
  }
  function submit() {
    if (!canSend || !session.draft.trim()) return;
    if (usingPaypal) {
      if (!session.messages.length) captureComposer();
      follow.current = true;
      setNearBottom(true);
      void sendPaypalMessage(chat, paypal.chat, crypto.randomUUID());
      return;
    }
    if (chosenTools.some((id) => !allowedTools.includes(id)))
      setPendingSend({ text: session.draft, tools: [...chosenTools] });
    else start(session.draft, chosenTools);
  }
  function openSession(id: string) {
    if (id === activeId) {
      setHistoryOpen(false);
      return;
    }
    captureComposer();
    chat.openChat(id);
    setHistoryOpen(false);
    setSelectedTools([]);
    setAllowedTools([]);
    follow.current = true;
  }
  async function copy(text: string, id: string) {
    const originSession = activeId;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
    } catch {
      chat.setNotice(
        'Copy is unavailable. You can select the response text instead.',
        originSession,
      );
    }
  }
  const history = sessions
    .filter((item) => item.messages.length || item.draft.trim())
    .filter((item) =>
      item.title.toLowerCase().includes(historySearch.toLowerCase()),
    )
    .slice()
    .reverse();
  return (
    <main className="chat-page enhanced-chat">
      {storageState === CHAT_STORAGE_STATE.UNAVAILABLE && (
        <Note>{chatArchiveLabel(storageState)}</Note>
      )}
      {usingPaypal && notice && (
        <div className="paypal-chat-alert" role="status">
          <p>{notice}</p>
          <Button onClick={onReviewPaypal}>Review in Payments</Button>
        </div>
      )}
      <div className="chat-toolbar" hidden={!showToolbar}>
        <div className="chat-tools">
          <Button
            aria-label="Recent conversations"
            disabled={loadingHistory}
            onClick={() => setHistoryOpen(true)}
          >
            <Clock size={16} />
            <span>History</span>
          </Button>
          <IconButton label="Start a new chat" onClick={() => reset()}>
            <Plus size={16} />
          </IconButton>
        </div>
      </div>
      <div
        className={`chat-stage${!session.messages.length ? ' is-empty' : ''}`}
      >
        <div
          ref={scroller}
          className={`conversation${!session.messages.length ? ' empty' : ''}`}
          onScroll={() => {
            const el = scroller.current;
            if (el) {
              const near =
                el.scrollHeight - el.scrollTop - el.clientHeight <
                CHAT_PREVIEW.FOLLOW_THRESHOLD;
              follow.current = near;
              setNearBottom(near);
            }
          }}
        >
          {!session.messages.length ? (
            <div className="chat-start">
              <SignalMark
                state={
                  !online
                    ? SIGNAL_STATE.PAUSED
                    : modelPulse
                      ? SIGNAL_STATE.CONNECTING
                      : SIGNAL_STATE.IDLE
                }
              />
              <h2>Start a conversation</h2>
              <p>Choose how to pay. Keep the conversation.</p>
            </div>
          ) : (
            <div
              className="chat-transcript"
              role="log"
              aria-label="Conversation"
              aria-live="off"
            >
              {turns.map(({ id, user, answer }) => (
                <div className="chat-turn" key={id}>
                  {user && (
                    <ChatUserMessage
                      text={user.text}
                      sentAt={user.sentAt}
                      action={
                        <>
                          <IconButton
                            label={
                              copied === user.id
                                ? 'Message copied'
                                : 'Copy message'
                            }
                            title="Copy message"
                            onClick={() => {
                              void copy(user.text, user.id);
                            }}
                          >
                            {copied === user.id ? (
                              <Check size={14} />
                            ) : (
                              <Copy size={14} />
                            )}
                          </IconButton>
                          <IconButton
                            label="Edit message"
                            title="Edit in composer"
                            onClick={() => {
                              setDraft(user.text);
                              input.current?.focus();
                            }}
                          >
                            <PencilSimple size={14} />
                          </IconButton>
                        </>
                      }
                    />
                  )}
                  {answer && (
                    <ChatAnswer
                      message={answer}
                      run={run}
                      copied={copied === answer.id}
                      canReuse={
                        answer === session.messages.at(-1) && !!lastUser
                      }
                      reuseDisabled={busy || !online}
                      onCopy={() => {
                        void copy(answer.text, answer.id);
                      }}
                      onReuse={() => {
                        if (!lastUser) return;
                        setDraft(lastUser.text);
                        input.current?.focus();
                      }}
                      onDetails={() => setDetails(answer.id)}
                    />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
        {!nearBottom && session.messages.length > 0 && (
          <div className="latest-wrap">
            <Button
              variant={BUTTON_VARIANT.SECONDARY}
              onClick={() => {
                follow.current = true;
                setNearBottom(true);
                scroller.current?.scrollTo({
                  top: scroller.current.scrollHeight,
                  behavior: window.matchMedia(
                    '(prefers-reduced-motion: reduce)',
                  ).matches
                    ? 'instant'
                    : 'smooth',
                });
              }}
            >
              <ArrowDown size={14} />
              Latest
            </Button>
          </div>
        )}
        <div className="composer-wrap">
          {!online && (
            <p className="chat-notice" role="status">
              Connection paused. Your conversation and draft are kept.
            </p>
          )}
          <ChatComposer
            disabled={loadingHistory}
            ref={composer}
            inputRef={input}
            placeholder={
              !online
                ? 'Your draft stays here while paused.'
                : busy
                  ? 'Write a follow-up…'
                  : 'Message'
            }
            value={session.draft}
            onChange={setDraft}
            onSubmit={submit}
          >
            <div className="composer-leading">
              <ModelDropdown
                model={composerModel}
                models={usingPaypal ? [sandboxModel] : models}
                onSelect={onSelectModel}
                onBrowse={onBrowseModels}
                showBrowse={!usingPaypal}
                contextLabel={
                  usingPaypal ? 'Local model · PayPal Sandbox' : undefined
                }
              />
              {thinking && (
                <ReasoningDropdown
                  support={thinking.support}
                  value={thinking.value}
                  onChange={(level) =>
                    setReasoning({ modelId: composerModel.id, level })
                  }
                />
              )}
              <ToolsDropdown
                selected={selectedTools}
                connected={connectedTools}
                unavailable={usingPaypal}
                onToggle={(id) =>
                  setSelectedTools((previous) =>
                    toggleToolSelection(previous, connectedTools, id),
                  )
                }
                onBrowse={onBrowseApplications}
              />
              {paymentControl}
            </div>
            <div className="composer-actions">
              <span>
                {session.paypalRun
                  ? 'Generating…'
                  : usingPaypal
                    ? canSendPaypal(paypal.state)
                      ? 'PayPal Sandbox'
                      : 'Set up in Payments'
                    : busy
                      ? 'Esc to stop'
                      : model.free
                        ? 'No credits needed'
                        : 'Uses wallet balance'}
              </span>
              <IconButton
                variant={run ? 'secondary' : 'primary'}
                className="ui-composer-action"
                type={run ? 'button' : 'submit'}
                label={run ? 'Stop response' : 'Send message'}
                data-busy={!!run}
                onClick={
                  run
                    ? (event) => {
                        event.preventDefault();
                        stop();
                      }
                    : undefined
                }
                disabled={!run && (!session.draft.trim() || !canSend)}
              >
                <span className="composer-send-glyph" aria-hidden="true">
                  <ArrowUp size={16} weight="bold" />
                </span>
                <span className="composer-stop-glyph" aria-hidden="true">
                  <Square size={14} weight="fill" />
                </span>
              </IconButton>
            </div>
          </ChatComposer>
          {!session.messages.length && (
            <div className="quick-actions" aria-label="Suggested prompts">
              {QUICK_PROMPTS.map((item) => (
                <Button
                  variant={BUTTON_VARIANT.SECONDARY}
                  key={item.text}
                  disabled={loadingHistory}
                  onClick={() => {
                    setDraft(item.prompt);
                    input.current?.focus();
                  }}
                >
                  <item.icon size={16} />
                  {item.text}
                </Button>
              ))}
            </div>
          )}
          <p className="composer-note" role="status">
            {(!usingPaypal && notice) ||
              (busy && session.draft.trim()
                ? run
                  ? 'Draft kept · stop or wait to send'
                  : 'Draft kept · wait for the response'
                : usingPaypal
                  ? 'Messages are independent; previous messages are not sent to the model.'
                  : 'Enter to send · Shift+Enter for a new line')}
          </p>
        </div>
      </div>
      <MotionPresence>
        {historyOpen && (
          <Modal
            title="Recent conversations"
            compact
            close={() => setHistoryOpen(false)}
          >
            <Note>{chatArchiveLabel(storageState)}</Note>
            <SearchField
              label="Search conversations"
              placeholder="Search conversations…"
              value={historySearch}
              onValueChange={setHistorySearch}
            />
            <List label="Conversation history">
              {history.map((item) => {
                const summary = conversationSummary(item);
                return (
                  <div key={item.id} className="chat-history-entry">
                    <ListRow
                      selected={item.id === activeId}
                      leading={
                        <Avatar>
                          <ChatCircle size={16} />
                        </Avatar>
                      }
                      onActivate={() => openSession(item.id)}
                      trailing={
                        item.id === activeId ? <Check size={14} /> : null
                      }
                    >
                      <RowCopy
                        title={item.title}
                        detail={`${summary.prompts} prompts · ${summary.paypalReplies} PayPal replies · ${summary.previewReplies} simulated replies`}
                      />
                      {summary.lastSentAt !== null && (
                        <small className="chat-history-date">
                          {activityDate(summary.lastSentAt)}
                        </small>
                      )}
                    </ListRow>
                    {summary.paymentSessionIds.length > 0 && (
                      <div className="chat-history-sessions">
                        {summary.paymentSessionIds.map((id) => {
                          const entry = activity.state?.sessions.find(
                            (row) => row.id === id,
                          );
                          return (
                            <Button
                              key={id}
                              onClick={() => {
                                setHistoryOpen(false);
                                onActivity(id);
                              }}
                              title="View shared session consumption and payment"
                            >
                              <span>
                                Session{' '}
                                {id.slice(
                                  0,
                                  DESKTOP_ACTIVITY.DISPLAY_ID_CHARACTERS,
                                )}
                              </span>
                              <small>
                                {entry
                                  ? `${sessionOutcome(entry)} · ${paypalDollars(entry.recordedCents)} shared usage`
                                  : 'View in Activity'}
                              </small>
                            </Button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
              {!history.length && (
                <p className="ui-list-empty">
                  {historySearch
                    ? 'No matching conversations.'
                    : 'Your conversations will appear here.'}
                </p>
              )}
            </List>
            <Button
              variant={BUTTON_VARIANT.SECONDARY}
              className="wide"
              onClick={() => {
                setHistoryOpen(false);
                reset();
              }}
            >
              <Plus size={15} />
              New conversation
            </Button>
          </Modal>
        )}
      </MotionPresence>
      <MotionPresence>
        {details &&
          session.messages
            .filter((message) => message.id === details)
            .map((message) => (
              <Modal
                key={message.id}
                title="Run details"
                close={() => setDetails(null)}
              >
                <div className="ui-section ui-help-text">
                  <SignalTrace model={message.model.name} />
                  <p>Model route</p>
                  <p>
                    {message.paymentMethod === PAYMENT_METHOD.PAYPAL
                      ? 'PayPal Sandbox · local inference'
                      : 'USDC preview · simulated response'}
                  </p>
                  {message.reasoning && (
                    <p>
                      Thinking: {reasoningLabel(null, message.reasoning)} ·
                      preview setting
                    </p>
                  )}
                  {message.tools.length > 0 && (
                    <p>Tools: {message.tools.map(toolName).join(', ')}</p>
                  )}
                  <p>Review the response before using it.</p>
                </div>
              </Modal>
            ))}
      </MotionPresence>
      <MotionPresence>
        {pendingSend && (
          <Modal
            title="Use these web tools?"
            compact
            close={() => setPendingSend(null)}
          >
            <p className="modal-note">
              This conversation would share your request with{' '}
              {pendingSend.tools.map(toolName).join(', ')}.
            </p>
            <div className="tool-request-preview">{pendingSend.text}</div>
            <Note>These tools can access the web for this request.</Note>
            <Button
              variant={BUTTON_VARIANT.PRIMARY}
              className="wide"
              onClick={() => {
                const pending = pendingSend;
                setAllowedTools((previous) => [
                  ...new Set([...previous, ...pending.tools]),
                ]);
                setPendingSend(null);
                start(pending.text, pending.tools);
              }}
            >
              Continue with these tools
            </Button>
            <Button
              className="wide"
              onClick={() => {
                const pending = pendingSend;
                setPendingSend(null);
                start(pending.text, []);
              }}
            >
              Send without web tools
            </Button>
          </Modal>
        )}
      </MotionPresence>
    </main>
  );
}
