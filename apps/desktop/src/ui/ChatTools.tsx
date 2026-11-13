// Presents planned web services without claiming they are connected.
// These previews do not accept credentials or call third-party services.
import { Check, Wrench } from '@phosphor-icons/react';

import { BUTTON_VARIANT } from './constants';
import { Dropdown } from './Dropdown';
import { ServiceLogo } from './ServiceLogo';
import { TOOLS, type ToolId } from './tools';
import { Avatar, Badge, Button, MenuItem, Note, SectionTitle } from './UI';

export function ToolConnections() {
  return (
    <section className="tool-connections">
      <SectionTitle trailing={<Badge>Preview</Badge>}>
        Applications
      </SectionTitle>
      <p className="connections-description">
        Add search, page reading and browsing to conversations in the future.
      </p>
      <div className="applications-grid" aria-label="Web applications">
        {TOOLS.map((tool) => (
          <article className="application-card" key={tool.id}>
            <div className="application-card-heading">
              <Avatar>
                <ServiceLogo service={tool.id} />
              </Avatar>
              <div>
                <strong>{tool.name}</strong>
                <p>{tool.capability}</p>
              </div>
              <Badge>Preview</Badge>
            </div>
            <p>{tool.description}</p>
            <Button variant={BUTTON_VARIANT.SECONDARY} disabled>
              Coming soon
            </Button>
          </article>
        ))}
      </div>
      <Note>These services are previews and are not connected.</Note>
    </section>
  );
}

type ToolsDropdownProps = {
  selected: readonly ToolId[];
  connected: readonly ToolId[];
  unavailable?: boolean;
  onToggle: (id: ToolId) => void;
  onBrowse: () => void;
};
export function ToolsDropdown({
  selected,
  connected,
  unavailable = false,
  onToggle,
  onBrowse,
}: ToolsDropdownProps) {
  const enabled = unavailable
    ? []
    : selected.filter((id) => connected.includes(id));
  return (
    <Dropdown
      label="Choose chat tools"
      searchLabel="Search tools"
      iconOnly
      trigger={<Wrench size={16} aria-hidden="true" />}
    >
      {(close, query) => {
        const options = TOOLS.filter((tool) =>
          `${tool.name} ${tool.capability}`
            .toLowerCase()
            .includes(query.trim().toLowerCase()),
        );
        return (
          <>
            {options.map((tool) => {
              const available = connected.includes(tool.id) && !unavailable;
              const checked = available && enabled.includes(tool.id);
              return (
                <MenuItem
                  key={tool.id}
                  role="menuitemcheckbox"
                  checked={checked}
                  disabled={!available}
                  label={tool.name}
                  detail={
                    available
                      ? tool.capability
                      : !connected.includes(tool.id)
                        ? `${tool.capability} · Not connected`
                        : 'Unavailable for this model'
                  }
                  badge={
                    !connected.includes(tool.id) ? (
                      <Badge>Preview</Badge>
                    ) : undefined
                  }
                  leading={<ServiceLogo service={tool.id} />}
                  trailing={checked && <Check size={16} />}
                  onClick={() => onToggle(tool.id)}
                />
              );
            })}
            {!options.length && (
              <p className="dropdown-note" role="status">
                No tools found
              </p>
            )}
            <MenuItem
              footer
              label="Manage applications"
              onClick={() => {
                close();
                onBrowse();
              }}
            />
          </>
        );
      }}
    </Dropdown>
  );
}
