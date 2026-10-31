import type { Metadata } from 'next';
import '../globals.css';
import { KdsHtmlLang } from '@/components/kds/KdsHtmlLang';

export const metadata: Metadata = {
  title: 'Flo KDS - Kitchen Display',
  description: 'Kitchen Display System',
};

export default function KdsStandaloneLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="h-dvh flex flex-col p-4 bg-muted">
      <KdsHtmlLang />
      {children}
    </div>
  );
}
