// Explores a buyer desktop app with Chat and local gateway connections.
// Inference/Connect remain simulated; Wallet receives public local metadata only.
import {
  ArrowUp,
  CaretDown,
  CaretRight,
  ChartBar,
  ChatCircle,
  Check,
  CheckCircle,
  Clock,
  Code,
  GearSix,
  Globe,
  MagnifyingGlass,
  Palette,
  PlugsConnected,
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
import { themeStyle } from './theme';
import { AddFunds } from './ui/AddFunds';
import { Appearance } from './ui/Appearance';
import { matchesCatalog, type ModelFilter } from './ui/catalog-state';
import { Chat, type ChatHandle } from './ui/Chat';
import { ToolConnections } from './ui/ChatTools';
import {
  saveConnection,
  type ConnectionTool,
  type PreviewConnection,
} from './ui/connection-state';
import { ConnectionDialog, ConnectionList } from './ui/Connections';
import {
  BUTTON_VARIANT,
  MODE_NAV,
  MODEL_FILTER,
  MODELS,
  MODES,
  NAVIGATION_WIDTH,
  ROUTE_ORDER,
  SIDEBAR_MOTION_MS,
  UI_DIALOG,
  UI_VIEW,
} from './ui/constants';
import { authorizeDemo, DEMO_ACCOUNT, DEMO_AUTH } from './ui/demo-account';
import { Modal } from './ui/Modal';
import type { Mode, CatalogModel as Model, View } from './ui/model-types';
import { ModelImage, type ModelArtwork } from './ui/ModelImage';
import {
  animateChange,
  MotionPresence,
  SLIDE_DIRECTION,
  SLIDE_SURFACE,
} from './ui/Motion';
import { NetworkStatus, useLocalNode } from './ui/NetworkStatus';
import { ResizeHandle } from './ui/ResizeHandle';
import { SidebarIcon, type SidebarSection } from './ui/SidebarIcon';
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
  StatCard,
} from './ui/UI';
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
  const [view, setView] = useState<View>(UI_VIEW.CHAT);
  const [mode, setMode] = useState<Mode>(UI_VIEW.CHAT);
  const navigation = MODE_NAV[mode];
  function navigate(next: View) {
    if (next === view) return;
    const currentIndex = ROUTE_ORDER.findIndex((item) => item === view);
    const nextIndex = ROUTE_ORDER.findIndex((item) => item === next);
    animateChange(
      () => {
        if (next === UI_VIEW.CHAT || next === UI_VIEW.CONNECT) setMode(next);
        setView(next);
      },
      nextIndex > currentIndex
        ? SLIDE_DIRECTION.FORWARD
        : SLIDE_DIRECTION.BACKWARD,
      SLIDE_SURFACE.WORKSPACE,
    );
  }
  const [navigationWidth, setNavigationWidth] = useState<number>(
    NAVIGATION_WIDTH.MIN,
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
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
  const modifier = /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+';
  const [light, setLight] = useState(false);
  const frameStyle: CSSProperties & { '--navigation-width': string } = {
    '--navigation-width': navigationWidth + 'px',
    ...themeStyle(light),
  };
  const network = useLocalNode();
  const wallet = useDesktopWallet();
  // Chat and Connect remain simulated independently of local endpoint readiness.
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
  const [paidModel, setPaidModel] = useState<Model | null>(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ModelFilter>(MODEL_FILTER.ALL);
  const [selectedApp, setSelectedApp] = useState<ConnectionTool | null>(null);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [apps, setApps] = useState<PreviewConnection[]>([]);
  const [toast, setToast] = useState('');
  const chatRef = useRef<ChatHandle>(null);
  const [chatRequestCount, setChatRequestCount] = useState(0);
  const [connectedTools, setConnectedTools] = useState<ToolId[]>([]);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    content.current?.scrollTo({ top: 0 });
  }, [view, mode]);
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
      } else if (key === 'k') {
        event.preventDefault();
        navigate(UI_VIEW.MODELS);
      } else if (key === 'n' && view === UI_VIEW.CHAT) {
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
  }, [view, mode]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), DEMO_ACCOUNT.TOAST_MS);
    return () => clearTimeout(timer);
  }, [toast]);
  function choose(next: Model) {
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
    setChatRequestCount((value) => value + 1);
    return result.status;
  }
  function toggleTool(id: ToolId) {
    setConnectedTools((previous) =>
      previous.includes(id)
        ? previous.filter((item) => item !== id)
        : [...previous, id],
    );
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
          <IconButton
            className="sidebar-toggle"
            label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-controls="app-sidebar"
            aria-expanded={!sidebarCollapsed}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            onClick={toggleSidebar}
          >
            <SidebarSimple size={16} aria-hidden="true" />
          </IconButton>
          <h1 id="route-title">{view}</h1>
        </div>
        <div className="top-actions">
          <Button
            variant={BUTTON_VARIANT.SECONDARY}
            className="command-trigger"
            title={'Choose model (' + modifier + 'K)'}
            onClick={() => {
              navigate(UI_VIEW.MODELS);
            }}
          >
            <MagnifyingGlass size={14} />
            <span>Choose model</span>
            <kbd>{modifier}K</kbd>
          </Button>
          <Button
            variant={BUTTON_VARIANT.SECONDARY}
            className="balance-button"
            title="Wallet · 0.0 USDC"
            onClick={() => navigate(UI_VIEW.SETTINGS)}
          >
            <Wallet size={17} />
            <span aria-hidden="true">0.0</span>
          </Button>
        </div>
      </header>
      <aside
        id="app-sidebar"
        className="sidebar"
        inert={sidebarCollapsed}
        aria-hidden={sidebarCollapsed || undefined}
      >
        <div className="sidebar-controls">
          <div
            className="ui-segmented"
            role="group"
            aria-label="Chat and Connect modes"
          >
            {MODES.map((nextMode) => (
              <IconButton
                key={nextMode}
                label={nextMode}
                title={nextMode}
                aria-pressed={mode === nextMode}
                onClick={() => navigate(nextMode)}
              >
                {nextMode === UI_VIEW.CHAT ? (
                  <ChatCircle size={16} aria-hidden="true" />
                ) : (
                  <PlugsConnected size={16} aria-hidden="true" />
                )}
              </IconButton>
            ))}
          </div>
        </div>
        <nav aria-label="Main navigation">
          {navigation.map((item, index) => (
            <Button
              className={'nav-item ' + (view === item.name ? 'active' : '')}
              key={item.name}
              title={item.label + ' (' + modifier + (index + 1) + ')'}
              aria-label={item.label}
              aria-current={view === item.name ? 'page' : undefined}
              onClick={() => {
                navigate(item.name);
              }}
            >
              <SidebarIcon name={item.name} />
              <span>{item.label}</span>
            </Button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <IconButton
            label="Settings"
            aria-current={view === UI_VIEW.SETTINGS ? 'page' : undefined}
            onClick={() => navigate(UI_VIEW.SETTINGS)}
          >
            <GearSix size={17} />
          </IconButton>
          <Appearance light={light} onLightChange={setLight} compact />
        </div>
      </aside>
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
          initial={NAVIGATION_WIDTH.MIN}
          controls="app-sidebar app-workspace"
          onChange={setNavigationWidth}
        />
      </div>
      <div id="app-workspace" className="app-body">
        <div
          ref={content}
          className={'content ' + (view === UI_VIEW.CHAT ? 'chat-content' : '')}
        >
          <div className="chat-root" hidden={view !== UI_VIEW.CHAT}>
            <Chat
              ref={chatRef}
              active={view === UI_VIEW.CHAT}
              model={model}
              online={online}
              onAuthorize={authorizeChatRequest}
              connectedTools={connectedTools}
              onToggleTool={toggleTool}
              models={MODELS}
              onSelectModel={(id) => {
                const next = MODELS.find((item) => item.id === id);
                if (next) choose(next);
              }}
              onBrowseModels={() => navigate(UI_VIEW.MODELS)}
            />
          </div>
          {view === UI_VIEW.MODELS && (
            <PagePanel>
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
              <SectionTitle>Catalog</SectionTitle>
              <List label="Model catalog">
                {MODELS.filter((item) =>
                  matchesCatalog(item, search, filter),
                ).map((item) => (
                  <ListRow
                    key={item.id}
                    leading={<ModelIcon model={item} />}
                    onActivate={() => choose(item)}
                    selected={model.id === item.id}
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
                        {model.id === item.id && <Check size={16} />}
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
              <InfoBar
                leading={<Globe size={16} />}
                trailing={
                  <Button
                    variant={BUTTON_VARIANT.SECONDARY}
                    onClick={() => navigate(mode)}
                  >
                    {mode === UI_VIEW.CHAT
                      ? 'Back to chat'
                      : 'Back to applications'}
                  </Button>
                }
              >
                <span>Providers are selected for your chosen model.</span>
              </InfoBar>
            </PagePanel>
          )}
          {view === UI_VIEW.CONNECT && (
            <PagePanel>
              <SectionTitle trailing={<Badge>{apps.length} configured</Badge>}>
                On this computer
              </SectionTitle>
              <p className="connections-description">
                Choose a tool, model and daily budget. Gyblos handles the
                connection.
              </p>

              <ConnectionList
                connections={apps}
                models={MODELS}
                onEdit={(tool) => {
                  setSelectedApp(tool);
                  setConnectionOpen(true);
                }}
              />
              <Note>Each application has its own model and daily budget.</Note>
              <InfoBar leading={<PlugsConnected size={16} />}>
                <div>
                  <strong>Local gateway</strong>
                  <p className="modal-note">
                    Your tools use Gyblos while this app is open. Server and
                    remote access are under Advanced in each connection.
                  </p>
                </div>
              </InfoBar>
            </PagePanel>
          )}
          {view === UI_VIEW.TOOLS && (
            <PagePanel>
              <ToolConnections
                connected={connectedTools}
                onToggle={toggleTool}
              />
            </PagePanel>
          )}
          {view === UI_VIEW.SETTINGS && (
            <PagePanel>
              <div className="settings-content">
                <SettingsGroup
                  leading={<Wallet size={18} aria-hidden="true" />}
                  title="Wallet & backup"
                  description="Your address, key protection and recovery backup."
                >
                  <WalletDetails
                    onBackup={() => setModal(UI_DIALOG.BACKUP)}
                    onAddFunds={() => setModal(UI_DIALOG.ADD_FUNDS)}
                  />
                </SettingsGroup>
                <SettingsGroup
                  leading={<ChartBar size={18} aria-hidden="true" />}
                  title="Chat spending"
                  description="Choose how much you can spend on chat each day."
                >
                  <List label="Chat spending limit">
                    <ListRow
                      leading={null}
                      trailing={
                        <Button
                          variant={BUTTON_VARIANT.TONAL}
                          onClick={() => {
                            setModal(UI_DIALOG.BUDGET);
                          }}
                        >
                          Edit limit
                        </Button>
                      }
                    >
                      <RowCopy
                        title="Daily spending limit"
                        detail={money(budget) + ' per day'}
                      />
                    </ListRow>
                  </List>
                </SettingsGroup>
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
                </SettingsGroup>
              </div>
            </PagePanel>
          )}
          {view === UI_VIEW.ACTIVITY && (
            <PagePanel>
              <div className="ui-stats">
                <StatCard
                  label="Spent today"
                  value={money(spent)}
                  detail={`Daily limit: ${money(budget)} per day`}
                />
                <StatCard
                  label="Requests"
                  value={
                    mode === UI_VIEW.CHAT
                      ? String(chatRequestCount + DEMO_ACCOUNT.SAMPLE_REQUESTS)
                      : '0'
                  }
                  detail={
                    mode === UI_VIEW.CHAT
                      ? 'Requests today'
                      : 'No application requests yet'
                  }
                />
                <StatCard
                  label="Available balance"
                  value={money(credits)}
                  detail="USDC"
                />
              </div>
              <SectionTitle
                trailing={
                  <Badge>{mode === UI_VIEW.CHAT ? 'Chat' : 'Connect'}</Badge>
                }
              >
                Recent requests
              </SectionTitle>
              <List label="Recent requests">
                {(mode === UI_VIEW.CHAT
                  ? [MODELS[0], MODELS[1], MODELS[0], MODELS[1]]
                  : []
                ).map((item, index) => (
                  <ListRow
                    key={index}
                    leading={<ModelIcon model={item} />}
                    trailing={
                      <>
                        <span className="ui-row-time">
                          {index * 6 + 2} min ago
                        </span>
                        <span className="ui-status">
                          <CheckCircle size={14} />
                          Completed
                        </span>
                        <strong className="ui-amount">$0.00</strong>
                      </>
                    }
                  >
                    <RowCopy title={item.name} detail="Chat · This Mac" />
                  </ListRow>
                ))}
              </List>
              {mode === UI_VIEW.CONNECT && (
                <Note>
                  No application requests yet. Connection setup does not
                  generate inference traffic.
                </Note>
              )}
              <Note>
                Pending payments stay visible until their outcome is confirmed.
              </Note>
            </PagePanel>
          )}
        </div>
      </div>
      <footer className="app-footer" aria-label="Application status">
        <NetworkStatus state={network.state} onRetry={network.retry} />
        <Button
          title="Wallet settings"
          onClick={() => navigate(UI_VIEW.SETTINGS)}
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
        {modal === UI_DIALOG.ADD_FUNDS && (
          <Modal
            title="Add funds"
            description="Choose how much to add to your wallet."
            close={() => setModal(null)}
          >
            <AddFunds
              onBackup={() => {
                setModal(null);
                navigate(UI_VIEW.SETTINGS);
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
            description="Applies to paid messages in Chat."
            close={() => setModal(null)}
          >
            <label className="field-label" htmlFor={UI_DIALOG.BUDGET}>
              Daily limit ($)
            </label>
            <input
              className="full-input"
              id={UI_DIALOG.BUDGET}
              type="number"
              min="0"
              value={budgetDraft}
              onChange={(event) => setBudgetDraft(event.target.value)}
            />
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
        {connectionOpen && (
          <ConnectionDialog
            key={selectedApp ?? 'new'}
            tool={selectedApp}
            existing={apps.find((item) => item.tool === selectedApp)}
            models={MODELS}
            defaultModelId={model.id}
            close={() => setConnectionOpen(false)}
            onSave={(policy) => {
              setApps((previous) => saveConnection(previous, policy));
              setConnectionOpen(false);
              setToast(
                selectedApp && apps.some((item) => item.tool === selectedApp)
                  ? 'Connection updated'
                  : 'Connection saved',
              );
            }}
            onRemove={(tool) => {
              setApps((previous) =>
                previous.filter((item) => item.tool !== tool),
              );
              setConnectionOpen(false);
              setToast('Connection removed');
            }}
          />
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
