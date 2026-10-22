import Spinner from './Spinner';

interface RunButtonProps {
  running: boolean;
  onClick: () => void;
  label?: string;
}

export default function RunButton({ running, onClick, label = 'Run' }: RunButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={running}
      className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded border border-gray-700 bg-surface-elevated text-gray-300 hover:border-brand-600 hover:text-brand-300 transition-colors disabled:opacity-40"
    >
      {running ? <Spinner /> : null}
      {running ? 'Running…' : label}
    </button>
  );
}
