// Hosts the buyer desktop, including the local PayPal Sandbox inference session.
// Native chat uses the buyer bridge for x402 or the separate PayPal coordinator.
import { Check, CheckCircle, X } from '@phosphor-icons/react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';

import { MODEL_IDS } from '@gyblos/protocol/constants';

import manifest from '../package.json';
import { WINDOW_CHROME } from './constants';
import {
  autoFundingAvailable,
  autoFundingNotice,
  type ReplacementTerms,
} from './funding/model';
import {
  canSelectPreviewModel,
  canSwitchPaymentMethod,
  PAYMENT_METHOD,
  paypalSessionCanConnectAgent,
  shouldMonitorPaypal,
  type PaymentMethod,
} from './paypal-model';
import { prefersLightTheme, themeStyle } from './theme';
import { Activity } from './ui/Activity';
import {
  announcedModels,
  automaticOffersAvailable,
} from './ui/announced-models';
import { Applications } from './ui/Applications';
import { AddBuyerFunds } from './ui/BuyerFunding';
import { BuyerSidebar } from './ui/BuyerSidebar';
import { Chat, type ChatHandle } from './ui/Chat';
import { ChatController } from './ui/chat-controller';
import { ChatPaymentSelector } from './ui/ChatPaymentSelector';
import {
  BUTTON_VARIANT,
  MAIN_NAV,
  MODELS,
  NAVIGATION_WIDTH,
  ROUTE_ORDER,
  SIDEBAR_MOTION_MS,
  UI_DIALOG,
  UI_VIEW,
  WORKSPACE_BREAKPOINT,
} from './ui/constants';
import { ConversationDetails } from './ui/ConversationDetails';
import { authorizeDemo, DEMO_ACCOUNT, DEMO_AUTH } from './ui/demo-account';
import { DesignSystem } from './ui/DesignSystem';
import { FormField, FormInput } from './ui/Form';
import { Modal } from './ui/Modal';
import { usdPerMtok } from './ui/model-price';
import type { CatalogModel as Model, View } from './ui/model-types';
import { ModelImage } from './ui/ModelImage';
import { Models } from './ui/Models';
import {
  animateChange,
  MotionPresence,
  SLIDE_DIRECTION,
  SLIDE_SURFACE,
} from './ui/Motion';
import {
  back,
  createNavigation,
  forward,
  HISTORY_KEY,
  historyShortcut,
  navigate as navigateState,
} from './ui/navigation-state';
import { useNetworkCatalog } from './ui/NetworkCatalog';
import { useLocalNode } from './ui/NetworkStatus';
import { PageBody } from './ui/PageBody';
import { PaidSellerDialog } from './ui/PaidSellerDialog';
import { Payments } from './ui/Payments';
import { PaypalAgentConnection } from './ui/PaypalAgentConnection';
import { Settings } from './ui/Settings';
import { SystemStatus } from './ui/SystemStatus';
import type { ToolId } from './ui/tools';
import { Button, IconButton } from './ui/UI';
import { UpdateNotice, useDesktopUpdate } from './ui/UpdateNotice';
import { UsdcApiKeys } from './ui/UsdcApiKeys';
import { useActivity } from './ui/useActivity';
import { useChatArchive } from './ui/useChatArchive';
import { usePaypalSession } from './ui/usePaypalSession';
import { useX402 } from './ui/useX402';
import { WalletBackup } from './ui/WalletBackup';
import { useDesktopWallet } from './ui/WalletState';
import { WindowTitlebar } from './ui/WindowTitlebar';

