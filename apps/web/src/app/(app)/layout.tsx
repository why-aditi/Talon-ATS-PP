import { AppShell } from '../../components/app-shell';
import { buttonClass } from '../../components/button-styles';
import { RequireSession } from '../../lib/session';

/**
 * Everything behind the shell. `/sign-in` deliberately sits outside this group,
 * which is what makes the gate below a whole-group rule rather than a per-page
 * one — a new screen is protected by being added here, and cannot forget to be.
 * Same reasoning as the API's plugin-scoped auth hook (§4.1).
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireSession>
      <a
        href="#main"
        className={buttonClass('secondary', 'sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[var(--z-modal)]')}
      >
        Skip to content
      </a>
      <AppShell>{children}</AppShell>
    </RequireSession>
  );
}
