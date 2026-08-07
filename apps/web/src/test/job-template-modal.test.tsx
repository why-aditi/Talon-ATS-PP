import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from '../components/app-shell';
import { JobTemplateModal } from '../components/job-template-modal';
import { SessionProvider } from '../lib/session';

/*
  jsdom ships HTMLDialogElement without showModal/close, so the component throws on
  open without these. They are jsdom gaps rather than behaviour worth asserting: the
  real focus trap, Escape handling and top-layer stacking are the platform's, and a
  browser is the only place they can be verified.

  `open` is set and cleared here because the tests query by role, and a <dialog>
  without the attribute is hidden from the accessibility tree.
*/
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});

const writeText = vi.fn<(text: string) => Promise<void>>();

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
});

/*
  userEvent.setup() installs its own navigator.clipboard stub, so the mock has to be
  planted *after* it — assigning in beforeEach gets silently overwritten, and the
  symptom is writeText never being called with no error to explain why.
*/
function setupUser(clipboard: object | undefined = { writeText }) {
  const user = userEvent.setup();
  // defineProperty, not Object.assign: userEvent installs `clipboard` as a
  // getter-only property, so assignment throws rather than overwriting it.
  Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
  return user;
}

const SECTIONS = [
  'About the role',
  'Responsibilities',
  'Minimum qualifications',
  'Preferred qualifications',
  'Compensation and benefits',
  'Interview process',
  'Equal opportunity',
];

function renderOpen(onClose = vi.fn()) {
  render(<JobTemplateModal open onClose={onClose} />);
  return onClose;
}

/** The editor for one section, found through the heading that labels it. */
const editorFor = (heading: string) => screen.getByRole('textbox', { name: heading });

/** That section's Copy button, which sits in the heading row. */
const copyButtonFor = (heading: string) =>
  screen.getByRole('heading', { level: 3, name: heading }).parentElement!.querySelector('button')!;

describe('content', () => {
  it('renders every section the spec lists, in order', () => {
    renderOpen();
    expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(SECTIONS);
  });

  it('gives every section an editable field named by its heading', () => {
    renderOpen();
    for (const heading of SECTIONS) expect(editorFor(heading)).toBeInstanceOf(HTMLTextAreaElement);
  });

  it('warns that edits are lost, and describes the dialog with that warning', () => {
    renderOpen();
    // Not just present — wired to aria-describedby, so it is announced rather than
    // only seen. The caveat existing but being silent is the failure worth catching.
    const describedBy = screen.getByRole('dialog').getAttribute('aria-describedby');
    expect(document.getElementById(describedBy ?? '')).toHaveTextContent(/gone when this closes/i);
  });

  it('never renders a real compensation figure', () => {
    // Non-negotiable #2: this component checks no scope and makes no request, so a
    // real band here would be comp shown to every role with no gate at all.
    renderOpen();
    const comp = editorFor('Compensation and benefits') as HTMLTextAreaElement;
    expect(comp.value).not.toMatch(/\$|\d{2,3},\d{3}/);
  });
});

