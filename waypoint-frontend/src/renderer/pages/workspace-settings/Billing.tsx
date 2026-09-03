import { Check } from 'lucide-react';
import { useAsync } from '@/lib/useAsync';
import { getWorkspace } from '@/mock/api';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';

const PLAN_LABEL: Record<string, string> = {
  community: 'Community',
  pro: 'Pro',
  business: 'Business',
  enterprise: 'Enterprise',
};

interface PlanCard {
  name: string;
  price: string;
  description: string;
  features: string[];
  cta: string;
  variant: 'primary' | 'secondary';
}

const PLANS: PlanCard[] = [
  {
    name: 'Pro',
    price: '$8/user/mo',
    description: 'Advanced analytics, custom fields, and priority support.',
    features: ['Everything in Community', 'Advanced analytics', 'Custom fields', 'Priority support'],
    cta: 'Upgrade to Pro',
    variant: 'primary',
  },
  {
    name: 'Business',
    price: 'Contact us',
    description: 'SSO, audit logs, and dedicated onboarding for growing teams.',
    features: ['Everything in Pro', 'SAML SSO', 'Audit logs', 'Dedicated onboarding'],
    cta: 'Talk to Sales',
    variant: 'secondary',
  },
  {
    name: 'Enterprise',
    price: 'Contact us',
    description: 'Custom contracts, SLAs, and enterprise-grade security controls.',
    features: ['Everything in Business', 'Custom SLA', 'Enterprise security review', 'Dedicated success manager'],
    cta: 'Talk to Sales',
    variant: 'secondary',
  },
];

export default function Billing() {
  const { data: workspace, loading } = useAsync(() => getWorkspace(), []);

  return (
    <div>
      <h2 className="mb-6 font-display text-lg font-medium text-text">Billing and plans</h2>

      {loading && !workspace && (
        <Skeleton>
          <Skeleton.Block height="4.5rem" className="mb-8" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="rounded-[var(--radius-lg)] border border-border bg-surface p-5">
                <Skeleton.Block height="1rem" width="4rem" className="mb-2" />
                <Skeleton.Block height="1.5rem" width="6rem" className="mb-3" />
                <Skeleton.Block height="0.75rem" width="90%" className="mb-1.5" />
                <Skeleton.Block height="0.75rem" width="70%" />
              </div>
            ))}
          </div>
        </Skeleton>
      )}

      {workspace && (
        <>
          <div className="mb-8 rounded-[var(--radius-lg)] border border-border bg-surface-2 p-5">
            <div className="mb-2 flex items-center gap-2">
              <span className="text-sm font-medium text-text">Current plan</span>
              <Badge tone="accent">{PLAN_LABEL[workspace.plan] ?? workspace.plan}</Badge>
            </div>
            <p className="text-sm text-text-secondary">
              Unlimited projects, issues, cycles, modules, pages, and storage.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            {PLANS.map((plan) => (
              <div
                key={plan.name}
                className="flex flex-col rounded-[var(--radius-lg)] border border-border bg-surface p-5"
              >
                <h3 className="font-display text-base font-medium text-text">{plan.name}</h3>
                <p className="mt-1 font-display text-xl font-medium text-text">{plan.price}</p>
                <p className="mt-2 text-sm text-text-secondary">{plan.description}</p>
                <ul className="mt-4 flex flex-1 flex-col gap-2">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2 text-sm text-text-secondary">
                      <Check size={14} className="mt-0.5 shrink-0 text-success" />
                      {feature}
                    </li>
                  ))}
                </ul>
                <Button
                  variant={plan.variant}
                  className="mt-5 w-full"
                  disabled
                  title="Billing isn't connected to a payment processor yet."
                >
                  {plan.cta}
                </Button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
