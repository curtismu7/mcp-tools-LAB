import { useEffect, useMemo, useState } from "react";
import { usePresent } from "../present/PresentMode";
import { STORIES, VERTICALS, storyById, verticalById } from "./stories";
import { fillAll } from "./fill";
import "./StoryPanel.css";

// Adapted from the ID-JAG kit (id-jag-standalone web/src/story/StoryPanel.jsx, MIT). The talk track: who the story is about,
// what to say at each step, and what proves it. Reads one story file and re-skins it with the chosen vertical pack. The
// path switch (named by the story) shows each step's alternative wording where it has any.

const KEYS = { vertical: "mcptools.story.vertical", path: "mcptools.story.path", story: "mcptools.story.id" };
const read = (k, fallback) => { try { return localStorage.getItem(k) ?? fallback; } catch { return fallback; } };
const write = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked: not remembered */ } };

export default function StoryPanel() {
  const [storyId, setStoryId] = useState(() => storyById(read(KEYS.story, null)).id);
  const [verticalId, setVerticalId] = useState(() => read(KEYS.vertical, "generic"));
  const [alt, setAlt] = useState(() => read(KEYS.path, "main") === "alt");
  const [localActive, setLocalActive] = useState(null);
  const presenter = usePresent();

  const vertical = verticalById(verticalId);
  const story = useMemo(() => fillAll(storyById(storyId), vertical), [storyId, vertical]);
  const setSteps = presenter?.setSteps;
  useEffect(() => { setSteps?.(story.steps.map((s) => ({ n: s.n, title: s.title }))); }, [story, setSteps]);

  const active = presenter ? presenter.active : localActive;
  const current = story.steps.find((s) => s.n === active) || story.steps[0];
  const text = (step) => (alt && step.alt ? step.alt : step);
  const pickStep = (n) => (presenter ? presenter.goTo(n) : setLocalActive(n));

  return (
    <section className="story" aria-label="Talk track" data-testid="story-panel">
      <header className="story__head">
        <div>
          <p className="story__eyebrow">Story {story.id} · {vertical.displayName}</p>
          <h2 className="story__title">{story.title}</h2>
        </div>
      </header>
      <div className="story__controls">
        <label className="story__field">Story
          <select value={story.id} onChange={(e) => { setStoryId(e.target.value); setLocalActive(null); write(KEYS.story, e.target.value); }}>
            {STORIES.map((s) => <option key={s.id} value={s.id}>{s.id}: {fillAll(s.title, vertical)}</option>)}
          </select>
        </label>
        <label className="story__field">Vertical
          <select value={vertical.id} onChange={(e) => { setVerticalId(e.target.value); write(KEYS.vertical, e.target.value); }}>
            {VERTICALS.map((v) => <option key={v.id} value={v.id}>{v.displayName}</option>)}
          </select>
        </label>
        <div className="seg" role="group" aria-label="Story path">
          <button type="button" className="btn" aria-pressed={!alt} onClick={() => { setAlt(false); write(KEYS.path, "main"); }}>{story.paths.main}</button>
          <button type="button" className="btn" aria-pressed={alt} onClick={() => { setAlt(true); write(KEYS.path, "alt"); }}>{story.paths.alt}</button>
        </div>
      </div>
      <dl className="story__summary">
        <dt>Goal</dt><dd>{story.goal}</dd>
        <dt>Obstacle</dt><dd>{story.obstacle}</dd>
        <dt>Control</dt><dd>{story.control}</dd>
      </dl>
      <ol className="story__steps">
        {story.steps.map((s) => (
          <li key={s.n} className={s.n === current.n ? "is-current" : undefined}>
            <button type="button" className="story__step" aria-current={s.n === current.n ? "step" : undefined} onClick={() => pickStep(s.n)}>
              <span className="story__n">{s.n}</span>{s.title}
              {alt && s.alt && <span className="story__tag">{story.paths.alt}</span>}
            </button>
            {s.n === current.n && (
              <div className="story__body">
                <p>{text(s).tell}</p>
                <p className="story__say"><strong>Say:</strong> “{text(s).say}”</p>
                <p className="story__why"><strong>Why it matters:</strong> {s.why}</p>
              </div>
            )}
          </li>
        ))}
      </ol>
      <p className="story__proof"><strong>Proof:</strong> {alt ? story.proof.alt : story.proof.main}</p>
      <p className="story__takeaway">“{story.say}”</p>
    </section>
  );
}