const money = (value: number) => '$' + value.toFixed(2);
export function DesktopApp() {
  const [route, setRoute] = useState(createNavigation);
  const view = route.current;
  const navigation = MAIN_NAV;
  function navigate(next: View) {
    if (next === view) return;
    const currentIndex = ROUTE_ORDER.findIndex((item) => item === view);
    const nextIndex = ROUTE_ORDER.findIndex((item) => item === next);
    animateChange(
      () => {
        setRoute((current) => navigateState(current, next));
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
  function goForward() {
    animateChange(
      () => setRoute(forward),
      SLIDE_DIRECTION.FORWARD,
      SLIDE_SURFACE.WORKSPACE,
    );
  }
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => window.innerWidth < WORKSPACE_BREAKPOINT.SIDEBAR,
  );
  const update = useDesktopUpdate();
  const [updateOpen, setUpdateOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [managePaypal, setManagePaypal] = useState(false);
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
  const [light, setLight] = useState(prefersLightTheme);
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
  const x402 = useX402();
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
  const frameStyle: CSSProperties & {
    '--navigation-width': string;
    '--shell-header-height': string;
  } = {
    '--navigation-width': NAVIGATION_WIDTH.DEFAULT + 'px',
    '--shell-header-height': WINDOW_CHROME.HEIGHT + 'px',
    ...themeStyle(light),
  };
  const network = useLocalNode();
  const wallet = useDesktopWallet();
  const announcements = useNetworkCatalog();
  const now = Date.now();
  const networkModels = announcedModels(announcements.snapshot, now);
  const found = announcedModels(announcements.searchResult, now);
  const ids = new Set(networkModels.map((item) => item.id));
  networkModels.push(...found.filter((item) => !ids.has(item.id)));
  const autoModels =
    x402.state.policy?.autoRoutes
      ?.map((route) => route.modelId)
      .filter((name) =>
        automaticOffersAvailable(
          name,
          networkModels,
          !!x402.state.policy?.paidAuto && x402.state.policy.maxAtomic !== '0',
        ),
      ) ?? [];
  const chatModels = [MODELS[0], ...networkModels, ...MODELS.slice(1)];
  // Transport readiness and spending permission are independently enforced by each real coordinator.
  const online = true;
  const [model, setModel] = useState(MODELS[0]);
  const [credits, setCredits] = useState(0);
  const [spent, setSpent] = useState(0);
  const [budget, setBudget] = useState<number>(DEMO_ACCOUNT.DEFAULT_BUDGET);
  const [budgetDraft, setBudgetDraft] = useState(
    String(DEMO_ACCOUNT.DEFAULT_BUDGET),
  );
  const [modal, setModal] = useState<
    (typeof UI_DIALOG)[keyof typeof UI_DIALOG] | null
  >(null);
  const [confirmedPolicy, setConfirmedPolicy] = useState<string>();
  const [replacement, setReplacement] = useState<ReplacementTerms>();
  const [paidModel, setPaidModel] = useState<Model | null>(null);
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
      const editing =
        event.target instanceof HTMLElement &&
        (event.target.isContentEditable ||
          Boolean(
            event.target.closest('input, textarea, select, [role="textbox"]'),
          ));
      const direction = historyShortcut(
        event,
        editing || Boolean(document.querySelector('dialog[open]')),
      );
      if (direction) {
        event.preventDefault();
        if (direction === HISTORY_KEY.BACK) goBack();
        else goForward();
        return;
      }
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
        navigate(destination);
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
  const autoAttempt = useRef(0);
  useEffect(() => {
    autoAttempt.current++;
  }, [x402.state.policy?.policyId, view, paymentMethod]);
  async function chooseAuto(name: string) {
    const policy = x402.state.policy;
    if (!policy?.autoRoutes?.some((route) => route.modelId === name)) return;
    const offers = networkModels.filter((item) => item.name === name);
    const listing = offers[0];
    if (!listing) return;
    const attempt = ++autoAttempt.current;
    const paid =
      name === MODEL_IDS.QWEN3_0_6B &&
      policy.paidAuto &&
      policy.maxAtomic !== '0';
    if (!automaticOffersAvailable(name, offers, !!paid)) {
      setToast(
        name === MODEL_IDS.QWEN3_0_6B
          ? 'Only paid offers are listed. Enable paid Auto in Payments.'
          : 'No free offers are listed for this model.',
      );
      if (name === MODEL_IDS.QWEN3_0_6B) navigate(UI_VIEW.PAYMENTS);
      return;
    }
    if (!offers.some((item) => item.free)) {
      setToast('Checking channel funds…');
      const funding = await Promise.all(
        offers.map(async (item) =>
          item.offerId
            ? ((await window.desktopFunding
                ?.balance(item.offerId)
                .catch(() => null)) ?? null)
            : null,
        ),
      );
      if (attempt !== autoAttempt.current) return;
      const available = autoFundingAvailable(policy, funding, !!paid);
      if (available !== true) {
        setToast(autoFundingNotice(available));
        navigate(UI_VIEW.PAYMENTS);
        if (available === false) setModal(UI_DIALOG.ADD_FUNDS);
        return;
      }
    }
    setModel({
      id: 'auto/' + name,
      automatic: true,
      name,
      image: listing.image,
      family: 'Auto',
      context: listing.context,
      category: listing.category,
      providers: listing.providers,
      input: 0,
      output: 0,
      free: !paid,
    });
    setConfirmedPolicy(policy.policyId);
    setToast(name + ' · Auto selected');
  }
  function choose(next: Model) {
    autoAttempt.current++;
    if (paymentMethod === PAYMENT_METHOD.PAYPAL) return;
    if (next.id === model.id && (!next.offerId || next.free)) return;
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
    if (!canSwitchPaymentMethod(paymentMethod, next, paypalBusy, chatBusy)) {
      setToast('Finish the current response before switching payment methods.');
      return false;
    }
    setPaymentMethod(next);
    return true;
  }
  function reviewPaypalPayments() {
    if (!changePaymentMethod(PAYMENT_METHOD.PAYPAL)) return;
    setManagePaypal(true);
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
      <WindowTitlebar
        notify={setToast}
        route={route}
        onNewChat={() => chatRef.current?.newChat()}
        chat={chatController}
        collapsed={sidebarCollapsed}
        contextOpen={contextOpen}
        onSidebar={toggleSidebar}
        onBack={goBack}
        onForward={goForward}
        onContext={() => setContextOpen((open) => !open)}
      >
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
              <span className="ui-window-action-label">
                Review PayPal session
              </span>
            </Button>
          )}
      </WindowTitlebar>
      <BuyerSidebar
        view={view}
        collapsed={sidebarCollapsed}
        chat={chatController}
        storageState={conversationStorage}
        navigate={(next) => {
          navigate(next);
        }}
        onNewChat={() => {
          chatRef.current?.newChat();
          navigate(UI_VIEW.CHAT);
        }}
        onOpenChat={(id) => {
          chatRef.current?.openChat(id);
          navigate(UI_VIEW.CHAT);
        }}
      />
      <div id="app-workspace" className="app-body">
        <PageBody
          ref={content}
          chat={view === UI_VIEW.CHAT}
          split={view === UI_VIEW.CONNECT}
        >
          {view === UI_VIEW.CHAT && contextOpen && (
            <ConversationDetails
              chat={chatController}
              close={() => {
                setContextOpen(false);
                requestAnimationFrame(() =>
                  document.getElementById('chat-details-toggle')?.focus(),
                );
              }}
            />
          )}
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
              showToolbar={false}
              paymentMethod={paymentMethod}
              paymentControl={paymentSelector()}
              paypal={paypal}
              x402={x402}
              onReviewX402={() => navigate(UI_VIEW.PAYMENTS)}
              onBusyChange={setChatBusy}
              model={model}
              online={online}
              onAuthorize={authorizeChatRequest}
              connectedTools={connectedTools}
              onConnections={() => navigate(UI_VIEW.CONNECT)}
              onBrowseApplications={() => navigate(UI_VIEW.TOOLS)}
              models={chatModels}
              confirmedPolicy={confirmedPolicy}
              replacement={replacement}
              onDefaultModel={() => setModel(MODELS[0])}
              autoModels={autoModels}
              onAutoModel={(name) => void chooseAuto(name)}
              onSelectModel={(id) => {
                const next = chatModels.find((item) => item.id === id);
                if (next) choose(next);
              }}
              onBrowseModels={() => navigate(UI_VIEW.MODELS)}
              onReviewPaypal={() => {
                reviewPaypalPayments();
              }}
            />
          </div>
          {view === UI_VIEW.MODELS && (
            <Models
              selected={model.id}
              canSelect={canSelectPreviewModel(paymentMethod)}
              onSelect={choose}
              catalog={announcements}
              networkModels={networkModels}
              auto={
                x402.state.policy && {
                  policy: x402.state.policy,
                  buyerModels: autoModels,
                  paid: !!x402.state.policy.paidAuto,
                  selected: !!model.automatic,
                  choose: (name) => void chooseAuto(name),
                }
              }
            />
          )}
          {view === UI_VIEW.CONNECT &&
            paymentMethod === PAYMENT_METHOD.USDC && (
              <UsdcApiKeys
                contextOpen={contextOpen}
                onCloseContext={() => setContextOpen(false)}
                onPayments={() => navigate(UI_VIEW.PAYMENTS)}
              />
            )}
          {view === UI_VIEW.CONNECT &&
            paymentMethod === PAYMENT_METHOD.PAYPAL && (
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
          {view === UI_VIEW.TOOLS && <Applications />}
          {(view === UI_VIEW.PAYMENTS || view === UI_VIEW.ACTIVITY) && (
            <Payments
              key={view}
              initialTab={view === UI_VIEW.ACTIVITY ? 'activity' : undefined}
              usage={
                <Activity
                  x402={x402}
                  activity={activity}
                  chat={chatController}
                  selectedSession={activitySession}
                  onSelectSession={setActivitySession}
                  onPayments={() => {
                    reviewPaypalPayments();
                  }}
                  onOpenChat={(id) => {
                    chatRef.current?.openChat(id);
                    navigate(UI_VIEW.CHAT);
                  }}
                />
              }
              chat={chatController}
              onOpenChat={(id) => {
                chatRef.current?.openChat(id);
                navigate(UI_VIEW.CHAT);
              }}
              x402={x402}
              session={paypal}
              activity={activity}
              managePaypal={managePaypal}
              onManagePaypal={setManagePaypal}
              onPaymentMethod={changePaymentMethod}
              onChat={() => navigate(UI_VIEW.CHAT)}
              onConnections={() => navigate(UI_VIEW.CONNECT)}
              onActivity={(id) => {
                setActivitySession(id ?? null);
                navigate(UI_VIEW.ACTIVITY);
              }}
              onBackup={() => setModal(UI_DIALOG.BACKUP)}
              onAddFunds={() => setModal(UI_DIALOG.ADD_FUNDS)}
            />
          )}
          {view === UI_VIEW.SETTINGS && (
            <Settings
              light={light}
              onLightChange={setLight}
              version={manifest.version}
            />
          )}
        </PageBody>
      </div>
      <footer className="preview-status-bar" aria-label="App status">
        <SystemStatus
          update={update}
          onUpdate={() => setUpdateOpen(true)}
          state={network.state}
          onRetry={network.retry}
          onPayments={() => navigate(UI_VIEW.PAYMENTS)}
        />
        <span className="preview-status-end">
          <UpdateNotice
            update={update}
            open={updateOpen}
            setOpen={setUpdateOpen}
          />
          <span className="preview-version">Gyblos {manifest.version}</span>
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
          <Modal title="Add funds · Testnet" close={() => setModal(null)}>
            <AddBuyerFunds payer={x402.state.policy?.payer} />
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
        {paidModel?.offerId ? (
          <PaidSellerDialog
            key={paidModel.id}
            model={paidModel}
            buyer={x402}
            addFunds={() => {
              setPaidModel(null);
              navigate(UI_VIEW.PAYMENTS);
              setModal(UI_DIALOG.ADD_FUNDS);
            }}
            close={() => setPaidModel(null)}
            confirm={(policyId, consent) => {
              setReplacement(consent);
              setConfirmedPolicy(policyId);
              setModel(paidModel);
              setPaidModel(null);
              setToast('Model selected');
            }}
          />
        ) : (
          paidModel && (
            <Modal title="Use a paid model?" close={() => setPaidModel(null)}>
              <div className="paid-model-summary">
                <ModelImage name={paidModel.name} artwork={paidModel.image} />
                <strong>{paidModel.name}</strong>
              </div>
              <div className="paid-terms">
                <div>
                  <span>Input / 1M tokens</span>
                  <strong>{usdPerMtok(paidModel.input)}</strong>
                </div>
                <div>
                  <span>Output / 1M tokens</span>
                  <strong>{usdPerMtok(paidModel.output)}</strong>
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
                Use this model <Check size={16} />
              </Button>
            </Modal>
          )
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
