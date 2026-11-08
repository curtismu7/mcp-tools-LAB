import React from "react";
import { BANNER } from "../lib/gateway.js";
import "./ReleaseBanner.css";

// Shown on every tab and in presenter mode (it sits in the shell, outside the page, and nothing hides it). It states the
// claim label and what the header's Mock/Real toggle really changes. The release feature is simulated in Mock; in Real,
// the Entitled listing page measures the operator's own gateway (MCP_TOOLS_GW_* settings) and the live proxy offers the
// saved servers. The Connect, Server and Scan pages reach the servers you name in both modes. A hosted MOCK_ONLY copy
// has no Real and reaches nothing.
export const modeText = (config, source) => (!config ? "checking the mode"
  : config.mockOnly ? "hosted mock (sample data only; nothing leaves this server)"
  : source === "real" ? "Real: the live proxy offers your saved servers and the Entitled listing page asks your own gateway; every page connects only to servers you name"
  : "Mock: the live proxy offers only the two built-in sample servers and the Entitled listing is simulated; the Connect, Server and Scan pages still reach any server you name");
export default function ReleaseBanner({ config, source }) {
  const mode = modeText(config, source);
  return (
    <p className="release-banner" role="note" data-testid="release-banner">
      <span className="release-banner__claim">{BANNER}.</span>{" "}
      The entitled listing and aggregate cap features are simulated in Mock; in Real, the Entitled listing page asks your own gateway{config?.mockOnly ? " (not on this hosted mock copy)" : ""}. Mode: {mode}.
    </p>
  );
}
