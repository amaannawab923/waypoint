import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { markOnboarding } from '@/lib/onboarding';

/**
 * Sibling of Login.tsx — same passwordless "continue" mechanic (there's no
 * backend to register against), but framed as account creation with a name
 * field, so first-time visitors get an actual choice instead of only ever
 * seeing a login form.
 */
export default function Signup() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');

  const valid = name.trim().length > 0 && email.trim().length > 0;

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid) return;
    markOnboarding('false');
    navigate('/onboarding/workspace');
  }

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-bg px-4">
      <div className="w-full max-w-sm rounded-[var(--radius-lg)] border border-border bg-surface p-8 shadow-2xl">
        <div className="mb-8 text-center">
          <h1 className="font-display text-2xl font-semibold text-text">Waypoint</h1>
          <p className="mt-1.5 text-sm text-text-muted">Start planning in minutes.</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="name" className="text-xs font-medium text-text-secondary">
              Full name
            </label>
            <input
              id="name"
              type="text"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ada Lovelace"
              className="h-9 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm text-text outline-none placeholder:text-text-muted focus:border-accent"
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label htmlFor="email" className="text-xs font-medium text-text-secondary">
              Email
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              className="h-9 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm text-text outline-none placeholder:text-text-muted focus:border-accent"
            />
          </div>

          <Button type="submit" variant="primary" size="md" disabled={!valid} className="w-full">
            Create account
          </Button>
        </form>

        <p className="mt-6 text-center text-xs text-text-muted">
          Already have an account?{' '}
          <Link to="/login" className="font-medium text-text-secondary hover:text-text">
            Log in
          </Link>
        </p>
      </div>
    </div>
  );
}
