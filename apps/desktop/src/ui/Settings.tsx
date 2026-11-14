// Flat appearance and product information use the shared compact design primitives.
import { useState } from 'react';

import { Appearance } from './Appearance';
import { BUTTON_VARIANT } from './constants';
import { FormField, FormInput } from './Form';
import { Section } from './Management';
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
  const [designOpen, setDesignOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);
  return (
    <PagePanel>
      <Section title="Appearance">
        <Appearance label="Theme" light={light} onLightChange={onLightChange} />
      </Section>
      <div className="ui-inline-actions">
        <Button onClick={() => setDesignOpen(true)}>View design system</Button>
        <Button onClick={() => setAboutOpen(true)}>About Gyblos</Button>
      </div>
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
                Instrument Sans · 14 px interface · 18 px sections
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
                  value="32 px shared control"
                  readOnly
                />
              </FormField>
            </Section>
            <Section title="Spacing">
              <p className="ui-help-text">
                4, 8, 12, 16, 24 and 32 px. Controls use a 10 px radius.
              </p>
            </Section>
          </div>
        </Modal>
      )}
    </PagePanel>
  );
}
