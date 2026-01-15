import { RootLayout } from '@/components/root-layout';
import { ApplyThemeScript } from '@/components/theme-toggle';

interface RootLayoutProps {
  children: React.ReactNode;
}

export default async function Layout({ children }: RootLayoutProps) {
  return (
    <RootLayout className="bg-background" headContent={<ApplyThemeScript />}>
      {children}
    </RootLayout>
  );
}
