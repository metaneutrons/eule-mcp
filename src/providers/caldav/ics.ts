//! Shared iCalendar helpers for the CalDAV connectors (VEVENT and VTODO).

/**
 * Undoes RFC 5545 line folding: a CRLF followed by a space or tab continues the
 * previous content line. Without this a long SUMMARY or DESCRIPTION is silently
 * truncated at the fold, which servers insert at 75 octets.
 */
export function unfold(ics: string): string {
  return ics.replace(/\r?\n[ \t]/g, "");
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
        // Properties the component did not have yet are appended before its END.
        for (const [name, value] of remaining) {
          const written = contentLine(name, value);
          if (written !== undefined) out.push(written);
        }
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
      const written = contentLine(name, value, keepParams.has(name) ? line : undefined);
      if (written !== undefined) out.push(written);
      // Drop the folded continuation lines of the property we just replaced.
      while (i + 1 < lines.length && /^[ \t]/.test(lines[i + 1] ?? "")) i++;
    } else {
      out.push(line);
    }
  }
  return out.join("\r\n");
}

/**
 * Renders one content line for an edit, or undefined when the edit removes the
 * property.
 *
 * `existing` is the line being replaced, passed only when its parameters should
 * survive. An edit value starting with `;` always supplies its own parameters
 * and therefore wins over the existing ones.
 */
function contentLine(name: string, value: string | null, existing?: string): string | undefined {
  if (value === null) return undefined;
  if (value.startsWith(";")) return `${name}${value}`;
  if (existing !== undefined) {
    const colon = existing.indexOf(":");
    const semi = existing.indexOf(";");
    if (semi >= 0 && semi < colon) return `${existing.slice(0, colon)}:${value}`;
  }
  return `${name}:${value}`;
}
