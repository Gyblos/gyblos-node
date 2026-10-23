// Composes the approved mockup's shared Chat and Connect components in Electron.
// All sessions, budgets and connections stay in memory; no inference or gateway runs.
import {
  ChatCircle,
  GearSix,
  Moon,
  PlugsConnected,
  SidebarSimple,
  Sun,
} from '@phosphor-icons/react';
import { useState } from 'react';

import manifest from '../package.json';
import { themeStyle } from './theme.js';
import { Chat } from './ui/Chat.js';
import { ToolConnections } from './ui/ChatTools.js';
import {
  saveConnection,
  type ConnectionTool,
  type PreviewConnection,
} from './ui/connection-state.js';
import { ConnectionDialog, ConnectionList } from './ui/Connections.js';
import { PREVIEW_MODE, PREVIEW_MODELS } from './ui/constants.js';
import { Modal } from './ui/Modal.js';
import { ModelImage } from './ui/ModelImage.js';
import {
  animateChange,
  MotionPresence,
  SLIDE_DIRECTION,
  SLIDE_SURFACE,
} from './ui/Motion.js';
import type { ToolId } from './ui/tools.js';
import {
  Avatar,
  Badge,
  IconButton,
  List,
  ListRow,
  Note,
  RowCopy,
  SectionTitle,
} from './ui/UI.js';

export function DesktopApp() {
  const [mode, setMode] = useState<
    (typeof PREVIEW_MODE)[keyof typeof PREVIEW_MODE]
  >(PREVIEW_MODE.CHAT);
  const [light, setLight] = useState(false);
  const [sidebar, setSidebar] = useState(true);
  const [modelId, setModelId] = useState(PREVIEW_MODELS[0].id);
  const [catalog, setCatalog] = useState(false);
  const [settings, setSettings] = useState(false);
  const [webTools, setWebTools] = useState<ToolId[]>([]);
  const [connections, setConnections] = useState<PreviewConnection[]>([]);
  const [editing, setEditing] = useState<ConnectionTool | null>(null);
  const model =
    PREVIEW_MODELS.find((item) => item.id === modelId) ?? PREVIEW_MODELS[0];
  function toggleTool(id: ToolId) {
    setWebTools((previous) =>
      previous.includes(id)
        ? previous.filter((item) => item !== id)
        : [...previous, id],
    );
  }
  function changeMode(next: typeof mode) {
    if (next === mode) return;
    animateChange(
      () => setMode(next),
      next === PREVIEW_MODE.CONNECT
        ? SLIDE_DIRECTION.FORWARD
        : SLIDE_DIRECTION.BACKWARD,
      SLIDE_SURFACE.WORKSPACE,
    );
  }
  return (
    <div
      className={`desktop-frame desktop-shell${light ? ' light' : ''}${sidebar ? '' : ' sidebar-hidden'}`}
      style={themeStyle(light)}
    >
      <div className="desktop-body">
        <aside className="desktop-sidebar" inert={!sidebar}>
          <div className="sidebar-controls">
            <IconButton label="Hide sidebar" onClick={() => setSidebar(false)}>
              <SidebarSimple />
            </IconButton>
            <div
              className="mode-switch"
              role="group"
              aria-label="Chat and Connect modes"
            >
              <IconButton
                label="Chat"
                aria-pressed={mode === PREVIEW_MODE.CHAT}
                onClick={() => changeMode(PREVIEW_MODE.CHAT)}
              >
                <ChatCircle />
              </IconButton>
              <IconButton
                label="Connect"
                aria-pressed={mode === PREVIEW_MODE.CONNECT}
                onClick={() => changeMode(PREVIEW_MODE.CONNECT)}
              >
                <PlugsConnected />
              </IconButton>
            </div>
          </div>
          <div className="sidebar-section">{mode}</div>
          <div className="sidebar-bottom">
            <IconButton
              label={light ? 'Dark mode' : 'Light mode'}
              role="switch"
              aria-checked={light}
              onClick={() => setLight(!light)}
            >
              {light ? <Moon /> : <Sun />}
            </IconButton>
            <IconButton label="Settings" onClick={() => setSettings(true)}>
              <GearSix />
            </IconButton>
          </div>
        </aside>
        <div className="desktop-workspace">
          <header className="desktop-topbar">
            {!sidebar && (
              <IconButton label="Show sidebar" onClick={() => setSidebar(true)}>
                <SidebarSimple />
              </IconButton>
            )}
            <h1>{mode}</h1>
            <Badge>Simulated</Badge>
          </header>
          <div className="desktop-content">
            <div className="mode-pane" hidden={mode !== PREVIEW_MODE.CHAT}>
              <Chat
                model={model}
                models={PREVIEW_MODELS}
                online
                active={mode === PREVIEW_MODE.CHAT}
                connectedTools={webTools}
                onToggleTool={toggleTool}
                onSelectModel={setModelId}
                onBrowseModels={() => setCatalog(true)}
                onAuthorize={() => true}
              />
            </div>
            <div
              className="mode-pane connect-page"
              hidden={mode !== PREVIEW_MODE.CONNECT}
            >
              <SectionTitle
                trailing={<Badge>{connections.length} configured</Badge>}
              >
                Applications
              </SectionTitle>
              <p>
                Choose a model and daily budget for each tool on this computer.
              </p>
              <ConnectionList
                models={PREVIEW_MODELS}
                connections={connections}
                onEdit={setEditing}
              />
              <Note>
                Simulation only. No keys are created and no app settings or
                files are changed.
              </Note>
              <ToolConnections connected={webTools} onToggle={toggleTool} />
            </div>
          </div>
        </div>
      </div>
      <footer className="desktop-footer">
        <span>
          <i /> Local simulation
        </span>
        <span>Wallet not connected</span>
        <span>v{manifest.version}</span>
      </footer>
      <MotionPresence>
        {editing !== null && (
          <ConnectionDialog
            key={editing}
            tool={editing}
            existing={connections.find((item) => item.tool === editing)}
            models={PREVIEW_MODELS}
            defaultModelId={model.id}
            close={() => setEditing(null)}
            onSave={(policy) => {
              setConnections((previous) => saveConnection(previous, policy));
              setEditing(null);
            }}
            onRemove={(tool) => {
              setConnections((previous) =>
                previous.filter((item) => item.tool !== tool),
              );
              setEditing(null);
            }}
          />
        )}
      </MotionPresence>
      <MotionPresence>
        {catalog && (
          <Modal
            title="Models"
            description="Sample catalog. All responses are simulated."
            close={() => setCatalog(false)}
            compact
          >
            <List label="All preview models">
              {PREVIEW_MODELS.map((item) => (
                <ListRow
                  key={item.id}
                  onActivate={() => {
                    setModelId(item.id);
                    setCatalog(false);
                  }}
                  leading={
                    <Avatar>
                      <ModelImage artwork={item.image} name={item.name} />
                    </Avatar>
                  }
                  trailing={
                    <Badge>
                      {item.free
                        ? 'Free'
                        : `$${item.input} / $${item.output} /M`}
                    </Badge>
                  }
                >
                  <RowCopy title={item.name} detail={item.family} />
                </ListRow>
              ))}
            </List>
          </Modal>
        )}
      </MotionPresence>
      <MotionPresence>
        {settings && (
          <Modal title="Settings" close={() => setSettings(false)}>
            <Note>
              This desktop preview keeps conversations and connection budgets in
              memory. Closing the app clears them. Inference, web tools,
              payments and the gateway are simulated.
            </Note>
          </Modal>
        )}
      </MotionPresence>
    </div>
  );
}
