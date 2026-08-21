import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Field, PageHeader, SectionCard, TextInput } from '@/pages/admin/components';

export default function Images() {
  const [accessKey, setAccessKey] = useState('');
  const [saved, setSaved] = useState(false);

  function handleSave() {
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1800);
  }

  return (
    <div>
      <PageHeader
        title="Images"
        description="Connect Unsplash so members can search stock photos for project and page covers."
      />

      <SectionCard title="Unsplash">
        <div className="py-4">
          <Field label="Access key" hint="Create a free application at unsplash.com/developers to get a key.">
            <TextInput
              value={accessKey}
              onChange={(e) => setAccessKey(e.target.value)}
              placeholder="Unsplash access key"
            />
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
