import { KeyRound, Plus } from 'lucide-react';
import { EmptyState } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';

export default function Tokens() {
  return (
    <div className="max-w-lg">
      <h2 className="mb-1 font-display text-lg font-medium text-text">Personal access tokens</h2>
      <p className="mb-6 text-sm text-text-secondary">
        Tokens you generate can be used to access the Waypoint API on your behalf.
      </p>

      <EmptyState
        icon={<KeyRound size={28} />}
        title="No Personal token yet"
        description="Create a new personal access token to use the API."
        action={
          <Button
            variant="primary"
            disabled
            title="Waypoint has no API authentication yet, so a token would have nothing to grant."
          >
            <Plus size={15} />
            Add access token
          </Button>
        }
      />
    </div>
  );
}
