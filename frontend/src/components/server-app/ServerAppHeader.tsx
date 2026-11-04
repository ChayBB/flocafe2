'use client';

import type { ReactNode } from 'react';
import { ChefHat, Languages, ReceiptText } from 'lucide-react';
import { useTranslations } from 'use-intl';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { LANGUAGES, type Language } from '@/lib/i18n/languages';

const ROUND_BUTTON =
  'flex size-12 shrink-0 items-center justify-center rounded-full bg-white text-neutral-800 shadow-md transition-colors hover:bg-neutral-50 disabled:opacity-50';

/** The Server App and table-QR menu header: store cover, logo and name, table, customer, language and order history. */
export function ServerAppHeader({
  businessName,
  logoUrl,
  coverUrl,
  tableText,
  customerName,
  language,
  onLanguage,
  onHistory,
  historyDisabled,
  actions,
}: {
  businessName: string;
  logoUrl: string | null;
  coverUrl: string | null;
  tableText: string;
  customerName: string | null;
  language: Language;
  onLanguage: (language: Language) => void;
  onHistory: () => void;
  historyDisabled: boolean;
  actions: ReactNode;
}) {
  const t = useTranslations('serverApp');
  const languages = (Object.keys(LANGUAGES) as Language[]).filter(
    (code) => LANGUAGES[code].selectable,
  );
  return (
    <header data-testid="server-app-header" className="relative bg-background">
      <div className="relative h-48 overflow-hidden bg-gradient-to-br from-brand to-orange-300 sm:h-60">
        {coverUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={coverUrl}
            alt=""
            data-testid="server-app-header-cover"
            className="absolute inset-0 size-full object-cover"
          />
        )}
        <div className="absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-black/35 to-transparent" />
        <div className="relative mx-auto flex max-w-6xl items-start gap-2 px-3 pt-3">
          <p
            data-testid="server-app-header-table"
            className="min-w-0 truncate rounded-2xl bg-white px-4 py-2.5 text-[15px] font-medium text-neutral-800 shadow-md"
          >
            {tableText}
            {customerName && (
              <span data-testid="server-app-header-customer">
                <span className="mx-1.5 text-neutral-300">|</span>
                {customerName}
              </span>
            )}
          </p>
          <div className="ms-auto flex shrink-0 items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  data-testid="server-app-language-button"
                  aria-label={t('changeLanguage')}
                  title={t('changeLanguage')}
                  className={`${ROUND_BUTTON} flex-col gap-0 text-[10px] font-semibold leading-none`}
                >
                  <Languages size={16} />
                  <span className="mt-0.5 uppercase">{language}</span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="max-h-[60vh] overflow-y-auto">
                {languages.map((code) => (
                  <DropdownMenuItem
                    key={code}
                    onSelect={() => onLanguage(code)}
                    className={code === language ? 'font-medium text-brand' : ''}
                  >
                    {LANGUAGES[code].nativeName}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            <button
              type="button"
              data-testid="server-app-history-button"
              onClick={onHistory}
              disabled={historyDisabled}
              aria-label={t('orderHistory')}
              title={t('orderHistory')}
              className={ROUND_BUTTON}
            >
              <ReceiptText size={19} />
            </button>
            {actions}
          </div>
        </div>
      </div>
      <div className="relative -mt-14 flex flex-col items-center px-4 pb-4 sm:-mt-16">
        <div className="flex size-28 items-center justify-center overflow-hidden rounded-full border-4 border-white bg-white text-brand shadow-lg sm:size-32">
          {logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logoUrl}
              alt=""
              data-testid="server-app-header-logo"
              className="size-full object-contain"
            />
          ) : (
            <ChefHat size={44} />
          )}
        </div>
        <h1
          data-testid="server-app-header-name"
          className="mt-3 max-w-full truncate text-center text-2xl font-bold text-foreground"
        >
          {businessName || t('title')}
        </h1>
      </div>
    </header>
  );
}
