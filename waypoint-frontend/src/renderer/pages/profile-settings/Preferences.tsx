import { useEffect, useState } from 'react';
import { NotWired } from '@/components/ui/NotWired';
import { useAsync } from '@/lib/useAsync';
import { getCurrentUser, updateCurrentUser } from '@/data/api';

const selectClass =
  'h-9 w-full rounded-[var(--radius-sm)] border border-border-strong bg-bg px-3 text-sm text-text outline-none focus:border-accent';

const labelClass = 'mb-1.5 block text-sm font-medium text-text';

export default function Preferences() {
  const { data: user } = useAsync(() => getCurrentUser(), []);
  const [firstDayOfWeek, setFirstDayOfWeek] = useState<'Sunday' | 'Monday'>(
    'Sunday',
  );

  // Was pure local state initialized to a hardcoded 'Sunday' with no load
  // and no save call — it looked functional (the select updated
  // instantly) but every change silently reverted on reload. Load the
  // member's real, persisted value once it arrives.
  useEffect(() => {
    if (user) setFirstDayOfWeek(user.firstDayOfWeek);
  }, [user]);

  async function handleChange(value: 'Sunday' | 'Monday') {
    setFirstDayOfWeek(value);
    await updateCurrentUser({ firstDayOfWeek: value });
  }

  return (
    <div className="max-w-lg">
      <h2 className="mb-6 font-display text-lg font-medium text-text">
        Preferences
      </h2>

      <div className="flex flex-col gap-5">
        <div>
          <label className={labelClass} htmlFor="timezone">
            Timezone
          </label>
          <input
            id="timezone"
            className={selectClass}
            value="UTC"
            disabled
            readOnly
          />
        </div>

        <div>
          <label className={labelClass} htmlFor="language">
            Language
          </label>
          <input
            id="language"
            className={selectClass}
            value="English"
            disabled
            readOnly
          />
        </div>

        <div>
          <label className={labelClass} htmlFor="first-day">
            First day of the week
          </label>
          <select
            id="first-day"
            className={selectClass}
            value={firstDayOfWeek}
            onChange={(e) =>
              handleChange(e.target.value as 'Sunday' | 'Monday')
            }
          >
            <option value="Sunday">Sunday</option>
            <option value="Monday">Monday</option>
          </select>
          <div className="mt-2">
            <NotWired capability="preferences.firstDayOfWeek" />
          </div>
        </div>
      </div>
    </div>
  );
}
