import type { ReactNode } from 'react';
import { openExternal } from '../lib/openExternal';

/** Link to the Polar customer portal (lost license keys, device seats, billing). Renders nothing if unconfigured. */
export function PolarPortalLink({ url, children }: { url: string | null | undefined; children: ReactNode }) {
  if (!url) return null;
  return (
    <button
      type="button"
      onClick={() => openExternal(url)}
      className="text-brand-400 hover:text-brand-300 underline underline-offset-2"
    >
      {children}
    </button>
  );
}

/** Help line under a license key input. */
export function LicenseKeyHelp({ portalUrl }: { portalUrl: string | null | undefined }) {
  if (!portalUrl) return null;
  return (
    <p className="text-[11px] text-gray-500">
      Lost your key or out of device seats?{' '}
      <PolarPortalLink url={portalUrl}>Find it in the customer portal</PolarPortalLink>. Sign in with the email you
      purchased with.
    </p>
  );
}
