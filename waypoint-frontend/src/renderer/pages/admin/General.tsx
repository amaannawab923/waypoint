import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field, PageHeader, SectionCard, SettingRow, TextInput, Toggle } from '@/pages/admin/components';

const INSTANCE_ID = '7f3c1e2a-9b4d-4c8f-8a1e-2d6f5b0c3a91';

export default function General() {
  const [instanceName, setInstanceName] = useState('Waypoint');
  const [adminEmail, setAdminEmail] = useState('admin@waypoint.local');
  const [telemetry, setTelemetry] = useState(true);
  const [saved, setSaved] = useState(false);

  function handleSave() {
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  }

  return (
    <div>
      <PageHeader title="General" description="Instance-wide identity and telemetry settings." />

      <div className="flex flex-col gap-6">
        <SectionCard title="Instance details">
          <div className="grid grid-cols-2 gap-4 py-4">
            <Field label="Instance name">
              <TextInput value={instanceName} onChange={(e) => setInstanceName(e.target.value)} />
            </Field>
            <Field label="Admin email">
              <TextInput
                type="email"
                value={adminEmail}
                onChange={(e) => setAdminEmail(e.target.value)}
              />
            </Field>
            <Field label="Instance ID" hint="Generated once when this instance was first created.">
              <TextInput value={INSTANCE_ID} readOnly className="font-mono text-xs text-text-secondary" />
            </Field>
          </div>
          <SettingRow
            title="Save changes"
            control={
              <Button variant="primary" onClick={handleSave}>
                {saved ? 'Saved' : 'Save changes'}
              </Button>
            }
          />
        </SectionCard>

        <SectionCard title="Telemetry">
          <SettingRow
            title="Share anonymous usage data"
            description="Helps the Waypoint team understand feature usage. No project or work item content is ever sent."
            control={<Toggle checked={telemetry} onChange={setTelemetry} label="Share anonymous usage data" />}
          />
        </SectionCard>
      </div>
    </div>
  );
}
