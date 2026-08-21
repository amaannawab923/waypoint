import { type ComponentType, useState } from 'react';
import { GitBranch, GitFork, Search, Server } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { PageHeader, SectionCard, SettingRow, Toggle, Field, TextInput } from '@/pages/admin/components';

// lucide-react ships no brand marks — each provider gets a visually distinct
// generic glyph instead (no two providers share a git-fork-family icon).
interface AuthProvider {
  key: string;
  name: string;
  description: string;
  icon: ComponentType<{ size?: number }>;
}

const OAUTH_PROVIDERS: AuthProvider[] = [
  { key: 'google', name: 'Google', description: 'Let members sign in with a Google account.', icon: Search },
  { key: 'github', name: 'GitHub', description: 'Let members sign in with a GitHub account.', icon: GitFork },
  { key: 'gitlab', name: 'GitLab', description: 'Let members sign in with a GitLab account.', icon: GitBranch },
  { key: 'gitea', name: 'Gitea', description: 'Let members sign in with a self-hosted Gitea account.', icon: Server },
];

function ConfigureProviderModal({
  provider,
  onClose,
}: {
  provider: AuthProvider | null;
  onClose: () => void;
}) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');

  function handleClose() {
    setClientId('');
    setClientSecret('');
    onClose();
  }

  return (
    <Modal
      open={provider !== null}
      onClose={handleClose}
      title={provider ? `Configure ${provider.name}` : 'Configure'}
      footer={
        <Button variant="primary" onClick={handleClose}>
          Save
        </Button>
      }
    >
      {provider && (
        <div className="flex flex-col gap-4">
          <p className="text-xs text-text-secondary">{provider.description}</p>
          <Field label="Client ID">
            <TextInput value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder="Client ID" />
          </Field>
          <Field label="Client secret">
            <TextInput
              type="password"
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
              placeholder="••••••••"
            />
          </Field>
        </div>
      )}
    </Modal>
  );
}

export default function Auth() {
  const [openSignup, setOpenSignup] = useState(false);
  const [magicLink, setMagicLink] = useState(true);
  const [passwords, setPasswords] = useState(true);
  const [configuring, setConfiguring] = useState<AuthProvider | null>(null);

  return (
    <div>
      <PageHeader title="Authentication" description="Control how members can sign up and sign in to this instance." />

      <div className="flex flex-col gap-6">
        <SectionCard title="Sign-up">
          <SettingRow
            title="Allow anyone to sign up without an invite"
            description="When off, new members can only join after being invited by a workspace admin."
            control={<Toggle checked={openSignup} onChange={setOpenSignup} label="Allow anyone to sign up without an invite" />}
          />
        </SectionCard>

        <SectionCard title="Sign-in methods">
          <SettingRow
            title="Unique codes"
            description="Send a one-time magic link by email instead of a password. Requires SMTP to be configured."
            control={<Toggle checked={magicLink} onChange={setMagicLink} label="Unique codes" />}
          />
          <SettingRow
            title="Passwords"
            description="Allow members to sign in with an email and password."
            control={<Toggle checked={passwords} onChange={setPasswords} label="Passwords" />}
          />
        </SectionCard>

        <SectionCard title="Single sign-on">
          {OAUTH_PROVIDERS.map((provider) => {
            const Icon = provider.icon;
            return (
              <SettingRow
                key={provider.key}
                title={provider.name}
                description={provider.description}
                control={
                  <Button variant="secondary" size="sm" onClick={() => setConfiguring(provider)}>
                    <Icon size={14} />
                    Configure
                  </Button>
                }
              />
            );
          })}
        </SectionCard>
      </div>

      <ConfigureProviderModal provider={configuring} onClose={() => setConfiguring(null)} />
    </div>
  );
}
