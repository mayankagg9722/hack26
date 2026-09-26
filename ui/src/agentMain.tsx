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
import { AgentPage } from "./Agent";

const root = document.getElementById("zen-agent");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <ToastMessagesProvider>
        <Shell title="Migration agent" active="agent.html"
          description="Zen discovers what Jira Service Management and Freshservice hold, maps one onto the other, migrates customers and tickets, fixes what is safe to fix, asks you about the rest, and explains the result.">
          <AgentPage />
        </Shell>
      </ToastMessagesProvider>
    </StrictMode>,
  );
}
