// The query composer (plan 16): one line of chips you type into, across the top of the query view
// (and as the metric index's entry box). Keyboard first: type → suggestions (↑↓, Enter or Tab
// accepts), Enter on a finished line applies it, ⌘Enter applies and runs, Esc reverts, Backspace
// on an empty input removes the last chip, ←/→ walk the chips (Enter edits, Backspace removes).
// Clicking a chip turns it back into text. Pro: a line starting with `?` asks Wicky, whose answer
// fills the chips (useComposerWicky). State and the widget mapping: useComposer, lib/composer*.ts.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Sparkles } from 'lucide-react';
import type { DashboardWidget } from '../../../../lib/dashboardsApi';
import type { SemanticCatalogDto } from '../../../../lib/semanticApi';
import { UpgradeModal } from '../../components/UpgradeModal';
import { useProEntitled } from '../../RunHistory/usePerformance';
import { useValueSuggest } from '../dashboards/builder/PeriodBar';
import { explorePeriod } from '../lib/exploreWidget';
import { parse, type Chip } from '../lib/composer';
import { suggest, valueSuggestions, type Suggestion } from '../lib/composerSuggest';
import { ComposerChip } from './ComposerChip';
import { ComposerSuggestions } from './ComposerSuggestions';
import { useComposer } from './useComposer';
import { useComposerWicky, WICKY_PREFIX } from './useComposerWicky';

interface Props {
  projectId: number;
  catalog: SemanticCatalogDto;
  labels: Map<string, string>;
  widget: DashboardWidget;
  onCommit: (widget: DashboardWidget) => void;
  onRun?: () => void;
  /** the query view: the period and comparison chips are always there (and can't be removed) */
  showPeriod?: boolean;
  clearOnCommit?: boolean;
  placeholder?: string;
  /** the line's box (it grows into a toolbar by default) */
  className?: string;
}

/** A filter dimension's values, fetched once per dimension. */
function useFilterValues(dimension: string | null, fetchValues: (d: string) => Promise<string[]>) {
  const [cache, setCache] = useState<Record<string, string[]>>({});
  const [loading, setLoading] = useState<string | null>(null);
  useEffect(() => {
    if (!dimension || cache[dimension]) return;
    let live = true;
    setLoading(dimension);
    fetchValues(dimension)
      .then((values) => { if (live) setCache((prev) => ({ ...prev, [dimension]: values })); })
      .catch(() => { if (live) setCache((prev) => ({ ...prev, [dimension]: [] })); })
      .finally(() => { if (live) setLoading(null); });
    return () => { live = false; };
  }, [dimension, cache, fetchValues]);
  return { values: dimension ? cache[dimension] ?? [] : [], loading: !!dimension && loading === dimension };
}

const isPeriodChip = (c: Chip) => c.kind === 'period' || c.kind === 'compare';

