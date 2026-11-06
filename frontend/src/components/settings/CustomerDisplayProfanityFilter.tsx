'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';

const FILTER_PATH = '/settings/customer-display/profanity-filter';

function readWords(data: { words?: unknown }): string {
  if (!Array.isArray(data?.words) || !data.words.every((word) => typeof word === 'string')) {
    throw new Error('Invalid profanity filter response');
  }
  return data.words.join('\n');
}

export function CustomerDisplayProfanityFilter() {
  const t = useTranslations('customerDisplay');
  const tCommon = useTranslations('common');
  const tSettings = useTranslations('settings');
  const [open, setOpen] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const words = draft
    .split('\n')
    .map((word) => word.trim().normalize('NFC'))
    .filter(Boolean);
  const invalid = words.length > 200 || words.some((word) => word.length > 50);

  useEffect(() => {
    if (!open || saved !== null || loadFailed) return;
    const controller = new AbortController();
    api
      .get(FILTER_PATH, { signal: controller.signal })
      .then(({ data }) => {
        if (controller.signal.aborted) return;
        const text = readWords(data);
        setDraft(text);
        setSaved(text);
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadFailed(true);
      });
    return () => controller.abort();
  }, [open, saved, loadFailed]);

  async function save() {
    setSaving(true);
    try {
      const { data } = await api.put(FILTER_PATH, { words });
      const text = readWords(data);
      setDraft(text);
      setSaved(text);
      toast.success(t('saved'));
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <details
      className="mb-4 rounded-lg border border-border px-3 py-2"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm font-medium text-foreground">
        {t('profanityFilter')}
      </summary>
      {loadFailed ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {t('configLoadFailed')}{' '}
          <button type="button" onClick={() => setLoadFailed(false)} className="underline">
            {tSettings('retry')}
          </button>
        </p>
      ) : saved === null ? (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          {tCommon('loading')}
        </p>
      ) : (
        <>
          <label
            htmlFor="customer-display-profanity-words"
            className="mt-3 block text-sm text-muted-foreground"
          >
            {t('profanityFilterHint')}
          </label>
          <textarea
            id="customer-display-profanity-words"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={saving}
            aria-invalid={invalid}
            aria-describedby={invalid ? 'customer-display-profanity-limit' : undefined}
            rows={4}
            className="mt-2 block w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
          />
          {invalid && (
            <p
              id="customer-display-profanity-limit"
              role="alert"
              className="mt-2 text-sm text-destructive"
            >
              {t('profanityFilterLimit')}
            </p>
          )}
          <button
            type="button"
            onClick={save}
            disabled={saving || invalid || draft === saved}
            className="mt-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving ? tCommon('saving') : tCommon('save')}
          </button>
        </>
      )}
    </details>
  );
}
