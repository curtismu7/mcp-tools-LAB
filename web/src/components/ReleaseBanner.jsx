import React from "react";
import { BANNER } from "../lib/gateway.js";
import "./ReleaseBanner.css";

// Shown on every tab and in presenter mode (it sits in the shell, outside the page, and nothing hides it). It states the
// claim label and the mode this app is actually in. The feature is simulated in Mock; in Real, the Entitled listing page
// measures the operator's own gateway (MCP_TOOLS_GW_* settings). A hosted MOCK_ONLY copy has no Real.
export default function ReleaseBanner({ config }) {
  const mode = !config ? "checking the mode" : config.mockOnly ? "hosted mock (sample data only)" : "live inspector (connects only to servers you name)";
  return (
    <p className="release-banner" role="note" data-testid="release-banner">
      <span className="release-banner__claim">{BANNER}.</span>{" "}
      The entitled listing and aggregate cap features are simulated in Mock; in Real, the Entitled listing page asks your own gateway{config?.mockOnly ? " (not on this hosted mock copy)" : ""}. Mode: {mode}.
    </p>
  );
}
