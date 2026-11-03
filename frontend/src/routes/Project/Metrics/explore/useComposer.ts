// The query composer's state (plan 16): the chips and the text being typed are a draft of the
// widget until committed (Enter, ⌘Enter, leaving the line) — the query view runs a query for any
// widget it has no stored result for, so writing the URL per keystroke would run one per chip.
// When the widget changes from outside (Configure, back/forward), the chips are rebuilt from it,
// unless a draft is being typed. The composer picks the type only until someone else does (canInfer).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DashboardWidget } from '../../../../lib/dashboardsApi';
import type { SemanticCatalogDto } from '../../../../lib/semanticApi';
import { buildIndex, chipText, editableAsText, isComplete, mergeChips, parse, type Chip } from '../lib/composer';
import { canInfer, fromWidget, sameWidget, toWidget, type ChipError } from '../lib/composerWidget';

interface Options {
  widget: DashboardWidget;
  catalog: SemanticCatalogDto;
  /** the line always shows the period and comparison (the query view) */
  showPeriod: boolean;
  onCommit: (widget: DashboardWidget) => void;
  /** ⌘Enter on a line that changes nothing: run it again */
  onRun?: () => void;
  /** start empty again after a commit (the entry box: the query opens elsewhere) */
  clearOnCommit?: boolean;
}

const sameChips = (a: Chip[], b: Chip[]) => JSON.stringify(a) === JSON.stringify(b);

export function useComposer({ widget, catalog, showPeriod, onCommit, onRun, clearOnCommit = false }: Options) {
  const index = useMemo(() => buildIndex(catalog), [catalog]);
  const committed = useMemo(() => fromWidget(widget, { period: showPeriod }), [widget, showPeriod]);
  const [chips, setChips] = useState<Chip[]>(committed);
  const [input, setInput] = useState('');
  const [errors, setErrors] = useState<ChipError[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const focused = useRef(false);
  const locked = useRef(!canInfer(widget));
  const written = useRef<DashboardWidget | null>(null);
  const prevType = useRef(widget.type);
  const dirty = input.trim() !== '' || !sameChips(chips, committed);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(() => {
    const ours = !!written.current && sameWidget(written.current, widget);
    // a type picked in Configure is kept from then on
    if (!ours && widget.type !== prevType.current) locked.current = true;
    if (!widget.metrics?.length) locked.current = false;
    prevType.current = widget.type;
    if (!focused.current || !dirtyRef.current) {
      setChips(committed);
      setInput('');
      setErrors([]);
      setProblem(null);
    }
  }, [committed, widget]);

  /** Applies the chips (plus `text`, parsed) to the widget; false when something can't apply. */
  const commit = useCallback(({ run = false, next = chips, text = input }: { run?: boolean; next?: Chip[]; text?: string } = {}) => {
    let all = next;
    if (text.trim()) {
      const parsed = parse(text, index);
      if (parsed.pending) {
        setProblem(`Finish “${text.trim()}” or clear it (Esc)`);
        return false;
      }
      all = mergeChips(next, parsed.chips);
      setInput('');
    }
    setNotice(null);
    const result = toWidget(all, widget, catalog, { infer: !locked.current });
    if (result.errors.length) {
      setChips(all);
      setErrors(result.errors);
      setProblem(null);
      return false;
    }
    setErrors([]);
    setProblem(null);
    setChips(clearOnCommit ? committed : fromWidget(result.widget, { period: showPeriod }));
    if (!sameWidget(result.widget, widget)) {
      written.current = result.widget;
      onCommit(result.widget);
    } else if (run) {
      onRun?.();
    }
    return true;
  }, [chips, input, index, widget, catalog, showPeriod, onCommit, onRun, clearOnCommit, committed]);

  const revert = useCallback(() => {
    setChips(committed);
    setInput('');
    setErrors([]);
    setProblem(null);
    setNotice(null);
  }, [committed]);

  /** Typed text; a finished metric followed by a space becomes a chip right away. */
  const type = useCallback((value: string) => {
    setProblem(null);
    if (/\s$/.test(value) && !/\s$/.test(input)) {
      const parsed = parse(value, index);
      if (isComplete(parsed) && parsed.chips.every((c) => c.kind === 'metric')) {
        setChips((prev) => mergeChips(prev, parsed.chips));
        setInput('');
        return;
      }
    }
    setInput(value);
  }, [input, index]);

  /** A suggestion replacing the text from `from`; a finished line becomes chips. */
  const accept = useCallback((insert: string, from: number) => {
    const next = `${input.slice(0, from)}${insert}${insert.endsWith(' ') ? '' : ' '}`;
    const parsed = parse(next, index);
    if (isComplete(parsed)) {
      setChips((prev) => mergeChips(prev, parsed.chips));
      setInput('');
    } else {
      setInput(next);
    }
    setProblem(null);
  }, [input, index]);

  const remove = useCallback((at: number) => {
    setChips((prev) => prev.filter((_, i) => i !== at));
    setErrors([]);
  }, []);

  /** The chip back into text, to edit it. */
  const edit = useCallback((at: number) => {
    const chip = chips[at];
    if (!chip) return;
    if (!editableAsText(chip, index)) {
      setProblem('This filter was written in Configure (Advanced): edit it there.');
      return;
    }
    setChips((prev) => prev.filter((_, i) => i !== at));
    setErrors([]);
    setInput((prev) => `${[prev.trim(), chipText(chip)].filter(Boolean).join(' ')} `);
  }, [chips, index]);

  /** A period or comparison picked in its picker: applied straight away (the typed text stays). */
  const setPeriod = useCallback((chip: Chip) => {
    commit({ next: mergeChips(chips, [chip]), text: '' });
  }, [chips, commit]);

  /** A widget from elsewhere (Wicky) as the draft: shown as chips, run on Enter. */
  const fill = useCallback((next: DashboardWidget, message: string) => {
    locked.current = false;
    setChips(fromWidget({ ...next, period: next.period ?? widget.period }, { period: showPeriod }));
    setInput('');
    setErrors([]);
    setProblem(null);
    setNotice(message);
  }, [widget.period, showPeriod]);

  const setFocused = useCallback((value: boolean) => { focused.current = value; }, []);

  return {
    index, chips, input, errors, problem, notice, dirty,
    type, accept, commit, revert, remove, edit, setPeriod, fill, setFocused, setProblem,
  };
}
