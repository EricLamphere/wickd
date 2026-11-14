import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Eye, EyeOff, CheckCircle2, AlertTriangle, ExternalLink } from 'lucide-react';
import { api, ApiError, type LicenseStatusDto } from '../lib/api';
import { openExternal } from '../lib/openExternal';
import { LicenseKeyHelp } from './PolarPortalLink';

const REASON_COPY: Record<string, string> = {
  not_entitled: 'Your subscription is no longer active. Renew or enter a new license key below.',
  unreachable: "Couldn't verify your license and the offline grace period has expired. Check your connection and try again.",
  activation_limit_reached: 'This license key has reached its device activation limit. Free up a seat in your Polar customer portal, then retry.',
  grace_period: 'Your license is valid but could not be freshly verified — Pro features remain enabled for now.',
};

export function SubscriptionSection() {
  const qc = useQueryClient();
  const { data: license } = useQuery({
    queryKey: ['license'],
    queryFn: () => api.license.get(),
  });

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-1">Subscription</h3>
        <p className="text-xs text-gray-500">Your wickd Pro license, shared across all projects on this installation.</p>
      </div>

      {license && (license.has_key
        ? <SubscribedView license={license} />
        : <UnsubscribedView qc={qc} />)}
    </div>
  );
}

// ---- Subscribed ----

function SubscribedView({ license }: { license: LicenseStatusDto }) {
  const [revealed, setRevealed] = useState(false);

  const reasonCopy = !license.entitled ? REASON_COPY[license.reason] : null;
  const key = license.license_key ?? '';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-xs">
        {license.entitled ? (
          <>
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <span className="text-gray-200 font-medium">wickd Pro is active</span>
          </>
        ) : (
          <>
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
            <span className="text-gray-200 font-medium">License on file, but not currently active</span>
          </>
        )}
      </div>

      {reasonCopy && (
        <p className="text-xs text-amber-400/90 bg-amber-500/10 border border-amber-500/30 rounded px-3 py-2">
          {reasonCopy}
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <span className="text-[11px] text-gray-500 uppercase tracking-wide">License key</span>
        <div className="flex items-center gap-2 bg-surface-panel border border-gray-800 rounded px-3 py-2">
          <span className="flex-1 font-mono text-xs text-gray-300 truncate select-all">
            {revealed ? key : '•'.repeat(Math.min(key.length, 40) || 32)}
          </span>
          <button
            onClick={() => setRevealed((v) => !v)}
            title={revealed ? 'Hide license key' : 'Reveal license key'}
            className="text-gray-500 hover:text-gray-300 p-1 shrink-0"
          >
            {revealed ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          </button>
        </div>
        <p className="text-[11px] text-gray-600">
          Anyone with this key can activate a device on it — don't share it.
          {license.limit_activations !== null &&
            ` It works on up to ${license.limit_activations} device${license.limit_activations === 1 ? '' : 's'}.`}
        </p>
      </div>

      {license.portal_url && <ManageInPortal url={license.portal_url} />}
    </div>
  );
}

// ---- Customer portal ----

/** Device seats and cancelling live in Polar's customer portal: the app can't
 *  do either without Polar's organization API key, which must never ship in it. */
function ManageInPortal({ url }: { url: string }) {
  return (
    <div className="flex flex-col gap-2 pt-2 border-t border-gray-800">
      <p className="text-xs text-gray-400">
        See which devices use your key, free up a seat, update billing, or cancel your subscription in the Polar
        customer portal. Sign in with the email you purchased with.
      </p>
      <button
        type="button"
        onClick={() => openExternal(url)}
        className="flex items-center gap-1.5 self-start px-3 py-1.5 text-xs rounded border border-gray-700 text-gray-300 hover:text-gray-100 hover:bg-gray-800 transition-colors"
      >
        Manage subscription
        <ExternalLink className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

// ---- Not subscribed ----

function UnsubscribedView({ qc }: { qc: ReturnType<typeof useQueryClient> }) {
  const [licenseKey, setLicenseKey] = useState('');
  const [showKeyInput, setShowKeyInput] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: license } = useQuery({
    queryKey: ['license'],
    queryFn: () => api.license.get(),
  });

  const setKeyMutation = useMutation({
    mutationFn: (key: string) => api.license.set(key),
    onSuccess: (result) => {
      qc.setQueryData(['license'], result);
      qc.invalidateQueries({ queryKey: ['license'] });
      if (!result.entitled) setError(REASON_COPY[result.reason] ?? 'License key was not accepted.');
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : 'Failed to activate license key.');
    },
  });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-xs">
        <AlertTriangle className="w-4 h-4 text-gray-500 shrink-0" />
        <span className="text-gray-300">No active wickd Pro subscription</span>
      </div>

      <div className="flex items-center gap-2">
        {license?.checkout_url && (
          <button
            onClick={() => openUrl(license.checkout_url!)}
            className="px-3 py-1.5 text-xs rounded bg-brand-600 hover:bg-brand-500 text-white font-medium transition-colors"
          >
            Subscribe to Pro
          </button>
        )}
        <button
          onClick={() => setShowKeyInput((v) => !v)}
          className="px-3 py-1.5 text-xs rounded border border-gray-700 text-gray-400 hover:text-gray-200 transition-colors"
        >
          Have a license key?
        </button>
      </div>

      {showKeyInput && (
        <div className="flex flex-col gap-2">
          <input
            type="text"
            value={licenseKey}
            onChange={(e) => setLicenseKey(e.target.value)}
            placeholder="WICKD_-XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX"
            className="bg-surface-elevated border border-gray-700 rounded px-3 py-1.5 text-xs font-mono text-gray-100 placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
          {error && <p className="text-xs text-red-400">{error}</p>}
          <LicenseKeyHelp portalUrl={license?.portal_url} />
          <button
            onClick={() => {
              setError(null);
              setKeyMutation.mutate(licenseKey.trim());
            }}
            disabled={!licenseKey.trim() || setKeyMutation.isPending}
            className="self-end px-3 py-1.5 text-xs rounded bg-brand-600 hover:bg-brand-500 text-white disabled:opacity-40 transition-colors"
          >
            {setKeyMutation.isPending ? 'Activating…' : 'Activate'}
          </button>
        </div>
      )}
    </div>
  );
}