export function Composer({
  projectId, catalog, labels, widget, onCommit, onRun, showPeriod = true, clearOnCommit, placeholder, className = 'flex-1 min-w-[16rem]',
}: Props) {
  const c = useComposer({ widget, catalog, showPeriod, onCommit, onRun, clearOnCommit });
  const root = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const [closed, setClosed] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [upgrade, setUpgrade] = useState(false);
  const { entitled } = useProEntitled();
  const wicky = useComposerWicky(projectId, catalog);

  const asking = c.input.startsWith(WICKY_PREFIX);
  const sugg = useMemo(() => (asking ? null : suggest(c.input, c.chips, c.index)), [asking, c.input, c.chips, c.index]);
  const metrics = useMemo(() => [...new Set([...c.chips, ...parse(c.input, c.index).chips]
    .flatMap((chip) => (chip.kind === 'metric' ? [chip.name] : [])))], [c.chips, c.input, c.index]);
  const fetchValues = useValueSuggest(projectId, catalog, metrics);
  const filterValues = useFilterValues(sugg?.values?.dimension ?? null, fetchValues);
  const items = sugg?.values ? valueSuggestions(filterValues.values, sugg.values.partial) : sugg?.items ?? [];
  const open = focused && !closed && !asking && (items.length > 0 || filterValues.loading);
  const removable = (chip: Chip) => !(showPeriod && isPeriodChip(chip));
  const current = c.chips.find((chip): chip is Extract<Chip, { kind: 'period' }> => chip.kind === 'period')?.value ?? explorePeriod(widget).current;

  // a fresh word (or a construct waiting for its next part) highlights the first suggestion;
  // after a finished word nothing is highlighted, so Enter applies the line
  useEffect(() => {
    const typing = c.input.length > 0 && !/\s$/.test(c.input);
    setHighlight(typing || parse(c.input, c.index).pending ? 0 : -1);
    setClosed(false);
  }, [c.input, c.index]);

  const pick = useCallback((item: Suggestion) => {
    if (sugg) c.accept(item.insert, sugg.from);
    setActive(null);
    inputRef.current?.focus();
  }, [sugg, c]);

  const askWicky = async () => {
    const question = c.input.slice(WICKY_PREFIX.length).trim();
    if (!question) return;
    if (!entitled) { setUpgrade(true); return; }
    try {
      c.fill(await wicky.ask(question), "Wicky's reading of your question — check the chips, then press Enter to run it.");
    } catch (err) {
      c.setProblem(err instanceof Error ? err.message : String(err));
    }
  };

  const lastRemovable = () => {
    for (let i = c.chips.length - 1; i >= 0; i -= 1) if (removable(c.chips[i])) return i;
    return -1;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const cmd = e.metaKey || e.ctrlKey;
    if (cmd && e.key === 'Enter') {
      // the query view's own ⌘Enter (Refresh) mustn't fire as well
      e.preventDefault();
      e.stopPropagation();
      if (asking) void askWicky(); else c.commit({ run: true });
      return;
    }
    const caretAtStart = e.currentTarget.selectionStart === 0 && e.currentTarget.selectionEnd === 0;
    switch (e.key) {
      case 'ArrowDown':
        if (open && items.length) { e.preventDefault(); setHighlight((h) => (h + 1) % items.length); }
        return;
      case 'ArrowUp':
        if (open && items.length) { e.preventDefault(); setHighlight((h) => (h <= 0 ? items.length - 1 : h - 1)); }
        return;
      case 'Tab':
        if (open && items.length) { e.preventDefault(); pick(items[Math.max(0, highlight)]); }
        return;
      case 'Enter':
        e.preventDefault();
        if (active !== null) { c.edit(active); setActive(null); return; }
        if (open && highlight >= 0 && items[highlight]) { pick(items[highlight]); return; }
        if (asking) { void askWicky(); return; }
        c.commit();
        return;
      case 'Escape':
        if (open && items.length) { e.preventDefault(); setClosed(true); return; }
        if (active !== null) { e.preventDefault(); setActive(null); return; }
        // with nothing to revert, Escape closes the query view as usual
        if (c.dirty) { e.preventDefault(); c.revert(); }
        return;
      case 'Backspace':
      case 'Delete':
        if (c.input) return;
        e.preventDefault();
        {
          const at = active ?? (e.key === 'Backspace' ? lastRemovable() : -1);
          if (at >= 0 && c.chips[at] && removable(c.chips[at])) c.remove(at);
        }
        setActive(null);
        return;
      case 'ArrowLeft':
        if (caretAtStart && c.chips.length) { e.preventDefault(); setActive((a) => (a === null ? c.chips.length - 1 : Math.max(0, a - 1))); }
        return;
      case 'ArrowRight':
        if (active !== null) { e.preventDefault(); setActive((a) => (a === null || a + 1 >= c.chips.length ? null : a + 1)); }
        return;
      default:
        if (e.key.length === 1) setActive(null);
    }
  };

  const errorFor = (i: number) => c.errors.find((er) => er.index === i)?.message ?? (c.chips[i]?.kind === 'draft' ? (c.chips[i] as { error: string }).error : null);
  const firstError = c.errors[0]?.message ?? null;
  const hint = placeholder ?? `Type a metric, then by …, a period, vs …, where …, top N${entitled ? ` — or ${WICKY_PREFIX} to ask Wicky` : ''}`;

  return (
    <div ref={root} className={`relative ${className}`}
      onFocus={() => { setFocused(true); c.setFocused(true); }}
      onBlur={(e) => {
        if (root.current?.contains(e.relatedTarget as Node | null)) return;
        setFocused(false);
        c.setFocused(false);
        setActive(null);
        if (c.dirty && !asking) c.commit();
      }}>
      <div onMouseDown={(e) => { if (e.target === e.currentTarget) { e.preventDefault(); inputRef.current?.focus(); } }}
        className={`flex flex-wrap items-center gap-1 min-h-[32px] px-1.5 py-1 rounded border bg-surface-app cursor-text ${focused ? 'border-brand-600' : 'border-gray-700'}`}>
        {c.chips.map((chip, i) => (
          <ComposerChip key={`${i}-${JSON.stringify(chip)}`} chip={chip} labels={labels} current={current} error={errorFor(i)}
            active={active === i} removable={removable(chip)}
            onEdit={() => { c.edit(i); inputRef.current?.focus(); }} onRemove={() => c.remove(i)} onPeriod={c.setPeriod} />
        ))}
        <input ref={inputRef} value={c.input} onChange={(e) => c.type(e.target.value)} onKeyDown={onKeyDown}
          placeholder={c.chips.some((chip) => !isPeriodChip(chip)) ? '' : hint} aria-label="Query" spellCheck={false} autoComplete="off"
          aria-autocomplete="list" aria-expanded={open}
          className="flex-1 min-w-[8rem] py-0.5 bg-transparent text-xs text-gray-200 outline-none placeholder:text-gray-600" />
        {wicky.asking && <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin text-brand-300" />}
        {c.dirty && !wicky.asking && <span className="shrink-0 pr-1 text-[10px] text-gray-500">Enter to apply</span>}
      </div>
      {open && <ComposerSuggestions items={items} highlight={highlight} onPick={pick} onHover={setHighlight} loading={filterValues.loading} />}
      {focused && asking && (
        <p className="flex items-center gap-1 mt-1 text-[11px] text-brand-200">
          <Sparkles className="w-3 h-3" />
          {entitled ? 'Enter: Wicky writes the query from your words (you check the chips before it runs)' : 'Asking in words is a wickd Pro feature — Enter to unlock'}
        </p>
      )}
      {(c.problem || firstError) && <p className="mt-1 text-[11px] text-red-300">{c.problem ?? firstError}</p>}
      {c.notice && !c.problem && !firstError && <p className="mt-1 text-[11px] text-brand-200">{c.notice}</p>}
      {upgrade && <UpgradeModal feature="Ask Wicky in the query composer" onClose={() => setUpgrade(false)} />}
    </div>
  );
}
