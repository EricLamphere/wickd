/**
 * In-app replacements for window.alert / confirm / prompt. The desktop app's
 * WebView (wry's WKWebView on macOS) doesn't implement the native dialogs:
 * confirm() returns false and alert()/prompt() do nothing without showing
 * anything, so every "Are you sure?" there silently cancelled. These show a
 * real modal (DialogHost, mounted once in App) in the browser and the app alike.
 */
import { ApiError } from './api';

export type DialogKind = 'alert' | 'confirm' | 'prompt';

export interface DialogOptions {
  title?: string;
  /** Label of the OK button (e.g. "Delete"). */
  confirmLabel?: string;
  /** Red OK button, for destructive actions. */
  danger?: boolean;
}

export interface DialogRequest extends DialogOptions {
  id: number;
  kind: DialogKind;
  message: string;
  defaultValue?: string;
}

type Answer = boolean | string | null;
interface Pending { request: DialogRequest; resolve: (answer: Answer) => void }

let queue: readonly Pending[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function open(request: Omit<DialogRequest, 'id'>): Promise<Answer> {
  return new Promise((resolve) => {
    queue = [...queue, { request: { ...request, id: nextId++ }, resolve }];
    emit();
  });
}

export function subscribeDialogs(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The dialog on screen (the oldest unanswered one), or null. */
export function currentDialog(): DialogRequest | null {
  return queue[0]?.request ?? null;
}

/** Answer the dialog on screen: true/text for OK, null for cancel. */
export function resolveDialog(answer: Answer): void {
  const [head, ...rest] = queue;
  if (!head) return;
  queue = rest;
  head.resolve(answer);
  emit();
}

export async function alertDialog(message: string, opts: DialogOptions = {}): Promise<void> {
  await open({ kind: 'alert', message, ...opts });
}

export async function confirmDialog(message: string, opts: DialogOptions = {}): Promise<boolean> {
  return (await open({ kind: 'confirm', message, ...opts })) === true;
}

export async function promptDialog(message: string, defaultValue = '', opts: DialogOptions = {}): Promise<string | null> {
  const answer = await open({ kind: 'prompt', message, defaultValue, ...opts });
  return typeof answer === 'string' ? answer : null;
}

/** alertDialog for a caught error, with ApiError's server detail when there is one. */
export function alertError(err: unknown): Promise<void> {
  const detail = err instanceof ApiError && typeof err.body === 'string' ? err.body : null;
  return alertDialog(detail ?? (err instanceof Error ? err.message : String(err)), { title: 'Something went wrong' });
}
