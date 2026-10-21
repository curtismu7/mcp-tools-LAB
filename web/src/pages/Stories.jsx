import React from "react";
import StoryPanel from "../story/StoryPanel.jsx";

export default function Stories() {
  return (
    <>
      <h2>Stories</h2>
      <p className="lede">A talk track for each demo: what to say at each step and what proves it. Pick a story, a vertical and a path. Presenter mode (the Present button, or the p key) enlarges the text and steps with the arrow keys.</p>
      <StoryPanel />
    </>
  );
}
