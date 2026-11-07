// Shared menu for declared preview reasoning levels; no live inference or payment calls.
import { Brain, Check } from '@phosphor-icons/react';

import type { ReasoningLevel } from '@gyblos/protocol/constants';
import type { ReasoningSupport } from '@gyblos/protocol/models';

import { reasoningLabel } from './chat-reasoning';
import { Dropdown } from './Dropdown';
import { MenuItem } from './UI';

export function ReasoningDropdown({
  support,
  value,
  onChange,
}: {
  support: Readonly<ReasoningSupport>;
  value: ReasoningLevel;
  onChange: (value: ReasoningLevel) => void;
}) {
  return (
    <Dropdown
      label="Choose thinking level"
      searchLabel="Search thinking levels"
      trigger={
        <>
          <Brain size={16} aria-hidden="true" />
          {reasoningLabel(support, value)}
        </>
      }
    >
      {(close, query) => (
        <>
          {support.levels
            .filter((level) =>
              reasoningLabel(support, level)
                .toLowerCase()
                .includes(query.trim().toLowerCase()),
            )
            .map((level) => (
              <MenuItem
                key={level}
                role="menuitemradio"
                label={reasoningLabel(support, level)}
                detail="Preview setting"
                checked={value === level}
                trailing={value === level && <Check size={16} />}
                onClick={() => {
                  close();
                  onChange(level);
                }}
              />
            ))}
        </>
      )}
    </Dropdown>
  );
}
