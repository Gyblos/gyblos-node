// Shared tool connection list and editor; the local gateway flow is simulated.
import {
  Cloud,
  Desktop,
  HardDrives,
  PlugsConnected,
  Plus,
  Trash,
} from '@phosphor-icons/react';
import { useState } from 'react';

import {
  CONNECTION_TOOLS,
  connectionModelId,
  connectionPolicy,
  type ConnectionTool,
  type PreviewConnection,
} from './connection-state';
import { BUTTON_VARIANT } from './constants';
import { FormActions, FormField, FormInput } from './Form';
import { Modal } from './Modal';
import { ModelDropdown, type ModelOption } from './ModelDropdown';
import { ServiceLogo } from './ServiceLogo';
import { Avatar, Badge, Button, List, ListRow, Note, RowCopy } from './UI';

export function ConnectionList({
  connections,
  models,
  onEdit,
  compact = false,
}: {
  connections: readonly PreviewConnection[];
  models: readonly [ModelOption, ...ModelOption[]];
  onEdit: (tool: ConnectionTool) => void;
  compact?: boolean;
}) {
  const tools = compact
    ? connections.map((item) => item.tool)
    : CONNECTION_TOOLS;
  return (
    <div className={compact ? 'connection-list-compact' : undefined}>
      <List label="Tool connections">
        {tools.map((tool) => {
          const connection = connections.find((item) => item.tool === tool);
          const model = models.find((item) => item.id === connection?.modelId);
          return (
            <ListRow
              key={tool}
              leading={
                <Avatar>
                  <ServiceLogo service={tool} />
                </Avatar>
              }
              onActivate={compact ? () => onEdit(tool) : undefined}
              trailing={
                !compact && (
                  <Button
                    variant={BUTTON_VARIANT.SECONDARY}
                    onClick={() => onEdit(tool)}
                  >
                    {connection ? 'Manage' : 'Connect'}
                  </Button>
                )
              }
            >
              <RowCopy
                title={tool}
                detail={
                  connection
                    ? `${model?.name ?? 'Model unavailable'} · $${connection.dailyBudget.toFixed(2)}/day · This computer`
                    : 'Use Gyblos inference in your tool'
                }
              />
            </ListRow>
          );
        })}
        {!tools.length && (
          <p className="pane-empty-copy">No tools connected yet.</p>
        )}
      </List>
    </div>
  );
}

export function ConnectionDialog({
  tool,
  existing,
  models,
  defaultModelId,
  onSave,
  onRemove,
  close,
}: {
  tool: ConnectionTool | null;
  existing?: PreviewConnection;
  models: readonly [ModelOption, ...ModelOption[]];
  defaultModelId: string;
  onSave: (policy: PreviewConnection) => void;
  onRemove: (tool: ConnectionTool) => void;
  close: () => void;
}) {
  const [selectedTool, setSelectedTool] = useState<ConnectionTool>(
    tool ?? CONNECTION_TOOLS[0],
  );
  const [modelId, setModelId] = useState(() =>
    connectionModelId(existing?.modelId ?? defaultModelId, models),
  );
  const [budget, setBudget] = useState(
    existing ? String(existing.dailyBudget) : '2',
  );
  const model = models.find((item) => item.id === modelId) ?? models[0];
  const policy = connectionPolicy(selectedTool, modelId, budget);
  return (
    <Modal
      title={existing ? `Manage ${selectedTool}` : 'Connect a tool'}
      description="Choose a model and budget for this tool."
      close={close}
    >
      <form
        className="ui-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (policy && model) onSave(policy);
        }}
      >
        <div className="connection-location">
          <Desktop size={16} />
          <strong>This computer</strong>
          <Badge>Default</Badge>
        </div>
        <FormField htmlFor="connection-tool" label="Tool">
          <select
            id="connection-tool"
            className="ui-input"
            value={selectedTool}
            disabled={!!existing}
            onChange={(event) => {
              const next = CONNECTION_TOOLS.find(
                (item) => item === event.target.value,
              );
              if (next) setSelectedTool(next);
            }}
          >
            {CONNECTION_TOOLS.map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
        </FormField>
        <div className="ui-field">
          <span>Model</span>
          <ModelDropdown
            model={model}
            models={models}
            onSelect={setModelId}
            label="Choose connection model"
            onBrowse={() => {}}
            showBrowse={false}
          />
        </div>
        <FormField htmlFor="connection-budget" label="Daily budget (USD)">
          <FormInput
            id="connection-budget"
            type="number"
            min="0.01"
            max="10000"
            step="0.01"
            value={budget}
            onChange={(event) => setBudget(event.target.value)}
            required
          />
        </FormField>
        <p className="modal-note">
          Independent per tool. Free model requests do not use the limit. Gyblos
          must stay open on this computer.
        </p>
        <section className="ui-section" aria-label="Planned connection options">
          <h3 className="ui-subheading">Planned connection options</h3>
          <List label="Advanced connection options">
            <ListRow
              leading={<HardDrives size={16} />}
              trailing={<Badge>Planned</Badge>}
            >
              <RowCopy
                title="Run on my server"
                detail="Keep agents running when this computer is off."
              />
            </ListRow>
            <ListRow
              leading={<Cloud size={16} />}
              trailing={<Badge>Planned</Badge>}
            >
              <RowCopy
                title="Remote access"
                detail="Reach this computer through a public HTTPS endpoint."
              />
            </ListRow>
          </List>
          <p className="modal-note">
            Server and remote access will be available in a future update.
          </p>
        </section>
        <Note>Each application uses its own model and spending limit.</Note>
        <FormActions>
          {existing && (
            <Button onClick={() => onRemove(selectedTool)}>
              <Trash size={16} />
              Disconnect
            </Button>
          )}
          <Button onClick={close}>Cancel</Button>
          <Button
            variant={BUTTON_VARIANT.PRIMARY}
            type="submit"
            disabled={!policy}
          >
            {existing ? 'Save changes' : 'Open with Gyblos'}
            <Plus size={16} />
          </Button>
        </FormActions>
      </form>
    </Modal>
  );
}
