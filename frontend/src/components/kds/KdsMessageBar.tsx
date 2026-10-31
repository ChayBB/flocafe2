'use client';

import { ArrowLeftRight, Ban, Check, Merge, ShoppingBag, TriangleAlert } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { KdsBellButton } from '@/components/kds/KdsBellButton';
import type { KdsMessage } from '@/lib/kds-messages';

const ICONS = {
  move: ArrowLeftRight,
  merge: Merge,
  takeaway: ShoppingBag,
  cancelled: Ban,
  emergency: TriangleAlert,
} as const;

/**
 * The bar under the board: table moves and merges, items switched to take-away and emergency calls
 * stay here until someone taps to acknowledge them; the bell button sits at its end when shown.
 */
export function KdsMessageBar({
  messages,
  onDismiss,
  showBell,
}: {
  messages: KdsMessage[];
  onDismiss: (id: string) => void;
  showBell: boolean;
}) {
  const t = useTranslations('kds');
  return (
    <div data-testid="kds-message-bar" className="mt-3 flex min-h-14 shrink-0 items-stretch gap-2">
      <div className="flex min-w-0 flex-1 items-stretch gap-2 overflow-x-auto rounded-lg border border-border bg-card p-1.5">
        {messages.length === 0 ? (
          <span className="flex items-center px-2 text-sm text-muted-foreground">{t('messagesEmpty')}</span>
        ) : (
          messages.map((message) => {
            const Icon = ICONS[message.kind];
            const emergency = message.kind === 'emergency';
            return (
              <div
                key={message.id}
                data-testid="kds-message"
                data-kind={message.kind}
                className={`flex shrink-0 items-center gap-2 rounded-md border ps-3 pe-1 text-sm font-medium ${
                  emergency
                    ? 'border-red-500 bg-red-600 text-white'
                    : 'border-(--kds-pending-line) bg-(--kds-pending-tint) text-foreground'
                }`}
              >
                <Icon size={18} className={emergency ? 'text-white' : 'text-(--kds-pending-text)'} />
                <span className="max-w-[28rem] truncate">{message.text}</span>
                <span className={`text-xs tabular-nums ${emergency ? 'text-white/80' : 'text-muted-foreground'}`}>
                  {new Date(message.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
                <button
                  type="button"
                  data-testid="kds-message-dismiss"
                  onClick={() => onDismiss(message.id)}
                  aria-label={t('messageDismiss')}
                  title={t('messageDismiss')}
                  className={`flex min-h-11 min-w-11 items-center justify-center rounded-md ${
                    emergency ? 'hover:bg-white/15' : 'hover:bg-muted'
                  }`}
                >
                  <Check size={18} />
                </button>
              </div>
            );
          })
        )}
      </div>
      {showBell && <KdsBellButton />}
    </div>
  );
}
