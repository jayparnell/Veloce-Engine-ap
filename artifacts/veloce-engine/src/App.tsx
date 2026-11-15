import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useLocation, Router as WouterRouter } from 'wouter';
import { Shell } from '@/components/shell';
import Studio from '@/pages/studio';
import Vault from '@/pages/vault';
import Monetization from '@/pages/monetization';
import Distribution from '@/pages/distribution';
import Playbook from '@/pages/playbook';
import SettingsPage from '@/pages/settings';
import { useGetStudioSummary, getGetStudioSummaryQueryKey } from '@workspace/api-client-react';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

// Establish the private visitor cookie before parallel page queries begin.
function SessionGate() {
  const summary = useGetStudioSummary({ query: { queryKey: getGetStudioSummaryQueryKey() } });
  if (summary.isLoading) return <div className="min-h-screen bg-background flex items-center justify-center text-sm text-emerald-400">Opening Veloce Engine…</div>;
  if (summary.isError) return <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4 text-sm"><p>We couldn't open your studio.</p><button className="text-emerald-400" onClick={() => summary.refetch()}>Try again</button></div>;
  return <Router />;
}

function Router() {
  return (
    <Shell>
      <RoutedErrorBoundary>
        <Switch>
          <Route path="/" component={Studio} />
          <Route path="/vault" component={Vault} />
          <Route path="/monetization" component={Monetization} />
          <Route path="/distribution" component={Distribution} />
          <Route path="/playbook" component={Playbook} />
          <Route path="/settings" component={SettingsPage} />
          <Route component={NotFound} />
        </Switch>
      </RoutedErrorBoundary>
    </Shell>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <SessionGate />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
