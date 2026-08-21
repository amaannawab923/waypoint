import { useState } from 'react';
import { RouterProvider } from 'react-router-dom';
import { router } from '@/router';
import { BootSplash } from '@/components/BootSplash';
import { ToastHost } from '@/components/ui/ToastHost';

export default function App() {
  const [booted, setBooted] = useState(false);

  return (
    <>
      <RouterProvider router={router} />
      <ToastHost />
      {!booted && <BootSplash onFinish={() => setBooted(true)} />}
    </>
  );
}
