import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Button, IconButton } from '@/components/ui/Button';
import { Field, PageHeader, SectionCard, TextInput } from '@/pages/admin/components';

const MODEL_OPTIONS = [
  { value: 'gpt-4o', label: 'GPT-4o' },
  { value: 'gpt-4o-mini', label: 'GPT-4o mini' },
] as const;

export default function AI() {
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [model, setModel] = useState<(typeof MODEL_OPTIONS)[number]['value']>('gpt-4o-mini');
  const [saved, setSaved] = useState(false);

  function handleSave() {
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  }

  return (
    <div>
      <PageHeader
        title="AI"
        description="Connect an OpenAI API key to power AI work item descriptions and summaries."
      />

      <SectionCard title="OpenAI">
        <div className="flex flex-col gap-4 py-4">
          <Field label="API key" hint="Stored on this instance only. Never shared with members.">
            <div className="relative">
              <TextInput
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-••••••••••••••••••••••••"
                className="pr-10"
              />
              <IconButton
                label={showKey ? 'Hide API key' : 'Show API key'}
                onClick={() => setShowKey((v) => !v)}
                className="absolute top-1/2 right-1 -translate-y-1/2"
              >
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </IconButton>
            </div>
          </Field>

          <Field label="Model">
            <select
              value={model}
              onChange={(e) => setModel(e.target.value as typeof model)}
              className="h-9 w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm text-text outline-none focus:border-accent"
            >
              {MODEL_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="flex justify-end py-4">
          <Button variant="primary" onClick={handleSave}>
            {saved ? 'Saved' : 'Save changes'}
          </Button>
        </div>
      </SectionCard>
    </div>
  );
}
