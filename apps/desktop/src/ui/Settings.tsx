// Flat appearance and product information use the shared compact design primitives.
import { Code, Coins, Info, Palette, UsersThree } from '@phosphor-icons/react';
import { useState } from 'react';

import { Appearance } from './Appearance';
import { BUTTON_VARIANT } from './constants';
import { FormField, FormInput } from './Form';
import { setInterfaceFont } from './interface-font';
import { ChoiceMenu, Section } from './Management';
import { Modal } from './Modal';
import { Button, PagePanel } from './UI';

export function Settings({
  light,
  onLightChange,
  version,
}: {
  light: boolean;
  onLightChange(light: boolean): void;
  version: string;
}) {
  const [font, setFont] = useState(() =>
    document.documentElement.dataset.font === 'inter'
      ? 'Inter'
      : 'Instrument Sans',
  );
  const [designOpen, setDesignOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  return (
    <PagePanel>
      <Section title="Appearance" icon={<Palette size={16} />}>
        <div className="preview-settings-rows preview-settings-appearance">
          <Appearance
            label="Theme"
            light={light}
            onLightChange={onLightChange}
          />
          <div>
            <span>Interface font</span>
            <ChoiceMenu
              label="Interface font"
              value={font}
              options={['Inter', 'Instrument Sans']}
              onChange={(value) => {
                setInterfaceFont(value);
                setFont(value);
              }}
            />
          </div>
        </div>
      </Section>
      <Section title="Sellers" icon={<UsersThree size={16} />}>
        <div className="preview-settings-rows">
          <div>
            <span>
              Seller selection
              <small className="ui-help-text">
                Choose a signed offer or use Auto when selecting a model.
              </small>
            </span>
            <span>Per model</span>
          </div>
        </div>
      </Section>
      <Section title="Funds" icon={<Coins size={16} />}>
        <div className="preview-settings-rows">
          <div>
            <span>
              Use a free model when out of funds
              <small className="ui-help-text">
                Automatic fallback across Chat and API keys is unavailable.
              </small>
            </span>
            <Button
              className="pk-switch"
              role="switch"
              aria-checked={false}
              aria-label="Use a free model when out of funds"
              disabled
            >
              <span className="pk-switch-thumb" />
            </Button>
          </div>
        </div>
      </Section>
      <Section title="Developer" icon={<Code size={16} />}>
        <div className="preview-settings-rows">
          <div>
            <span>
              Show Testnet
              <small className="ui-help-text">
                USDC payments use Solana devnet.
              </small>
            </span>
            <Button
              className="pk-switch"
              role="switch"
              aria-checked={true}
              aria-label="Show Testnet"
              disabled
            >
              <span className="pk-switch-thumb" />
            </Button>
          </div>
        </div>
      </Section>
      <Section title="About" icon={<Info size={16} />}>
        <div className="preview-settings-rows">
          <div>
            <span>Design system</span>
            <Button onClick={() => setDesignOpen(true)}>View controls</Button>
          </div>
          <div>
            <span>About Gyblos</span>
            <Button onClick={() => setAboutOpen(true)}>View details</Button>
          </div>
        </div>
      </Section>
      {aboutOpen && (
        <Modal title="About Gyblos" close={() => setAboutOpen(false)}>
          <div className="ui-section">
            <p>Gyblos desktop</p>
            <p className="ui-help-text">Version {version}</p>
            <p className="ui-help-text">Local desktop application</p>
          </div>
        </Modal>
      )}
      {designOpen && (
        <Modal title="Design system" close={() => setDesignOpen(false)}>
          <div className="ui-section">
            <Section title="Typography">
              <p className="ui-help-text">
                {font} · 13 px interface · 15 px sections
              </p>
            </Section>
            <Section title="Colors">
              <div className="ui-swatch-list">
                <span className="ui-swatch ui-swatch--background">
                  Background
                </span>
                <span className="ui-swatch ui-swatch--panel">Surface</span>
                <span className="ui-swatch ui-swatch--accent">#0A28F0</span>
              </div>
            </Section>
            <Section title="Controls">
              <div className="ui-inline-actions">
                <Button variant={BUTTON_VARIANT.PRIMARY}>Primary</Button>
                <Button variant={BUTTON_VARIANT.SECONDARY}>Secondary</Button>
                <Button>Outline</Button>
                <Button disabled>Disabled</Button>
              </div>
              <FormField label="Example input" htmlFor="review-design-input">
                <FormInput
                  id="review-design-input"
                  value="28 px shared control"
                  readOnly
                />
              </FormField>
            </Section>
            <Section title="Spacing">
              <p className="ui-help-text">
                4, 8, 12, 16, 24 and 32 px. Controls use a 6 px radius.
              </p>
            </Section>
          </div>
        </Modal>
      )}
    </PagePanel>
  );
}
