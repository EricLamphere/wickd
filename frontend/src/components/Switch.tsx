// An on/off switch: a pill whose knob slides right when on. Use it for settings that are
// enabled or disabled (a schedule, a monitor), never for selecting rows; that's a checkbox.

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  title?: string;
}

export function Switch({ checked, onChange, label, disabled = false, title }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={title ?? (checked ? 'On' : 'Off')}
      disabled={disabled}
      onClick={(e) => { e.stopPropagation(); onChange(!checked); }}
      className={`relative inline-flex shrink-0 w-7 h-4 rounded-full border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/60 disabled:opacity-50 disabled:cursor-not-allowed ${
        checked ? 'bg-brand-600 border-brand-500' : 'bg-gray-700 border-gray-600'}`}
    >
      <span
        aria-hidden
        className={`absolute top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-white shadow transition-transform ${
          checked ? 'translate-x-[13px]' : 'translate-x-[1px]'}`}
      />
    </button>
  );
}
