'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { ArrowUpDown } from 'lucide-react';
import { useTranslations } from 'use-intl';

export interface CustomerDetailsValue {
  firstName: string;
  lastName: string;
  phone: string;
  birthday: string;
  notes: string;
}

export const EMPTY_CUSTOMER_DETAILS: CustomerDetailsValue = {
  firstName: '',
  lastName: '',
  phone: '',
  birthday: '',
  notes: '',
};

interface Props {
  value: CustomerDetailsValue;
  onChange: (patch: Partial<CustomerDetailsValue>) => void;
  phoneRequired?: boolean;
  autoFocusField?: 'firstName' | 'phone';
  onSwapNameAndPhone?: () => void;
}

const BUDDHIST_ERA_OFFSET = 543;

function formatBirthdayDigits(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 8);
  return [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4)].filter(Boolean).join('/');
}

function isoToBirthdayText(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '';
}

/** Reads dd/mm/yyyy (Buddhist-era years such as 2522 are accepted) into yyyy-mm-dd, or null. */
function parseBirthdayText(text: string): string | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  let year = Number(match[3]);
  if (year > new Date().getFullYear()) year -= BUDDHIST_ERA_OFFSET;
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  if (year < 1900 || date > new Date()) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

function BirthdayInput({
  id,
  value,
  onChange,
  className,
}: {
  id: string;
  value: string;
  onChange: (iso: string) => void;
  className: string;
}) {
  const t = useTranslations('customer');
  const [text, setText] = useState(() => isoToBirthdayText(value));
  const [seen, setSeen] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  if (value !== seen) {
    setSeen(value);
    setText(isoToBirthdayText(value));
  }
  const invalid = text !== '' && parseBirthdayText(text) === null;

  useEffect(() => {
    inputRef.current?.setCustomValidity(invalid ? t('birthdayInvalid') : '');
  }, [invalid, t]);

  return (
    <input
      ref={inputRef}
      id={id}
      name="birthday"
      type="text"
      inputMode="numeric"
      autoComplete="off"
      placeholder={t('birthdayPlaceholder')}
      value={text}
      aria-invalid={invalid || undefined}
      onChange={(e) => {
        const next = formatBirthdayDigits(e.target.value);
        const iso = parseBirthdayText(next) ?? '';
        setText(next);
        setSeen(iso);
        onChange(iso);
      }}
      className={className}
      dir="ltr"
    />
  );
}

const inputClass =
  'w-full px-3 py-2 text-sm border border-border rounded-lg bg-background outline-none focus:ring-2 focus:ring-brand focus:border-brand';
const labelClass = 'block text-xs font-medium text-muted-foreground mb-1';

export default function CustomerDetailsFields({
  value,
  onChange,
  phoneRequired = false,
  autoFocusField = 'firstName',
  onSwapNameAndPhone,
}: Props) {
  const t = useTranslations('customer');
  const tPos = useTranslations('pos');
  const id = useId();

  return (
    <div className="space-y-3">
      <div>
        <div className="flex justify-between items-center mb-1">
          <label
            htmlFor={`${id}-first`}
            className="block text-xs font-medium text-muted-foreground"
          >
            {t('firstName')}
          </label>
          {onSwapNameAndPhone && (
            <button
              type="button"
              onClick={onSwapNameAndPhone}
              className="text-xs text-brand hover:text-brand-hover flex items-center gap-1 font-medium transition-colors cursor-pointer"
            >
              <ArrowUpDown size={12} />
              <span>{tPos('swapNameAndPhone')}</span>
            </button>
          )}
        </div>
        <input
          id={`${id}-first`}
          name="first_name"
          type="text"
          value={value.firstName}
          onChange={(e) => onChange({ firstName: e.target.value })}
          className={inputClass}
          autoFocus={autoFocusField === 'firstName'}
          required
        />
      </div>
      <div>
        <label htmlFor={`${id}-last`} className={labelClass}>
          {t('lastName')}
        </label>
        <input
          id={`${id}-last`}
          name="last_name"
          type="text"
          value={value.lastName}
          onChange={(e) => onChange({ lastName: e.target.value })}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor={`${id}-phone`} className={labelClass}>
          {t('phoneNumber')}
        </label>
        <input
          id={`${id}-phone`}
          name="phone"
          type="tel"
          inputMode="tel"
          value={value.phone}
          onChange={(e) => onChange({ phone: e.target.value })}
          placeholder={tPos('localPhonePlaceholder')}
          className={inputClass}
          dir="ltr"
          autoFocus={autoFocusField === 'phone'}
          required={phoneRequired}
        />
      </div>
      <div>
        <label htmlFor={`${id}-birthday`} className={labelClass}>
          {t('birthday')}
        </label>
        <BirthdayInput
          id={`${id}-birthday`}
          value={value.birthday}
          onChange={(birthday) => onChange({ birthday })}
          className={inputClass}
        />
      </div>
      <div>
        <label htmlFor={`${id}-notes`} className={labelClass}>
          {t('note')}
        </label>
        <textarea
          id={`${id}-notes`}
          name="notes"
          maxLength={500}
          rows={2}
          value={value.notes}
          onChange={(e) => onChange({ notes: e.target.value })}
          className={`${inputClass} resize-none`}
        />
      </div>
    </div>
  );
}
