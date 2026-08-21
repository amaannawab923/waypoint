import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { markOnboarding } from '@/lib/onboarding';

/**
 * Waypoint-branded take on Plane's real sign-in screen: centered card, product
 * name + tagline, a single email field, "Continue". There's no backend to
 * authenticate against — any non-empty email just marks onboarding as
 * incomplete and sends the user into the first-run workspace-naming step.
 */
export default function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');

  const valid = email.trim().length > 0;

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
          <p className="mt-1.5 text-sm text-text-muted">Plan, track, and ship your work.</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="email" className="text-xs font-medium text-text-secondary">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@company.com"
              className="h-9 rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm text-text outline-none placeholder:text-text-muted focus:border-accent"
            />
          </div>

          <Button type="submit" variant="primary" size="md" disabled={!valid} className="w-full">
            Continue
          </Button>
        </form>

        <p className="mt-6 text-center text-xs text-text-muted">
          Don't have an account?{' '}
          <Link to="/signup" className="font-medium text-text-secondary hover:text-text">
            Sign up
          </Link>
        </p>
        <p className="mt-3 text-center text-xs text-text-muted">
          By continuing, you agree to Waypoint's Terms of Service and Privacy Policy.
        </p>
      </div>
    </div>
  );
}
