import React, { useMemo } from "react";
import { Untrusted } from "../lib/Untrusted.jsx";
import { sourceLabel } from "../lib/suggest.js";

// A form from a tool's inputSchema. The schema is untrusted text: names and descriptions are rendered as text only, and a
// schema `default` is NEVER filled in (an off-box default is the classic exfil sink); it is shown beside the field and
// the field is left empty, so only what the operator types is sent.
const MAX_FIELDS = 40;
const typeOf = (p) => (Array.isArray(p?.type) ? p.type.find((t) => t !== "null") : p?.type);

export function fieldsOf(schema) {
  const props = schema && typeof schema === "object" && schema.properties && typeof schema.properties === "object" ? schema.properties : null;
  if (!props) return null;
  const required = Array.isArray(schema.required) ? schema.required : [];
  return Object.entries(props).slice(0, MAX_FIELDS).map(([name, p]) => ({ name, p: p && typeof p === "object" ? p : {}, required: required.includes(name) }));
}

/** The inverse of buildArgs, for a saved input: form values from arguments, plus the argument names the form has no field for. */
export function valuesFrom(fields, args) {
  const values = {};
  const known = new Set(fields.map((f) => f.name));
  for (const { name, p } of fields) {
    if (!Object.hasOwn(args, name)) continue;
    const v = args[name];
    const t = typeOf(p);
    values[name] = t === "boolean" ? v === true : v !== null && typeof v === "object" ? JSON.stringify(v) : String(v);
  }
  return { values, extra: Object.keys(args).filter((k) => !known.has(k)) };
}

/** values: {name: string|boolean}. Returns {args, errors}: empty optional fields are left out; bad numbers or JSON are errors. */
export function buildArgs(fields, values) {
  const args = {};
  const errors = [];
  for (const { name, p, required } of fields) {
    const v = values[name];
    const t = typeOf(p);
    if (t === "boolean") { if (v !== undefined) args[name] = v === true; else if (required) errors.push(`${name} is required`); continue; }
    if (v === undefined || v === "") { if (required) errors.push(`${name} is required`); continue; }
    if (t === "number" || t === "integer") {
      const n = Number(v);
      if (!Number.isFinite(n) || (t === "integer" && !Number.isInteger(n))) errors.push(`${name} must be ${t === "integer" ? "a whole number" : "a number"}`); else args[name] = n;
    } else if (t === "object" || t === "array" || t === undefined && !p.enum && typeof v === "string" && /^[[{]/.test(v.trim())) {
      try { args[name] = JSON.parse(v); } catch { errors.push(`${name} must be valid JSON`); }
    } else args[name] = v;
  }
  return { args, errors };
}

// `from`: {field: source} for values the tool filled in for the person (each says where it came from and stays editable);
// `extra(name)`: optional node shown under a field (the Pick button and its choices).
export default function SchemaForm({ schema, values, onChange, rawText, onRawText, from = {}, extra }) {
  const fields = useMemo(() => fieldsOf(schema), [schema]);
  if (!fields) {
    return (
      <label className="fields">Arguments (JSON object)
        <textarea rows={4} value={rawText} onChange={(e) => onRawText(e.target.value)} spellCheck={false} />
      </label>
    );
  }
  if (fields.length === 0) return <p className="muted small">This tool takes no arguments.</p>;
  return (
    <div className="fields">
      {fields.map(({ name, p, required }) => {
        const note = from[name] ? <span className="small muted filled-note" data-testid={`filled-${name}`}> filled in for you: {sourceLabel[from[name]]}. Change it if it is not right.</span> : null;
        const more = extra ? extra(name) : null;
        const t = typeOf(p);
        const id = `arg-${name.replace(/[^\w-]/g, "_")}`;
        const hint = p.default !== undefined && from[name] !== "schema" ? <span className="small muted"> (schema default <code><Untrusted text={JSON.stringify(p.default)} /></code> is not filled in)</span> : null;
        const label = <><Untrusted text={name} />{required ? " (required)" : ""}{typeof p.description === "string" && <span className="small muted"> <Untrusted text={p.description} /></span>}{hint}</>;
        if (t === "boolean") {
          return <React.Fragment key={name}><label htmlFor={id} className="check"><input id={id} type="checkbox" checked={values[name] === true} onChange={(e) => onChange(name, e.target.checked)} />{label}{note}</label>{more}</React.Fragment>;
        }
        if (Array.isArray(p.enum)) {
          return (
            <React.Fragment key={name}><label htmlFor={id}>{label}{note}
              <select id={id} value={values[name] ?? ""} onChange={(e) => onChange(name, e.target.value)}>
                <option value="">(not set)</option>
                {p.enum.slice(0, 100).map((o, i) => <option key={i} value={String(o)}>{String(o)}</option>)}
              </select>
            </label>{more}</React.Fragment>
          );
        }
        if (t === "object" || t === "array") {
          return <React.Fragment key={name}><label htmlFor={id}>{label}{note} (JSON)<textarea id={id} rows={3} spellCheck={false} value={values[name] ?? ""} onChange={(e) => onChange(name, e.target.value)} /></label>{more}</React.Fragment>;
        }
        return <React.Fragment key={name}><label htmlFor={id}>{label}{note}<input id={id} type={t === "number" || t === "integer" ? "number" : "text"} step={t === "integer" ? 1 : "any"} autoComplete="off" value={values[name] ?? ""} onChange={(e) => onChange(name, e.target.value)} /></label>{more}</React.Fragment>;
      })}
    </div>
  );
}
