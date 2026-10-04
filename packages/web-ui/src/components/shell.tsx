'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';

export interface NavItem {
  href: string;
  label: string;
}

export function isNavActive(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** ネイビーのサイドバー（モックアップ準拠）。幅 900px 以下ではメニューボタンで開閉するドロワーになる。 */
export function AppShell({
  brandSub,
  nav,
  sidebarFooter,
  contextBar,
  activeHref,
  onNavSelect,
  children,
}: {
  brandSub: string;
  nav: readonly NavItem[];
  sidebarFooter?: ReactNode;
  contextBar?: ReactNode;
  activeHref?: string;
  onNavSelect?: (href: string) => void;
  children: ReactNode;
}) {
  const pathname = usePathname() ?? '/';
  const [menuOpen, setMenuOpen] = useState(false);
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setMenuOpen(false);
  }

  return (
    <div className="hd-shell" data-menu-open={menuOpen}>
      <div className="hd-topbar">
        <Link href="/" className="hd-brand">
          HappyDrive
        </Link>
        <button
          type="button"
          className="hd-menu-button"
          aria-expanded={menuOpen}
          aria-controls="hd-sidebar"
          onClick={() => setMenuOpen((v) => !v)}
        >
          {menuOpen ? '閉じる' : 'メニュー'}
        </button>
      </div>
      {menuOpen ? <div className="hd-backdrop" onClick={() => setMenuOpen(false)} aria-hidden="true" /> : null}
      <aside id="hd-sidebar" className="hd-sidebar" aria-label="メインメニュー">
        <Link href="/" className="hd-brand">
          HappyDrive
          <small>{brandSub}</small>
        </Link>
        <nav className="hd-nav">
          {nav.map((item) => (
            <Link key={item.href} href={item.href} onClick={(event) => {
              if (onNavSelect && item.href.startsWith('#')) {
                event.preventDefault();
                onNavSelect(item.href);
                setMenuOpen(false);
              }
            }} aria-current={(activeHref ? activeHref === item.href : isNavActive(pathname, item.href)) ? 'page' : undefined}>
              {item.label}
            </Link>
          ))}
        </nav>
        {sidebarFooter ? <div className="hd-sidebar-footer">{sidebarFooter}</div> : null}
      </aside>
      <main className="hd-main" id="main">
        <div className="hd-main-inner">
          {contextBar ? <div className="hd-context-bar">{contextBar}</div> : null}
          {children}
        </div>
      </main>
    </div>
  );
}
