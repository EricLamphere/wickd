// Where a link in a dashboard text widget goes: web and mail links as written, a bare domain
// ("example.com/page", "www.example.com") as https, anything else (a relative path, the "url"
// placeholder ⌘K inserts) nowhere — it's still drawn as a link, just not clickable.
const SCHEME = /^(https?:|mailto:)/i;
const BARE_DOMAIN = /^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}(:\d+)?([/?#]|$)/i;

export function widgetLinkHref(href: string | null | undefined): string | null {
  const url = (href ?? '').trim();
  if (SCHEME.test(url)) return url;
  if (BARE_DOMAIN.test(url)) return `https://${url}`;
  return null;
}