describe('copy', () => {
  it('copies one section with its heading and nothing else', async () => {
    const user = setupUser();
    renderOpen();
    await user.click(copyButtonFor('Responsibilities'));

    expect(writeText).toHaveBeenCalledOnce();
    const text = writeText.mock.calls[0]![0];
    expect(text).toMatch(/^Responsibilities\n/);
    expect(text).not.toContain('About the role');
  });

  it('copies what the user typed, not the original template', async () => {
    const user = setupUser();
    renderOpen();

    const editor = editorFor('About the role');
    await user.clear(editor);
    await user.type(editor, 'Rewritten by the recruiter.');
    await user.click(copyButtonFor('About the role'));

    expect(writeText.mock.calls[0]![0]).toBe('About the role\nRewritten by the recruiter.');
  });

  it('copies all seven sections in one call', async () => {
    const user = setupUser();
    renderOpen();
    await user.click(screen.getByRole('button', { name: 'Copy all' }));

    expect(writeText).toHaveBeenCalledOnce();
    for (const heading of SECTIONS) expect(writeText.mock.calls[0]![0]).toContain(heading);
  });

  it('confirms in a live region, not by colour alone', async () => {
    const user = setupUser();
    renderOpen();
    await user.click(screen.getByRole('button', { name: 'Copy all' }));
    expect(await screen.findByText('Copied to clipboard')).toBeInTheDocument();
  });

  it('reports a rejected clipboard instead of failing silently', async () => {
    writeText.mockRejectedValue(new Error('denied'));
    const user = setupUser();
    renderOpen();

    await user.click(screen.getByRole('button', { name: 'Copy all' }));
    expect(await screen.findByRole('button', { name: "Couldn't copy" })).toBeInTheDocument();
    expect(await screen.findByText('Could not copy to clipboard')).toBeInTheDocument();
  });

  it('treats an absent clipboard API as a failure, not as success', async () => {
    // Insecure origin: navigator.clipboard is undefined. The button must not look
    // like it worked. fireEvent rather than userEvent here — userEvent's own pointer
    // machinery reaches for navigator.clipboard, so it cannot be the thing that
    // clicks while we are asserting on clipboard being absent.
    setupUser(undefined);
    renderOpen();

    fireEvent.click(screen.getByRole('button', { name: 'Copy all' }));
    expect(await screen.findByRole('button', { name: "Couldn't copy" })).toBeInTheDocument();
  });
});

describe('discarding edits', () => {
  it('closes without ceremony when nothing was edited', async () => {
    const user = setupUser();
    const onClose = renderOpen();
    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByText(/Discard your edits/)).not.toBeInTheDocument();
  });

  it('asks before throwing away edits, and does not close until answered', async () => {
    const user = setupUser();
    const onClose = renderOpen();

    await user.type(editorFor('Responsibilities'), ' and more');
    await user.click(screen.getByRole('button', { name: 'Close' }));

    expect(screen.getByText(/Discard your edits/)).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('keeps the edits when the user backs out', async () => {
    const user = setupUser();
    const onClose = renderOpen();

    await user.type(editorFor('Responsibilities'), ' and more');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));

    expect(onClose).not.toHaveBeenCalled();
    expect((editorFor('Responsibilities') as HTMLTextAreaElement).value).toContain(' and more');
  });

  it('closes once the user confirms', async () => {
    const user = setupUser();
    const onClose = renderOpen();

    await user.type(editorFor('Responsibilities'), ' and more');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.click(screen.getByRole('button', { name: 'Discard' }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it('stops Escape from discarding edits silently', async () => {
    const onClose = renderOpen();
    const user = setupUser();
    await user.type(editorFor('Responsibilities'), ' and more');

    // Escape on a modal dialog fires `cancel` first; the component preventDefaults it
    // while dirty. jsdom does not wire Escape to `cancel`, so it is dispatched here.
    const dialog = screen.getByRole('dialog');
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }));

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/Discard your edits/)).toBeInTheDocument();
  });
});

/** AppShell reads the session and the jobs cache, so it needs both providers. */
function renderShell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider>
        <AppShell>
          <p>page</p>
        </AppShell>
      </SessionProvider>
    </QueryClientProvider>,
  );
}

describe('one path per action', () => {
  it('opens the same modal from the sidebar trigger', async () => {
    const user = setupUser();
    renderShell();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '+ New job' }));
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Job description template');
  });

  it('no longer links anywhere — /jobs/new is the wizard route and does not exist', () => {
    renderShell();
    expect(screen.queryByRole('link', { name: '+ New job' })).not.toBeInTheDocument();
  });
});

describe('create job', () => {
  it('offers the action but states why it cannot run yet', () => {
    renderOpen();
    const create = screen.getByRole('button', { name: 'Create job' });
    // Disabled rather than absent: the affordance is the honest signal that this is
    // where creating happens. Disabled also keeps it out of the tab order, so the
    // keyboard path does not stop on a control that does nothing.
    expect(create).toBeDisabled();
    expect(screen.getByText(/isn’t built yet/)).toBeInTheDocument();
  });
});
