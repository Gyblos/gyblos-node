// Hosts the buyer desktop, including the local PayPal Sandbox inference session.
// USDC Chat and Connect remain simulated; Wallet receives public local metadata only.
import {
  ArrowLeft,
  ArrowUp,
  ChartBar,
  Check,
  CheckCircle,
  Clock,
  Code,
  CreditCard,
  GearSix,
  Globe,
  Palette,
  Plus,
  ShieldCheck,
  SidebarSimple,
  Sparkle,
  TerminalWindow,
  Wallet,
  X,
} from '@phosphor-icons/react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';

import manifest from '../package.json';
import { CATALOG_STATE } from './catalog/model';
import {
  canSelectPreviewModel,
  canSwitchPaymentMethod,
  PAYMENT_METHOD,
  paypalSessionCanConnectAgent,
  shouldMonitorPaypal,
  type PaymentMethod,
} from './paypal-model';
import { themeStyle } from './theme';
import { Activity } from './ui/Activity';
import { AddFunds } from './ui/AddFunds';
import { announcedModels } from './ui/announced-models';
import { Appearance } from './ui/Appearance';
import { BuyerSidebar } from './ui/BuyerSidebar';
import { matchesCatalog, type ModelFilter } from './ui/catalog-state';
import { Chat, type ChatHandle } from './ui/Chat';
import { ChatController } from './ui/chat-controller';
import { ChatPaymentSelector } from './ui/ChatPaymentSelector';
import { ToolConnections } from './ui/ChatTools';
import {
  BUTTON_VARIANT,
  MAIN_NAV,
  MODEL_FILTER,
  MODEL_SOURCE,
  MODELS,
  NAVIGATION_WIDTH,
  ROUTE_ORDER,
  SIDEBAR_MOTION_MS,
  UI_DIALOG,
  UI_VIEW,
  WORKSPACE_BREAKPOINT,
} from './ui/constants';
import { authorizeDemo, DEMO_ACCOUNT, DEMO_AUTH } from './ui/demo-account';
import { DesignSystem } from './ui/DesignSystem';
import { FormField, FormInput } from './ui/Form';
import { Modal } from './ui/Modal';
import type { CatalogModel as Model, View } from './ui/model-types';
import { ModelImage, type ModelArtwork } from './ui/ModelImage';
import {
  animateChange,
  MotionPresence,
  SLIDE_DIRECTION,
  SLIDE_SURFACE,
} from './ui/Motion';
import {
  back,
  createNavigation,
  navigate as navigateState,
} from './ui/navigation-state';
import { NetworkCatalogPanel, useNetworkCatalog } from './ui/NetworkCatalog';
import { NetworkStatus, useLocalNode } from './ui/NetworkStatus';
import { PageBody } from './ui/PageBody';
import { PaymentMethodSelector } from './ui/PaymentMethodSelector';
import { PaypalAgentConnection } from './ui/PaypalAgentConnection';
import { PaypalSessionPanel } from './ui/PaypalSessionPanel';
import { ResizeHandle } from './ui/ResizeHandle';
import type { ToolId } from './ui/tools';
import {
  Avatar,
  Badge,
  Button,
  EmptyState,
  IconButton,
  InfoBar,
  List,
  ListRow,
  Note,
  PagePanel,
  RowCopy,
  SearchField,
  SectionTitle,
  SettingsGroup,
} from './ui/UI';
import { useActivity } from './ui/useActivity';
import { useChatArchive } from './ui/useChatArchive';
import { usePaypalSession } from './ui/usePaypalSession';
import { WalletBackup } from './ui/WalletBackup';
import { WalletDetails } from './ui/WalletDetails';
import { useDesktopWallet } from './ui/WalletState';
import { WALLET_STATUS } from './wallet/model';

const money = (value: number) => '$' + value.toFixed(2);
function ModelIcon({ model }: { model: Pick<Model, 'name' | 'image'> }) {
  return (
    <Avatar>
      <ModelImage artwork={model.image} name={model.name} />
    </Avatar>
  );
}

