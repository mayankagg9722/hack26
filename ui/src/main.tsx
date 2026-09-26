import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ToastMessagesProvider } from "@freshworks/dew-components";

// Dew design tokens (colors, spacing, radius, typography) + component styles
import "@freshworks/dew-styles/colors.css";
import "@freshworks/dew-styles/numbers.css";
import "@freshworks/dew-styles/fonts.css";
import "@freshworks/dew-components/assets/dew-cmp-reset.css";
import "@freshworks/dew-components/assets/dew-cmp-lib.css";
import "./app.css";

import { Shell } from "./Shell";
import { CustomerMigrationSection } from "./CustomerMigration";
import { ConnectedSystemsSection } from "./ConnectedSystems";

function IntegrationsPage() {
  return (
    <Shell title="Integrations" description="Connect Jira Service Management and Freshservice, then let Zen migrate your data. Zen handles the API work behind the scenes.">
      <CustomerMigrationSection />
      <ConnectedSystemsSection />
    </Shell>
  );
}

const root = document.getElementById("zen-integrations");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ToastMessagesProvider>
        <IntegrationsPage />
      </ToastMessagesProvider>
    </StrictMode>,
  );
}
