import { AppShell } from '../../components/app-shell';
import { buttonClass } from '../../components/ui';

/** Everything behind the shell. `/sign-in` deliberately sits outside this group. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <a
        href="#main"
        className={buttonClass('secondary', 'sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[var(--z-modal)]')}
      >
        Skip to content
      </a>
      <AppShell>{children}</AppShell>
    </>
  );
}
