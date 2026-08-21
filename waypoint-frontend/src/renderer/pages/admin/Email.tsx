import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field, PageHeader, SectionCard, SettingRow, TextInput } from '@/pages/admin/components';

export default function Email() {
  const [host, setHost] = useState('smtp.mailgun.org');
  const [port, setPort] = useState('587');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fromAddress, setFromAddress] = useState('noreply@waypoint.local');
  const [encryption, setEncryption] = useState<'none' | 'ssl' | 'tls'>('tls');
  const [saved, setSaved] = useState(false);

  return (
    <div>
      <PageHeader
        title="Email"
        description="Configure the SMTP server Waypoint uses to send invites, notifications, and magic links."
      />
      <SectionCard title="SMTP configuration">
        <div className="grid grid-cols-2 gap-4 py-4">
          <Field label="Host">
            <TextInput value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.example.com" />
          </Field>
          <Field label="Port">
            <TextInput value={port} onChange={(e) => setPort(e.target.value)} placeholder="587" />
          </Field>
          <Field label="Username">
            <TextInput value={username} onChange={(e) => setUsername(e.target.value)} placeholder="apikey" />
          </Field>
          <Field label="Password">
            <TextInput
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
            />
          </Field>
          <Field label="From address">
            <TextInput
              value={fromAddress}
              onChange={(e) => setFromAddress(e.target.value)}
              placeholder="noreply@yourdomain.com"
            />
          </Field>
          <Field label="Encryption">
            <select
              value={encryption}
              onChange={(e) => setEncryption(e.target.value as typeof encryption)}
              className="h-9 w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm text-text outline-none focus:border-accent"
            >
              <option value="none">None</option>
              <option value="ssl">SSL</option>
              <option value="tls">TLS</option>
            </select>
          </Field>
        </div>
        <SettingRow
          title="Save configuration"
          description="Changes are not sent anywhere in this demo instance."
          control={
            <Button
              variant="primary"
              onClick={() => {
                setSaved(true);
                setTimeout(() => setSaved(false), 1800);
              }}
            >
              {saved ? 'Saved' : 'Save changes'}
            </Button>
          }
        />
      </SectionCard>
    </div>
  );
}
