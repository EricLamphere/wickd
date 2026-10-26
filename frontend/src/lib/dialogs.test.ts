import { beforeEach, describe, expect, it } from 'vitest';
import { alertDialog, confirmDialog, currentDialog, promptDialog, resolveDialog, subscribeDialogs } from './dialogs';

beforeEach(() => {
  while (currentDialog()) resolveDialog(null);
});

describe('dialogs', () => {
  it('confirm resolves true on OK and false on cancel', async () => {
    const yes = confirmDialog('Delete?');
    expect(currentDialog()).toMatchObject({ kind: 'confirm', message: 'Delete?' });
    resolveDialog(true);
    await expect(yes).resolves.toBe(true);

    const no = confirmDialog('Delete?');
    resolveDialog(null);
    await expect(no).resolves.toBe(false);
  });

  it('prompt resolves the typed text, or null on cancel', async () => {
    const named = promptDialog('Folder name:', 'new');
    expect(currentDialog()).toMatchObject({ kind: 'prompt', defaultValue: 'new' });
    resolveDialog('reports');
    await expect(named).resolves.toBe('reports');

    const cancelled = promptDialog('Folder name:');
    resolveDialog(null);
    await expect(cancelled).resolves.toBeNull();
  });

  it('queues dialogs and shows them one at a time, in order', async () => {
    const first = alertDialog('one');
    const second = confirmDialog('two');
    expect(currentDialog()?.message).toBe('one');
    resolveDialog(true);
    await first;
    expect(currentDialog()?.message).toBe('two');
    resolveDialog(true);
    await expect(second).resolves.toBe(true);
    expect(currentDialog()).toBeNull();
  });

  it('notifies subscribers and stops after unsubscribe', () => {
    let calls = 0;
    const unsubscribe = subscribeDialogs(() => { calls += 1; });
    alertDialog('x');
    resolveDialog(true);
    unsubscribe();
    alertDialog('y');
    expect(calls).toBe(2);
  });
});
