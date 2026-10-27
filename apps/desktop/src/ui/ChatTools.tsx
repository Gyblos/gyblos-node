// Optional web-tool connections for previewing the chat's extension flow.
// Never accepts keys, creates accounts, or calls third-party services.
import {
  CaretDown,
  Check,
  PlugsConnected,
  Wrench,
} from '@phosphor-icons/react';

import { BUTTON_VARIANT } from './constants.js';
import { Dropdown } from './Dropdown.js';
import { ServiceLogo } from './ServiceLogo.js';
import { TOOLS, type ToolId } from './tools.js';
import {
  Avatar,
  Badge,
  Button,
  List,
  ListRow,
  MenuItem,
  Note,
  RowCopy,
  SectionTitle,
} from './UI.js';

export function ToolConnections({
  connected,
  onToggle,
}: {
  connected: ToolId[];
  onToggle: (id: ToolId) => void;
}) {
  return (
    <section className="tool-connections">
      <SectionTitle trailing={<Badge>Optional</Badge>}>Web tools</SectionTitle>
      <p className="connections-description">
        Add search, page reading and browsing to Chat.
      </p>
      <List label="Web tool connections">
        {TOOLS.map((tool) => {
          return (
            <ListRow
              key={tool.id}
              leading={
                <Avatar>
                  <ServiceLogo service={tool.id} />
                </Avatar>
              }
              trailing={
                <Button
                  variant={BUTTON_VARIANT.SECONDARY}
                  aria-label={`${connected.includes(tool.id) ? 'Disconnect' : 'Connect'} ${tool.name}`}
                  onClick={() => onToggle(tool.id)}
                >
                  {connected.includes(tool.id) ? (
                    <Check size={16} />
                  ) : (
                    <PlugsConnected size={16} />
                  )}
                  {connected.includes(tool.id) ? 'Connected' : 'Connect'}
                </Button>
              }
            >
              <RowCopy
                title={`${tool.name} · ${tool.capability}`}
                detail={tool.description}
              />
            </ListRow>
          );
        })}
      </List>
      <Note>Choose which tools each conversation can use.</Note>
    </section>
  );
}
export function ChatToolChoices({
  query,
  connected,
  selected,
  onConnect,
  onSelect,
}: {
  query: string;
  connected: ToolId[];
  selected: ToolId[];
  onConnect: (id: ToolId) => void;
  onSelect: (id: ToolId) => void;
}) {
  const options = TOOLS.filter((tool) =>
    `${tool.name} ${tool.capability}`
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  return (
    <>
      {options.map((tool) => {
        const ready = connected.includes(tool.id);
        const enabled = ready && selected.includes(tool.id);
        return (
          <MenuItem
            key={tool.id}
            role="menuitemcheckbox"
            checked={enabled}
            label={tool.name}
            detail={tool.capability}
            leading={<ServiceLogo service={tool.id} />}
            trailing={
              enabled ? (
                <Check size={16} />
              ) : !ready ? (
                <span className="dropdown-hint">Connect</span>
              ) : null
            }
            aria-label={`${enabled ? 'Disable' : ready ? 'Enable' : 'Connect and enable'} ${tool.name}`}
            onClick={() => {
              if (!ready) onConnect(tool.id);
              onSelect(tool.id);
            }}
          />
        );
      })}
      {!options.length && (
        <p className="dropdown-note" role="status">
          No tools found
        </p>
      )}
      <p className="dropdown-note" title="Tool fees are set by each service.">
        Pricing set by provider
      </p>
    </>
  );
}

// One searchable tools menu, shared by conversations and agent tasks.
export function ToolsDropdown({
  connected,
  selected,
  onConnect,
  onSelect,
  label = 'Choose chat tools',
}: {
  connected: ToolId[];
  selected: ToolId[];
  onConnect: (id: ToolId) => void;
  onSelect: (id: ToolId) => void;
  label?: string;
}) {
  return (
    <Dropdown
      label={label}
      searchLabel="Search tools"
      className={`chat-tools-button${selected.length ? ' has-tools' : ''}`}
      trigger={
        <>
          <Wrench size={14} />
          <span>Tools{selected.length ? ` ${selected.length}` : ''}</span>
          <CaretDown size={12} />
        </>
      }
    >
      {(_close, query) => (
        <ChatToolChoices
          query={query}
          connected={connected}
          selected={selected}
          onConnect={onConnect}
          onSelect={onSelect}
        />
      )}
    </Dropdown>
  );
}
