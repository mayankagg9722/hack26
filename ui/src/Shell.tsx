import type { ReactNode } from "react";
import { Avatar, Breadcrumb, HyperlinkButton, Icon, TopNavigation } from "@freshworks/dew-components";
import type { IconName } from "@freshworks/dew-components";

/* Admin Hub frame: Dew TopNavigation, left navigation, breadcrumb + page header. */

interface NavItem { label: string; href: string; icon: IconName }

const NAV: NavItem[] = [
  { label: "Overview", href: "dashboard.html", icon: "Home" },
  { label: "Integrations", href: "integrations.html", icon: "Transfer" },
  { label: "Migration agent", href: "agent.html", icon: "Bots" },
  { label: "Field mapping", href: "mapping.html", icon: "Link" },
  { label: "Goal planner", href: "planner.html", icon: "ScheduleApplied" },
  { label: "Migration history", href: "history.html", icon: "Time" },
];

export function Shell({ title, description, actions, active = "integrations.html", children }: { title: string; description: string; actions?: ReactNode; active?: string; children: ReactNode }) {
  return (
    <div className="zen-app fw-bg-container fw-text-primary">
      <TopNavigation aria-label="Zen">
        <TopNavigation.Left>
          <a className="zen-brand fw-text-primary" href="index.html" aria-label="Zen home">
            <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden="true" className="fw-text-brand">
              <circle cx="16" cy="16" r="12" fill="none" stroke="currentColor" strokeWidth="5" strokeLinecap="round" strokeDasharray="62 14" transform="rotate(-50 16 16)" />
            </svg>
            <span className="fw-text-lg fw-font-semibold">Zen</span>
            <span className="zen-brand-divider fw-border-default" aria-hidden="true" />
            <span className="fw-text-base fw-text-secondary">Admin</span>
          </a>
        </TopNavigation.Left>
        <TopNavigation.Right
          buttons={<HyperlinkButton href="demo.html">Watch a live session</HyperlinkButton>}
          avatar={<Avatar name="Tanya Goel" initials="TG" size="sm" />}
        />
      </TopNavigation>

      <div className="zen-body">
        <nav className="zen-nav fw-bg-surface fw-border-default" aria-label="Admin Hub">
          <ul>
            {NAV.map((item) => (
              <li key={item.href}>
                <a href={item.href} aria-current={item.href === active ? "page" : undefined}
                  className={"zen-nav-item fw-text-base " + (item.href === active ? "is-active fw-text-brand fw-font-semibold" : "fw-text-secondary")}>
                  <Icon name={item.icon} size="sm" />
                  <span>{item.label}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <main className="zen-main">
          <Breadcrumb items={[{ label: "Admin", href: "dashboard.html" }, { label: title }]} ariaLabel="Breadcrumb" />
          <header className="zen-page-head">
            <div>
              <h1 className="fw-text-2xl fw-font-semibold">{title}</h1>
              <p className="fw-text-base fw-text-secondary">{description}</p>
            </div>
            {actions ? <div className="zen-page-actions">{actions}</div> : null}
          </header>
          {children}
        </main>
      </div>
    </div>
  );
}

/* A page section: title + optional description + content; no card chrome by default. */
export function Section({ title, description, aside, children }: { title: string; description?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="zen-section">
      <div className="zen-section-head">
        <div>
          <h2 className="fw-text-lg fw-font-semibold">{title}</h2>
          {description ? <p className="fw-text-base fw-text-secondary">{description}</p> : null}
        </div>
        {aside}
      </div>
      {children}
    </section>
  );
}
