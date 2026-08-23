//! Shared iCalendar helpers for the CalDAV connectors (VEVENT and VTODO).

/**
 * Undoes RFC 5545 line folding: a CRLF followed by a space or tab continues the
 * previous content line. Without this a long SUMMARY or DESCRIPTION is silently
 * truncated at the fold, which servers insert at 75 octets.
 */
export function unfold(ics: string): string {
  return ics.replace(/\r?\n[ \t]/g, "");
}

/**
 * Reads the first value of `key` anywhere in the object, ignoring parameters.
 *
 * Component-agnostic on purpose, for values that exist once per object (UID).
 * For anything a nested component can also carry (SUMMARY, DESCRIPTION) use
 * {@link readComponentProp} instead, or an alarm's text can be returned as the
 * event's.
 */
export function icalValue(data: string, key: string): string {
  // Keys are internal constants, never user input, but escaping keeps the
  // constructed pattern honest if that ever changes.
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`^${escaped}[^:\\r\\n]*:(.*)$`, "im");
  return re.exec(unfold(data))?.[1]?.trim() ?? "";
}

/** 20260410T140000Z → 2026-04-10T14:00:00Z (dates shorter than that pass through). */
export function icalToIso(dt: string): string {
  if (dt.length === 8) return `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`;
  if (dt.length < 15) return dt;
  return `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}T${dt.slice(9, 11)}:${dt.slice(11, 13)}:${dt.slice(13, 15)}${dt.endsWith("Z") ? "Z" : ""}`;
}

export function isoToIcal(iso: string): string {
  return iso.replace(/[-:]/g, "").split(".")[0] ?? iso;
}

/** Property name at the start of an (unfolded) iCal content line, uppercased. */
export function propName(line: string): string {
  return /^([A-Za-z0-9-]+)/.exec(line)?.[1]?.toUpperCase() ?? "";
}

/**
 * Reads the first value of `name` at the top level of `component`, or "" if
 * absent. Nested components (a VALARM inside a VEVENT) are skipped, so this
 * never returns an alarm's SUMMARY for the event's.
 */
export function readComponentProp(ics: string, component: string, name: string): string {
  const target = name.toUpperCase();
  const wanted = component.toUpperCase();
  const stack: string[] = [];
  // Unfold first, so a value split across continuation lines is returned whole
  // rather than truncated at the fold.
  for (const line of unfold(ics).split(/\r?\n/)) {
    const u = line.toUpperCase();
    if (u.startsWith("BEGIN:")) stack.push(u.slice(6).trim());
    else if (u.startsWith("END:")) stack.pop();
    else if (stack[stack.length - 1] === wanted && propName(line) === target)
      return line.slice(line.indexOf(":") + 1).trim();
  }
  return "";
}

/**
 * Rewrites the given properties of `component` in an iCalendar object *in
 * place*, preserving every untouched property (DESCRIPTION, ATTENDEE, RRULE,
 * VALARM, VALUE=DATE flags, …) byte-for-byte. Properties that are absent are
 * appended before the component's END line. A `null` edit removes the property.
 *
 * Edits are scoped to the named component only, so a nested VALARM's
 * SUMMARY/DESCRIPTION and a VTIMEZONE's DTSTART are never touched.
 *
 * `keepParams` names properties whose existing parameters should survive
 * (e.g. `SUMMARY;LANGUAGE=de`). Everything else is replaced wholesale, so a
 * fresh UTC value cannot collide with a leftover `;TZID=` parameter.
 *
 * An edit value starting with `;` carries its own parameters and is written as
 * `NAME;params:value`, which is how a date-only `DUE;VALUE=DATE:20260501` is
 * produced. Such a value always replaces the old parameters.
 */
export function applyComponentUpdates(
  ics: string,
  component: string,
  edits: ReadonlyMap<string, string | null>,
  keepParams: ReadonlySet<string> = new Set(),
): string {
  const wanted = component.toUpperCase();
  const lines = ics.split(/\r?\n/);
  const remaining = new Map(edits);
  const stack: string[] = [];
  const out: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const u = line.toUpperCase();

    if (u.startsWith("BEGIN:")) {
      stack.push(u.slice(6).trim());
      out.push(line);
    } else if (u.startsWith("END:")) {
      if (u.slice(4).trim() === wanted && remaining.size) {
        for (const [name, value] of remaining)
          if (value !== null)
            out.push(value.startsWith(";") ? `${name}${value}` : `${name}:${value}`);
        remaining.clear();
      }
      stack.pop();
      out.push(line);
    } else if (/^[ \t]/.test(line)) {
      out.push(line); // folded continuation of the previous property
    } else if (stack[stack.length - 1] === wanted && remaining.has(propName(line))) {
      const name = propName(line);
      const value = remaining.get(name) ?? null;
      remaining.delete(name);
      if (value !== null) {
        const colon = line.indexOf(":");
        const semi = line.indexOf(";");
        if (value.startsWith(";")) {
          out.push(`${name}${value}`); // edit supplies its own parameters
        } else if (keepParams.has(name) && semi >= 0 && semi < colon) {
          out.push(`${line.slice(0, colon)}:${value}`); // NAME;params:value
        } else {
          out.push(`${name}:${value}`);
        }
      }
      // Drop the folded continuation lines of the property we just replaced.
      while (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1] ?? "")) i++;
    } else {
      out.push(line);
    }
  }
  return out.join("\r\n");
}
