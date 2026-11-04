import { Languages } from 'lucide-react';
import { useState } from 'react';
import { setLocale, useLocale, type Locale } from './index';

/** Interface language selector; names stay in their own language, as is customary. */
export function LanguageSwitch({ className = '' }: { className?: string }) {
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  return (
    <label className={'language-switch ' + className} data-no-translate title="Idioma / Language">
      <Languages size={15} aria-hidden />
      <select
        aria-label="Idioma / Language"
        value={locale}
        disabled={busy}
        onChange={(event) => {
          setBusy(true);
          void setLocale(event.target.value as Locale).finally(() => setBusy(false));
        }}
      >
        <option value="pt">Português</option>
        <option value="en">English</option>
      </select>
    </label>
  );
}
