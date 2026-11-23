// Flat appearance and product information use the shared compact design primitives.
import { Code, Info, Palette, Storefront, Wallet } from '@phosphor-icons/react';
import { useState } from 'react';

import { Appearance } from './Appearance';
import { BUTTON_VARIANT } from './constants';
import { setInterfaceFont } from './interface-font';
import { ChoiceMenu, Section } from './Management';
import { Modal } from './Modal';
import { MotionPresence } from './Motion';
import { Button, IconButton, PagePanel } from './UI';

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
      <Section title="Appearance" icon={<Palette size={16} weight="bold" />}>
        <div className="preview-settings-rows preview-settings-appearance">
          <Appearance
            label="Theme"
            light={light}
            onLightChange={onLightChange}
          />
          <div>
            <span>
              Interface font
              <small className="ui-help-text">
                Choose the typeface for the desktop interface.
              </small>
            </span>
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
      <PolicySettings />
      <Section title="About" icon={<Info size={16} weight="bold" />}>
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
      <MotionPresence>
        {aboutOpen && (
          <Modal
            title="About Gyblos"
            size="sm"
            close={() => setAboutOpen(false)}
          >
            <div className="ui-section">
              <p>Gyblos desktop</p>
              <p className="ui-help-text">Version {version}</p>
              <p className="ui-help-text">Local desktop application</p>
            </div>
          </Modal>
        )}
      </MotionPresence>
      <MotionPresence>
        {designOpen && (
          <DesignDialog font={font} close={() => setDesignOpen(false)} />
        )}
      </MotionPresence>
    </PagePanel>
  );
}

function PolicySettings() {
  return (
    <>
      <Section title="Sellers" icon={<Storefront size={16} weight="bold" />}>
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
      <Section title="Funds" icon={<Wallet size={16} weight="bold" />}>
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
      <Section title="Developer" icon={<Code size={16} weight="bold" />}>
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
    </>
  );
}

function DesignDialog({ font, close }: { font: string; close(): void }) {
  return (
    <>
      <Modal title="Design system" size="lg" close={close}>
        <div className="ui-section">
          <Section title="Buttons">
            <div className="preview-settings-rows">
              <div>
                <span>Standard action</span>
                <Button>Copy</Button>
              </div>
              <div>
                <span>Primary action</span>
                <Button variant={BUTTON_VARIANT.PRIMARY}>Connect a tool</Button>
              </div>
              <div>
                <span>Integrated icon</span>
                <IconButton label="Information example">
                  <Info size={16} />
                </IconButton>
              </div>
              <div>
                <span>Disabled</span>
                <Button disabled>Create key</Button>
              </div>
            </div>
          </Section>
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
          <Section title="Spacing">
            <p className="ui-help-text">
              4, 8, 12, 16, 24 and 32 px. Controls use a 6 px radius.
            </p>
          </Section>
        </div>
      </Modal>
    </>
  );
}
