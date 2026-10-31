import React from "react";
import { BANNER } from "../lib/gateway.js";
import "./ReleaseBanner.css";

// Shown on every tab and in presenter mode (it sits in the shell, outside the page, and nothing hides it). It states the
// claim label and the mode this app is actually in. This app has no Mock/Live switch: it is the live inspector by
// default, or the hosted mock when the server runs with MOCK_ONLY. The new feature has no live path in either.
export default function ReleaseBanner({ config }) {
  const mode = !config ? "checking the mode" : config.mockOnly ? "hosted mock (sample data only)" : "live inspector (connects only to servers you name)";
  return (
    <p className="release-banner" role="note" data-testid="release-banner">
      <span className="release-banner__claim">{BANNER}.</span>{" "}
      The entitled listing and aggregate cap features are simulated in this process; there is no live path for them until the release is on our tenant. Mode: {mode}.
    </p>
  );
}
