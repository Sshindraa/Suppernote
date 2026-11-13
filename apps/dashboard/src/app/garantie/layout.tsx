import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Empreinte bancaire | Suppernote',
  robots: { index: false, follow: false, nocache: true },
  referrer: 'no-referrer',
};

export default function CardGuaranteeLayout({ children }: { children: React.ReactNode }) {
  return children;
}
