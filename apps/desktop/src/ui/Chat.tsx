// Stateful desktop conversation preview: sessions, interruption, streaming and tool consent.
// Timers render synthetic text only; this component never contacts a model or web service.
import {
  ArrowClockwise,
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
  type Ref,
} from 'react';

import { ChatController } from './chat-controller.js';
import {
  CHAT_PHASE,
  MESSAGE_STATE,
  toggleToolSelection,
} from './chat-state.js';
import { ToolsDropdown } from './ChatTools.js';
import {
  BUTTON_VARIANT,
  CHAT_PREVIEW,
  CHAT_ROLE,
  MOTION_VARIANT,
} from './constants.js';
import type { DemoAuthorizationStatus } from './demo-account.js';
import { MessageText } from './MessageText.js';
import { Modal } from './Modal.js';
import { ModelDropdown, type ModelOption } from './ModelDropdown.js';
import { MotionPresence } from './Motion.js';
import { SIGNAL_STATE, SignalMark, SignalTrace } from './Signal.js';
import { toolName, TOOLS, type ToolId } from './tools.js';
import {
  Avatar,
  Badge,
  Button,
  IconButton,
  List,
  ListRow,
  Note,
  RowCopy,
  SearchField,
} from './UI.js';

export type ChatHandle = {
  newChat: () => void;
  prefill: (text: string) => void;
};
type Props = {
  ref?: Ref<ChatHandle>;
  model: ModelOption;
  online: boolean;
  active?: boolean;
  connectedTools: ToolId[];
  onToggleTool: (id: ToolId) => void;
  models: readonly ModelOption[];
  onSelectModel: (id: string) => void;
  onBrowseModels: () => void;
  onAuthorize: () => DemoAuthorizationStatus;
};
type PendingSend = { text: string; tools: ToolId[] };
const PHASE_LABEL = {
  [CHAT_PHASE.CONNECTING]: 'Connecting to a provider',
  [CHAT_PHASE.TOOLS]: 'Using web tools',
  [CHAT_PHASE.RESPONDING]: 'Writing response',
} as const;
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
export function Chat({
  ref,
  model,
  online,
  active = true,
  connectedTools,
  onToggleTool,
  models,
  onSelectModel,
  onBrowseModels,
  onAuthorize,
}: Props) {
  const [chat] = useState(() => new ChatController('first-chat'));
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
  const [details, setDetails] = useState<string[]>([]);
  const [copied, setCopied] = useState('');
  const notice = session.notice;
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
  const busy = Boolean(run);
  const chosenTools = selectedTools.filter((id) => connectedTools.includes(id));
  const lastUser = [...session.messages]
    .reverse()
    .find((message) => message.role === CHAT_ROLE.USER);

  function setDraft(text: string) {
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
    captureComposer();
    const id = crypto.randomUUID();
    chat.newChat(id, text);
    setSelectedTools([]);
    setAllowedTools([]);
    setPendingSend(null);
    setDetails([]);
    follow.current = true;
    setNearBottom(true);
  }
  useImperativeHandle(ref, () => ({
    newChat: () => reset(),
    prefill: (text) => reset(text),
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
    if (!chat.start(text, model, tools, runId, onAuthorize)) {
      composerOrigin.current = null;
      return;
    }
    follow.current = true;
    setNearBottom(true);
    input.current?.focus();
  }
  function submit() {
    if (busy) return;
    if (!session.draft.trim() || !online) return;
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
      <div className="chat-toolbar">
        <div className="chat-tools">
          <Button
            aria-label="Recent conversations"
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
              <p>One question. A new direction.</p>
            </div>
          ) : (
            <div
              className="chat-transcript"
              role="log"
              aria-label="Conversation"
              aria-live="off"
            >
              {session.messages.map((message) =>
                message.role === CHAT_ROLE.USER ? (
                  <article key={message.id} className="chat-user">
                    <p>{message.text}</p>
                    <IconButton
                      label="Reuse message"
                      onClick={() => {
                        setDraft(message.text);
                        input.current?.focus();
                      }}
                    >
                      <PencilSimple size={14} />
                    </IconButton>
                  </article>
                ) : (
                  <article key={message.id} className="chat-answer">
                    <header className="answer-heading">
                      <SignalMark
                        state={
                          message.state === MESSAGE_STATE.PENDING
                            ? !online
                              ? SIGNAL_STATE.PAUSED
                              : run?.phase === CHAT_PHASE.CONNECTING
                                ? SIGNAL_STATE.CONNECTING
                                : run?.phase === CHAT_PHASE.TOOLS
                                  ? SIGNAL_STATE.WORKING
                                  : SIGNAL_STATE.RESPONDING
                            : message.state === MESSAGE_STATE.STOPPED
                              ? SIGNAL_STATE.STOPPED
                              : SIGNAL_STATE.COMPLETE
                        }
                      />
                      <span>{message.model.name}</span>
                      <Badge>{message.model.free ? 'Free' : 'Paid'}</Badge>
                    </header>
                    {message.state === MESSAGE_STATE.PENDING && (
                      <div className="run-line" role="status">
                        <span className="ascii-state" aria-hidden="true">
                          {run?.phase === CHAT_PHASE.RESPONDING
                            ? '::'
                            : run?.phase === CHAT_PHASE.TOOLS
                              ? '[+]'
                              : '[..]'}
                        </span>
                        <span>
                          {run ? PHASE_LABEL[run.phase] : 'Preparing response'}
                        </span>
                      </div>
                    )}
                    {message.text ? (
                      <MessageText text={message.text} />
                    ) : message.state === MESSAGE_STATE.STOPPED ? (
                      <p className="stopped-note">
                        Stopped before a response arrived.
                      </p>
                    ) : null}
                    <div className="answer-actions">
                      {message.state !== MESSAGE_STATE.PENDING && (
                        <>
                          <span className="answer-state" role="status">
                            {message.state === MESSAGE_STATE.STOPPED
                              ? message.text
                                ? 'Stopped · partial response'
                                : 'Stopped'
                              : 'Completed'}
                          </span>
                          {message.text && (
                            <IconButton
                              label={
                                copied === message.id
                                  ? 'Response copied'
                                  : 'Copy response'
                              }
                              onClick={() => copy(message.text, message.id)}
                            >
                              {copied === message.id ? (
                                <Check size={14} />
                              ) : (
                                <Copy size={14} />
                              )}
                            </IconButton>
                          )}
                          {message === session.messages.at(-1) && lastUser && (
                            <IconButton
                              label="Reuse question"
                              disabled={busy || !online}
                              onClick={() => {
                                setDraft(lastUser.text);
                                input.current?.focus();
                              }}
                            >
                              <ArrowClockwise size={14} />
                            </IconButton>
                          )}
                        </>
                      )}
                      <Button
                        className="run-details-trigger"
                        aria-expanded={details.includes(message.id)}
                        aria-controls={`details-${message.id}`}
                        onClick={() =>
                          setDetails((previous) =>
                            previous.includes(message.id)
                              ? previous.filter((id) => id !== message.id)
                              : [...previous, message.id],
                          )
                        }
                      >
                        Run details
                      </Button>
                    </div>
                    <MotionPresence variant={MOTION_VARIANT.EXPAND}>
                      {details.includes(message.id) && (
                        <section
                          id={`details-${message.id}`}
                          className="run-details"
                        >
                          <SignalTrace model={message.model.name} />
                          <p>Model route</p>
                          {message.tools.length > 0 && (
                            <p>
                              Tools: {message.tools.map(toolName).join(', ')}
                            </p>
                          )}
                          <p>Review the response before using it.</p>
                        </section>
                      )}
                    </MotionPresence>
                  </article>
                ),
              )}
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
          <form
            ref={composer}
            className="composer"
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <textarea
              ref={input}
              aria-label="Your message"
              placeholder={
                !online
                  ? 'Your draft stays here while paused.'
                  : busy
                    ? 'Write a follow-up…'
                    : 'Message'
              }
              value={session.draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  submit();
                }
              }}
            />
            <div className="composer-bottom">
              <div className="composer-leading">
                <ModelDropdown
                  model={model}
                  models={models}
                  onSelect={onSelectModel}
                  onBrowse={onBrowseModels}
                />
                <ToolsDropdown
                  connected={connectedTools}
                  selected={chosenTools}
                  onConnect={onToggleTool}
                  onSelect={(id) =>
                    setSelectedTools((previous) =>
                      toggleToolSelection(previous, connectedTools, id),
                    )
                  }
                />
              </div>
              <div className="composer-actions">
                <span>
                  {busy
                    ? 'Esc to stop'
                    : model.free
                      ? 'No credits needed'
                      : 'Uses wallet balance'}
                </span>
                <IconButton
                  variant={busy ? 'secondary' : 'primary'}
                  className="ui-composer-action"
                  type={busy ? 'button' : 'submit'}
                  label={busy ? 'Stop response' : 'Send message'}
                  data-busy={busy}
                  onClick={busy ? stop : undefined}
                  disabled={!busy && (!session.draft.trim() || !online)}
                >
                  <span className="composer-send-glyph" aria-hidden="true">
                    <ArrowUp size={16} weight="bold" />
                  </span>
                  <span className="composer-stop-glyph" aria-hidden="true">
                    <Square size={14} weight="fill" />
                  </span>
                </IconButton>
              </div>
            </div>
          </form>
          {!session.messages.length && (
            <div className="quick-actions" aria-label="Suggested prompts">
              {QUICK_PROMPTS.map((item) => (
                <Button
                  variant={BUTTON_VARIANT.SECONDARY}
                  key={item.text}
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
            {notice ||
              (busy && session.draft.trim()
                ? 'Draft kept · stop or wait to send'
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
            <SearchField
              label="Search conversations"
              placeholder="Search conversations…"
              value={historySearch}
              onValueChange={setHistorySearch}
            />
            <List label="Conversation history">
              {history.map((item) => (
                <ListRow
                  key={item.id}
                  selected={item.id === activeId}
                  leading={
                    <Avatar>
                      <ChatCircle size={16} />
                    </Avatar>
                  }
                  onActivate={() => openSession(item.id)}
                  trailing={item.id === activeId ? <Check size={14} /> : null}
                >
                  <RowCopy
                    title={item.title}
                    detail={
                      item.messages.length
                        ? `${item.messages.filter((message) => message.role === CHAT_ROLE.USER).length} prompts`
                        : 'Draft'
                    }
                  />
                </ListRow>
              ))}
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