export function DesktopApp() {
  const [route, setRoute] = useState(createNavigation);
  const view = route.current;
  const navigation = MAIN_NAV;
  function navigate(next: View, contextual = true) {
    if (next === view && contextual) return;
    const currentIndex = ROUTE_ORDER.findIndex((item) => item === view);
    const nextIndex = ROUTE_ORDER.findIndex((item) => item === next);
    animateChange(
      () => {
        setRoute((current) => navigateState(current, next, contextual));
      },
      nextIndex > currentIndex
        ? SLIDE_DIRECTION.FORWARD
        : SLIDE_DIRECTION.BACKWARD,
      SLIDE_SURFACE.WORKSPACE,
    );
  }
  function goBack() {
    animateChange(
      () => setRoute(back),
      SLIDE_DIRECTION.BACKWARD,
      SLIDE_SURFACE.WORKSPACE,
    );
  }
  const [navigationWidth, setNavigationWidth] = useState<number>(
    NAVIGATION_WIDTH.DEFAULT,
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => window.innerWidth < WORKSPACE_BREAKPOINT.SIDEBAR,
  );
  const [contextOpen, setContextOpen] = useState(
    () => window.innerWidth >= WORKSPACE_BREAKPOINT.CONTEXT,
  );
  const [sidebarMoving, setSidebarMoving] = useState(false);
  function toggleSidebar() {
    setSidebarMoving(true);
    setSidebarCollapsed((value) => !value);
  }
  useEffect(() => {
    if (!sidebarMoving) return;
    const timer = window.setTimeout(
      () => setSidebarMoving(false),
      SIDEBAR_MOTION_MS,
    );
    return () => window.clearTimeout(timer);
  }, [sidebarCollapsed, sidebarMoving]);
  useEffect(() => {
    function resize() {
      if (window.innerWidth < WORKSPACE_BREAKPOINT.SIDEBAR)
        setSidebarCollapsed(true);
      if (window.innerWidth < WORKSPACE_BREAKPOINT.CONTEXT)
        setContextOpen(false);
    }
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  const [light, setLight] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(
    PAYMENT_METHOD.USDC,
  );
  const monitorPaypal =
    paymentMethod === PAYMENT_METHOD.PAYPAL &&
    (view === UI_VIEW.CHAT ||
      shouldMonitorPaypal(
        paymentMethod,
        view === UI_VIEW.PAYMENTS ||
          view === UI_VIEW.ACTIVITY ||
          view === UI_VIEW.CONNECT,
      ));
  const paypal = usePaypalSession(monitorPaypal);
  const paypalStatus = paypal.state.status;
  const paypalBusy =
    paypal.state.busy ||
    !!paypal.state.pendingPrompt ||
    !!paypal.state.pendingMessageId;
  const paypalStatusFresh =
    paypal.state.statusFresh && !paypal.state.busy && monitorPaypal;
  useEffect(() => {
    const showPaypalChat = () => {
      setPaymentMethod(PAYMENT_METHOD.PAYPAL);
      setRoute((current) => navigateState(current, UI_VIEW.CHAT));
    };
    const removeReturn = window.desktopPaypal?.onReturn?.(showPaypalChat);
    const removeCancel = window.desktopPaypal?.onCancel?.(showPaypalChat);
    return () => {
      removeReturn?.();
      removeCancel?.();
    };
  }, []);
  const frameStyle: CSSProperties & { '--navigation-width': string } = {
    '--navigation-width': navigationWidth + 'px',
    ...themeStyle(light),
  };
  const network = useLocalNode();
  const wallet = useDesktopWallet();
  const announcements = useNetworkCatalog();
  const networkModels = announcedModels(announcements.snapshot, Date.now());
  const chatModels = [MODELS[0], ...networkModels, ...MODELS.slice(1)];
  // Chat and Connect remain simulated independently of local endpoint readiness.
  const online = true;
  const [model, setModel] = useState(MODELS[0]);
  useEffect(() => {
    if (
      model.source === MODEL_SOURCE.ANNOUNCED &&
      announcements.snapshot.state !== CATALOG_STATE.LOADING &&
      !networkModels.some((item) => item.id === model.id)
    )
      setModel(MODELS[0]);
  }, [announcements.snapshot, model]);
  const [credits, setCredits] = useState(0);
  const [spent, setSpent] = useState(0);
  const [budget, setBudget] = useState<number>(DEMO_ACCOUNT.DEFAULT_BUDGET);
  const [budgetDraft, setBudgetDraft] = useState(
    String(DEMO_ACCOUNT.DEFAULT_BUDGET),
  );
  const [modal, setModal] = useState<
    (typeof UI_DIALOG)[keyof typeof UI_DIALOG] | null
  >(null);
  const [paidModel, setPaidModel] = useState<Model | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ModelFilter>(MODEL_FILTER.ALL);
  const [toast, setToast] = useState('');
  const chatRef = useRef<ChatHandle>(null);
  const [chatController] = useState(() => new ChatController('first-chat'));
  const conversationStorage = useChatArchive(chatController);
  const activity = useActivity();
  const [activitySession, setActivitySession] = useState<string | null>(null);
  const [chatBusy, setChatBusy] = useState(false);
  const [connectedTools] = useState<ToolId[]>([]);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    content.current?.scrollTo({ top: 0 });
  }, [view]);
  useEffect(() => {
    function command(event: KeyboardEvent) {
      if (
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        document.querySelector('dialog[open]')
      )
        return;
      const key = event.key.toLowerCase();
      if (key === 'b') {
        event.preventDefault();
        toggleSidebar();
      } else if (key === 'k' && paymentMethod !== PAYMENT_METHOD.PAYPAL) {
        event.preventDefault();
        navigate(UI_VIEW.MODELS);
      } else if (key === 'n' && view === UI_VIEW.CHAT && !chatBusy) {
        event.preventDefault();
        chatRef.current?.newChat();
      } else if (/^[1-9]$/.test(key) && Number(key) <= navigation.length) {
        event.preventDefault();
        const destination = navigation[Number(key) - 1]?.name;
        if (!destination) return;
        navigate(destination, false);
      }
    }
    window.addEventListener('keydown', command);
    return () => window.removeEventListener('keydown', command);
  }, [view, paymentMethod, chatBusy]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), DEMO_ACCOUNT.TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);
  function choose(next: Model) {
    if (paymentMethod === PAYMENT_METHOD.PAYPAL) return;
    if (next.id === model.id) return;
    if (!next.free) {
      setPaidModel(next);
      return;
    }
    setModel(next);
    setToast(next.name + ' selected');
  }
  function authorizeChatRequest() {
    const result = authorizeDemo(
      { credits, spent, budget },
      model.free,
      online,
    );
    if (result.status !== DEMO_AUTH.APPROVED) return result.status;
    setSpent(result.spent);
    setCredits(result.credits);
    return result.status;
  }
  function paymentSelector() {
    return (
      <ChatPaymentSelector
        value={paymentMethod}
        locked={
          chatBusy ||
          !canSwitchPaymentMethod(
            paymentMethod,
            PAYMENT_METHOD.USDC,
            paypalBusy,
          )
        }
        onChange={changePaymentMethod}
        onManage={() => navigate(UI_VIEW.PAYMENTS)}
      />
    );
  }
  function changePaymentMethod(next: PaymentMethod) {
    if (canSwitchPaymentMethod(paymentMethod, next, paypalBusy, chatBusy))
      setPaymentMethod(next);
  }
  function reviewPaypalPayments() {
    changePaymentMethod(PAYMENT_METHOD.PAYPAL);
    navigate(UI_VIEW.PAYMENTS);
  }
  return (
    <div
      style={frameStyle}
      className={
        'app desktop-frame ' +
        (light ? 'light ' : '') +
        (sidebarCollapsed ? 'sidebar-collapsed ' : '') +
        (sidebarMoving ? 'sidebar-moving' : '')
      }
    >
      <header className="topbar">
        <div className="breadcrumb">
          {sidebarCollapsed && (
            <IconButton
              className="sidebar-toggle"
              label="Expand sidebar"
              aria-controls="app-sidebar"
              aria-expanded={false}
              onClick={toggleSidebar}
            >
              <SidebarSimple size={18} />
            </IconButton>
          )}
          {route.history.length > 0 && (
            <IconButton
              label={`Back to ${navigation.find((item) => item.name === route.history.at(-1))?.label ?? route.history.at(-1)}`}
              onClick={goBack}
            >
              <ArrowLeft size={18} aria-hidden="true" />
            </IconButton>
          )}
          <h1 id="route-title">
            {navigation.find((item) => item.name === view)?.label ?? view}
          </h1>
        </div>
        <div className="top-actions">
          {view === UI_VIEW.CONNECT && (
            <IconButton
              label={
                contextOpen
                  ? 'Hide connection context'
                  : 'Show connection context'
              }
              aria-pressed={contextOpen}
              onClick={() => setContextOpen((open) => !open)}
            >
              <SidebarSimple size={18} mirrored />
            </IconButton>
          )}

          {paypalBusy &&
            paymentMethod === PAYMENT_METHOD.PAYPAL &&
            view !== UI_VIEW.CHAT && (
              <span className="payment-operation-notice" role="status">
                PayPal is checking, processing or needs attention.
              </span>
            )}
          {paymentMethod === PAYMENT_METHOD.USDC &&
            paypal.chat.hasKnownUnfinishedSession() && (
              <Button
                variant={BUTTON_VARIANT.TONAL}
                title="Check PayPal session"
                onClick={reviewPaypalPayments}
              >
                Review PayPal session
              </Button>
            )}
        </div>
      </header>
      <BuyerSidebar
        view={view}
        collapsed={sidebarCollapsed}
        chat={chatController}
        storageState={conversationStorage}
        onCollapse={toggleSidebar}
        navigate={(next) => {
          navigate(next, false);
          if (window.innerWidth < WORKSPACE_BREAKPOINT.SIDEBAR)
            setSidebarCollapsed(true);
        }}
        onNewChat={() => {
          chatRef.current?.newChat();
          navigate(UI_VIEW.CHAT, false);
          if (window.innerWidth < WORKSPACE_BREAKPOINT.SIDEBAR)
            setSidebarCollapsed(true);
        }}
        onOpenChat={(id) => {
          chatRef.current?.openChat(id);
          navigate(UI_VIEW.CHAT, false);
          if (window.innerWidth < WORKSPACE_BREAKPOINT.SIDEBAR)
            setSidebarCollapsed(true);
        }}
      />
      <div
        className="navigation-resizer"
        inert={sidebarCollapsed}
        aria-hidden={sidebarCollapsed || undefined}
      >
        <ResizeHandle
          label="Resize navigation"
          orientation="vertical"
          value={navigationWidth}
          min={NAVIGATION_WIDTH.MIN}
          max={NAVIGATION_WIDTH.MAX}
          initial={NAVIGATION_WIDTH.DEFAULT}
          controls="app-sidebar app-workspace"
          onChange={setNavigationWidth}
        />
      </div>
      <div id="app-workspace" className="app-body">
        <PageBody
          ref={content}
          chat={view === UI_VIEW.CHAT}
          split={view === UI_VIEW.CONNECT}
        >
          <div className="chat-root" hidden={view !== UI_VIEW.CHAT}>
            <Chat
              ref={chatRef}
              chat={chatController}
              storageState={conversationStorage}
              activity={activity}
              onActivity={(id) => {
                setActivitySession(id);
                navigate(UI_VIEW.ACTIVITY);
              }}
              active={view === UI_VIEW.CHAT}
              showToolbar={sidebarCollapsed}
              paymentMethod={paymentMethod}
              paymentControl={paymentSelector()}
              paypal={paypal}
              onBusyChange={setChatBusy}
              model={model}
              online={online}
              onAuthorize={authorizeChatRequest}
              connectedTools={connectedTools}
              onBrowseApplications={() => navigate(UI_VIEW.TOOLS)}
              models={chatModels}
              onSelectModel={(id) => {
                const next = chatModels.find((item) => item.id === id);
                if (next) choose(next);
              }}
              onBrowseModels={() => navigate(UI_VIEW.MODELS)}
              onReviewPaypal={() => {
                changePaymentMethod(PAYMENT_METHOD.PAYPAL);
                navigate(UI_VIEW.PAYMENTS);
              }}
            />
          </div>
          {view === UI_VIEW.MODELS && (
            <PagePanel>
              <NetworkCatalogPanel
                snapshot={announcements.snapshot}
                onLookup={announcements.lookup}
                onSelect={
                  canSelectPreviewModel(paymentMethod) ? choose : undefined
                }
                selected={model.id}
              />
              <section aria-label="Preview models" className="ui-section">
                {!canSelectPreviewModel(paymentMethod) && (
                  <Note>
                    This catalog is a USDC preview. PayPal Sandbox uses its
                    configured local model.
                  </Note>
                )}
                <div className="ui-toolbar">
                  <SearchField
                    label="Search catalog"
                    placeholder="Search models or families"
                    value={search}
                    onValueChange={setSearch}
                  />
                  <div
                    className="ui-segmented"
                    role="group"
                    aria-label="Filter models"
                  >
                    {Object.values(MODEL_FILTER).map((value) => (
                      <Button
                        key={value}
                        aria-pressed={filter === value}
                        onClick={() => setFilter(value)}
                      >
                        {value}
                      </Button>
                    ))}
                  </div>
                </div>
                <SectionTitle>Preview catalog</SectionTitle>
                <List label="Model catalog">
                  {MODELS.filter((item) =>
                    matchesCatalog(item, search, filter),
                  ).map((item) => (
                    <ListRow
                      key={item.id}
                      leading={<ModelIcon model={item} />}
                      onActivate={
                        canSelectPreviewModel(paymentMethod)
                          ? () => choose(item)
                          : undefined
                      }
                      selected={
                        canSelectPreviewModel(paymentMethod) &&
                        model.id === item.id
                      }
                      trailing={
                        <>
                          <div className="ui-price">
                            <strong>
                              {item.free
                                ? 'Free'
                                : `$${item.input.toFixed(2)} / $${item.output.toFixed(2)}`}
                            </strong>
                            <small>
                              {item.free
                                ? 'Community supported'
                                : 'In / out per 1M tokens'}
                            </small>
                          </div>
                          {canSelectPreviewModel(paymentMethod) &&
                            model.id === item.id && <Check size={16} />}
                        </>
                      }
                    >
                      <RowCopy
                        title={item.name}
                        detail={`${item.family} · ${item.context} context · ${item.providers} providers`}
                      />
                    </ListRow>
                  ))}
                  {!MODELS.some((item) =>
                    matchesCatalog(item, search, filter),
                  ) && (
                    <p className="ui-list-empty">
                      No models found. Try another name or filter.
                    </p>
                  )}
                </List>
              </section>
              <InfoBar
                leading={<Globe size={16} />}
                trailing={
                  <Button
                    variant={BUTTON_VARIANT.SECONDARY}
                    onClick={() => navigate(UI_VIEW.CHAT)}
                  >
                    Back to chat
                  </Button>
                }
              >
                <span>
                  USDC Chat and Connect use simulated responses. PayPal Sandbox
                  uses its local model.
                </span>
              </InfoBar>
            </PagePanel>
          )}
          {view === UI_VIEW.CONNECT && (
            <PaypalAgentConnection
              onlyConnected={paymentMethod !== PAYMENT_METHOD.PAYPAL}
              sessionReady={paypalSessionCanConnectAgent(
                paypalStatus,
                paypalStatusFresh,
                paypalBusy,
              )}
              sessionStatus={paypalStatus}
              sessionFresh={paypalStatusFresh}
              contextOpen={contextOpen}
              onCloseContext={() => setContextOpen(false)}
              onPayments={reviewPaypalPayments}
            />
          )}
          {view === UI_VIEW.TOOLS && (
            <PagePanel>
              <ToolConnections />
            </PagePanel>
          )}
          {view === UI_VIEW.PAYMENTS && (
            <PagePanel>
              <div className="payments-method">
                <div>
                  <h2>How would you like to pay?</h2>
                  <p>
                    Select the method for chat. PayPal sessions also cover
                    connected agents.
                  </p>
                </div>
                <PaymentMethodSelector
                  name="payment-method"
                  value={paymentMethod}
                  lockChange={
                    chatBusy ||
                    !canSwitchPaymentMethod(
                      paymentMethod,
                      PAYMENT_METHOD.USDC,
                      paypalBusy,
                    )
                  }
                  onChange={changePaymentMethod}
                />
                {paypalBusy && paymentMethod === PAYMENT_METHOD.PAYPAL && (
                  <p role="status">
                    Finish the current operation or confirm its response before
                    switching.
                  </p>
                )}
              </div>
              <div className="payments-layout">
                <div className="payments-primary">
                  {paymentMethod === PAYMENT_METHOD.PAYPAL ? (
                    <PaypalSessionPanel
                      session={paypal}
                      onChat={() => navigate(UI_VIEW.CHAT)}
                    />
                  ) : (
                    <SettingsGroup
                      leading={<CreditCard size={18} aria-hidden="true" />}
                      title="PayPal"
                      description="A session limit for chat and agents, separate from your USDC wallet."
                    >
                      <p className="ui-help-text">
                        Use Sandbox test funds to approve a limit and send
                        multiple messages.
                      </p>
                      <Button
                        variant={BUTTON_VARIANT.TONAL}
                        onClick={() =>
                          changePaymentMethod(PAYMENT_METHOD.PAYPAL)
                        }
                      >
                        Review or start a PayPal session
                      </Button>
                    </SettingsGroup>
                  )}
                </div>
                <div className="payments-wallet">
                  <SettingsGroup
                    leading={<Wallet size={18} aria-hidden="true" />}
                    title="USDC wallet"
                    description="Your wallet, recovery backup and funding status."
                  >
                    <WalletDetails
                      onBackup={() => setModal(UI_DIALOG.BACKUP)}
                      onAddFunds={() => setModal(UI_DIALOG.ADD_FUNDS)}
                    />
                  </SettingsGroup>
                  <SettingsGroup
                    leading={<ChartBar size={18} aria-hidden="true" />}
                    title="USDC spending"
                    description="Chat preview only. PayPal has its own session limit."
                  >
                    <List label="Chat spending limit">
                      <ListRow
                        leading={null}
                        trailing={
                          <Button
                            variant={BUTTON_VARIANT.TONAL}
                            onClick={() => setModal(UI_DIALOG.BUDGET)}
                          >
                            Edit limit
                          </Button>
                        }
                      >
                        <RowCopy
                          title="Daily limit"
                          detail={money(budget) + ' per day'}
                        />
                      </ListRow>
                    </List>
                  </SettingsGroup>
                </div>
              </div>
              <p className="payments-footnote">
                PayPal does not add USDC to your wallet. Switching methods keeps
                an open PayPal session and its connected agents active. The
                selected method resets when Gyblos closes.
              </p>
            </PagePanel>
          )}
          {view === UI_VIEW.SETTINGS && (
            <PagePanel>
              <div className="ui-section">
                <SettingsGroup
                  leading={<Palette size={18} aria-hidden="true" />}
                  title="Appearance"
                  description="Choose a light or dark interface."
                >
                  <Appearance
                    light={light}
                    onLightChange={setLight}
                    label="Theme"
                  />
                  <Button
                    variant={BUTTON_VARIANT.SECONDARY}
                    onClick={() => setModal(UI_DIALOG.DESIGN_SYSTEM)}
                  >
                    Preview design system
                  </Button>
                </SettingsGroup>
              </div>
            </PagePanel>
          )}
          {view === UI_VIEW.ACTIVITY && (
            <Activity
              activity={activity}
              chat={chatController}
              selectedSession={activitySession}
              onSelectSession={setActivitySession}
              onPayments={() => {
                changePaymentMethod(PAYMENT_METHOD.PAYPAL);
                navigate(UI_VIEW.PAYMENTS);
              }}
              onOpenChat={(id) => {
                chatController.openChat(id);
                navigate(UI_VIEW.CHAT);
              }}
            />
          )}
        </PageBody>
      </div>
      <footer className="app-footer" aria-label="Application status">
        <NetworkStatus state={network.state} onRetry={network.retry} />
        <Button
          title="Wallet settings"
          onClick={() => navigate(UI_VIEW.PAYMENTS)}
        >
          <Wallet size={14} />
          {wallet.status === WALLET_STATUS.READY && !wallet.backupVerified
            ? 'Wallet · Backup needed'
            : wallet.status === WALLET_STATUS.RECOVERY_REQUIRED ||
                wallet.status === WALLET_STATUS.UNAVAILABLE
              ? 'Wallet · Needs attention'
              : 'Wallet'}
        </Button>
        <span className="footer-version" title="Gyblos version">
          v{manifest.version}
        </span>
      </footer>
      <MotionPresence>
        {modal === UI_DIALOG.DESIGN_SYSTEM && (
          <Modal
            title="Design system"
            description="Shared visual components for the buyer app."
            close={() => setModal(null)}
          >
            <DesignSystem />
          </Modal>
        )}
      </MotionPresence>
      <MotionPresence>
        {modal === UI_DIALOG.ADD_FUNDS && (
          <Modal
            title="Add funds"
            description="Choose how much to add to your wallet."
            close={() => setModal(null)}
          >
            <AddFunds
              onBackup={() => {
                setModal(null);
                navigate(UI_VIEW.PAYMENTS);
              }}
            />
          </Modal>
        )}
      </MotionPresence>
      <MotionPresence>
        {modal === UI_DIALOG.BACKUP && (
          <Modal title="Wallet backup" close={() => setModal(null)}>
            <WalletBackup />
          </Modal>
        )}
      </MotionPresence>
      <MotionPresence>
        {modal === UI_DIALOG.BUDGET && (
          <Modal
            title="Daily spending limit"
            description="Applies to the USDC chat preview only."
            close={() => setModal(null)}
          >
            <FormField htmlFor={UI_DIALOG.BUDGET} label="Daily limit ($)">
              <FormInput
                id={UI_DIALOG.BUDGET}
                type="number"
                min="0"
                value={budgetDraft}
                onChange={(event) => setBudgetDraft(event.target.value)}
              />
            </FormField>
            <p className="modal-note">Free models do not use this limit.</p>
            <Button
              variant={BUTTON_VARIANT.PRIMARY}
              className="wide"
              onClick={() => {
                const value = Number(budgetDraft);
                if (!Number.isFinite(value) || value < 0) {
                  setToast('Enter a valid nonnegative limit.');
                  return;
                }
                setBudget(value);
                setModal(null);
              }}
            >
              Save limit
              <Check size={16} />
            </Button>
          </Modal>
        )}
      </MotionPresence>
      <MotionPresence>
        {paidModel && (
          <Modal title="Use a paid model?" close={() => setPaidModel(null)}>
            <div className="paid-model-summary">
              <ModelIcon model={paidModel} />
              <strong>{paidModel.name}</strong>
            </div>
            <div className="paid-terms">
              <div>
                <span>Input / 1M tokens</span>
                <strong>${paidModel.input.toFixed(2)}</strong>
              </div>
              <div>
                <span>Output / 1M tokens</span>
                <strong>${paidModel.output.toFixed(2)}</strong>
              </div>
              <div>
                <span>Your device daily limit</span>
                <strong>{money(budget)}</strong>
              </div>
            </div>
            <p className="modal-note">
              Your model stays selected. Gyblos won’t silently switch from a
              free to a paid offer.
            </p>
            <Button
              variant={BUTTON_VARIANT.PRIMARY}
              className="wide"
              onClick={() => {
                setModel(paidModel);
                setPaidModel(null);
                setToast('Model selected');
              }}
            >
              Use this model
              <Check size={16} />
            </Button>
          </Modal>
        )}
      </MotionPresence>
      <MotionPresence>
        {toast && (
          <div className="toast" role="status">
            <CheckCircle size={18} />
            {toast}
            <IconButton
              label="Dismiss notification"
              onClick={() => setToast('')}
            >
              <X size={15} />
            </IconButton>
          </div>
        )}
      </MotionPresence>
    </div>
  );
}
