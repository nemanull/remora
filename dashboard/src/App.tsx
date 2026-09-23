import { Route, Routes } from 'react-router';
import { AlertToasts } from './components/AlertToasts';
import { AppShell } from './components/AppShell';
import { PageHeader } from './components/Panel';
import { CollectorsPage } from './pages/CollectorsPage';
import { DecisionsPage } from './pages/DecisionsPage';
import { LeaderPage } from './pages/LeaderPage';
import { LeadersPage } from './pages/LeadersPage';
import { OverviewPage } from './pages/OverviewPage';
import { useLiveEvents } from './useLiveEvents';

function NotFoundPage() {
  return (
    <PageHeader
      title="Page not found"
      description="Use the navigation to get back to the console."
    />
  );
}

export function App() {
  const { status, alerts, dismissAlert } = useLiveEvents();
  return (
    <AppShell liveStatus={status}>
      <Routes>
        <Route index element={<OverviewPage />} />
        <Route path="leaders" element={<LeadersPage />} />
        <Route path="leaders/:address" element={<LeaderPage />} />
        <Route path="decisions" element={<DecisionsPage />} />
        <Route path="collectors" element={<CollectorsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
      <AlertToasts alerts={alerts} onDismiss={dismissAlert} />
    </AppShell>
  );
}
