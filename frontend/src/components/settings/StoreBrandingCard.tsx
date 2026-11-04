'use client';

import { useEffect, useRef, useState } from 'react';
import { ImagePlus, Trash2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { Button } from '@/components/ui/button';
import { MAX_RAW_FILE_SIZE, fitImage } from '@/lib/image-utils';

type Kind = 'logo' | 'cover';

const FIELD: Record<Kind, 'store_logo' | 'store_cover'> = {
  logo: 'store_logo',
  cover: 'store_cover',
};
// Mirrors the backend caps in main/lib/store-branding.ts.
const LIMITS: Record<Kind, { side: number; length: number }> = {
  logo: { side: 512, length: 300_000 },
  cover: { side: 1600, length: 1_500_000 },
};

/** The store logo and cover photo shown in the Server App and table-QR menu header. */
export function StoreBrandingCard() {
  const t = useTranslations('settings');
  const [images, setImages] = useState<Record<Kind, string>>({ logo: '', cover: '' });
  const [saving, setSaving] = useState<Kind | null>(null);
  const inputs = { logo: useRef<HTMLInputElement>(null), cover: useRef<HTMLInputElement>(null) };

  useEffect(() => {
    api
      .get<{ store_logo: string; store_cover: string }>('/settings/branding')
      .then(({ data }) => setImages({ logo: data.store_logo, cover: data.store_cover }))
      .catch(() => {});
  }, []);

  const save = async (kind: Kind, value: string) => {
    setSaving(kind);
    try {
      const { data } = await api.put<{ store_logo: string; store_cover: string }>(
        '/settings/branding',
        { [FIELD[kind]]: value },
      );
      setImages({ logo: data.store_logo, cover: data.store_cover });
      toast.success(t('allSaved'));
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setSaving(null);
    }
  };

  const pick = async (kind: Kind, file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_RAW_FILE_SIZE) {
      toast.error(t('menuImageTooLarge'));
      return;
    }
    const dataUri = await fitImage(file, LIMITS[kind].side, LIMITS[kind].length);
    if (!dataUri) {
      toast.error(t('menuImageTooLarge'));
      return;
    }
    await save(kind, dataUri);
  };

  const slot = (kind: Kind) => (
    <div className="space-y-2">
      <p className="text-sm font-medium text-foreground">
        {kind === 'logo' ? t('menuLogo') : t('menuCover')}
      </p>
      <div
        className={`flex items-center justify-center overflow-hidden rounded-lg border border-dashed border-border bg-muted/40 ${kind === 'logo' ? 'size-24 rounded-full' : 'aspect-[3/1] w-full max-w-md'}`}
      >
        {images[kind] ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={images[kind]}
            alt=""
            className={`size-full ${kind === 'logo' ? 'object-contain' : 'object-cover'}`}
          />
        ) : (
          <ImagePlus size={22} className="text-muted-foreground" />
        )}
      </div>
      <input
        ref={inputs[kind]}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        data-testid={`settings-store-${kind}-input`}
        onChange={(e) => {
          void pick(kind, e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={saving !== null}
          onClick={() => inputs[kind].current?.click()}
        >
          <ImagePlus size={15} className="me-1.5" />
          {images[kind] ? t('menuImageChange') : t('menuImageUpload')}
        </Button>
        {images[kind] && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={saving !== null}
            onClick={() => void save(kind, '')}
            aria-label={t('menuImageRemove')}
            title={t('menuImageRemove')}
          >
            <Trash2 size={15} />
          </Button>
        )}
      </div>
    </div>
  );

  return (
    <div
      data-testid="settings-store-branding"
      className="bg-card rounded-xl border border-border p-6"
    >
      <p className="font-medium text-foreground">{t('menuBranding')}</p>
      <p className="mb-4 text-sm text-muted-foreground">{t('menuBrandingHint')}</p>
      <div className="grid gap-6 sm:grid-cols-[auto_1fr]">
        {slot('logo')}
        {slot('cover')}
      </div>
    </div>
  );
}
