'use client';

import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import api from '@/lib/api';

const FILTER_PATH = '/settings/customer-display/profanity-filter';
const WORD_SEPARATORS = /[\s,，、]+/u;

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
  const [draft, setDraft] = useState<string | null>(null);
  const [editing, setEditing] = useState(true);
  const [saving, setSaving] = useState(false);
  const text = draft ?? saved ?? '';
  const words = [...new Set(text.normalize('NFC').split(WORD_SEPARATORS).filter(Boolean))];
  const invalid = words.length > 200 || words.some((word) => word.length > 50);

  useEffect(() => {
    if (!open || saved !== null || loadFailed || saving) return;
    const controller = new AbortController();
    api
      .get(FILTER_PATH, { signal: controller.signal })
      .then(({ data }) => {
        if (controller.signal.aborted) return;
        setSaved(readWords(data));
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadFailed(true);
      });
    return () => controller.abort();
  }, [open, saved, loadFailed, saving]);

  async function editOrSave() {
    if (!editing) {
      setEditing(true);
      return;
    }
    if (text === saved) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const { data } = await api.put(FILTER_PATH, { words });
      const text = readWords(data);
      setDraft(null);
      setSaved(text);
      setLoadFailed(false);
      setEditing(false);
      toast.success(t('saved'));
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  function show() {
    setOpen(true);
    setEditing(true);
  }

  if (!open) {
    return (
      <button
        type="button"
        data-testid="customer-display-profanity-row"
        onClick={show}
        className="mb-4 flex w-full items-center gap-3 rounded-lg border border-border px-4 py-3 text-start transition-colors hover:bg-muted/60"
      >
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-foreground">{t('profanityFilter')}</span>
          <span className="block text-sm text-muted-foreground">{t('profanityFilterRowHint')}</span>
        </span>
        <ChevronRight size={18} className="shrink-0 text-muted-foreground rtl-flip" />
      </button>
    );
  }

  return (
    <section
      data-testid="customer-display-profanity-panel"
      aria-labelledby="customer-display-profanity-title"
      className="mb-4 rounded-lg border border-border px-4 py-3"
    >
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="mb-3 flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft size={16} className="rtl-flip" />
        {tCommon('back')}
      </button>
      <h4 id="customer-display-profanity-title" className="font-medium text-foreground">
        {t('profanityFilter')}
      </h4>
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
      ) : null}
      <label
        htmlFor="customer-display-profanity-words"
        className="mt-3 block text-sm text-muted-foreground"
      >
        {t('profanityFilterHint')}
      </label>
      <textarea
        id="customer-display-profanity-words"
        value={text}
        onChange={(event) => setDraft(event.target.value)}
        readOnly={!editing}
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
        onClick={editOrSave}
        disabled={saving || invalid || (saved === null && words.length === 0)}
        className={`mt-2 rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50 ${
          editing
            ? 'bg-brand text-white hover:opacity-90'
            : 'border border-border bg-muted text-foreground hover:bg-background'
        }`}
      >
        {editing ? tCommon('save') : tCommon('edit')}
      </button>
    </section>
  );
}
