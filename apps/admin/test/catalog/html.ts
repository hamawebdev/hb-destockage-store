// Accessibility invariants for pages with repeated cards/rows (offered to admin-core for its screens):
//  - no id appears twice on the page;
//  - every <label for> points at an element that exists;
//  - inside each card (matched by `card`), every label's `for` points at a control in that same card.
// Returns the problems found (empty = fine), so a failing test prints all of them at once.
export function idAndLabelProblems(html: string, card?: RegExp): string[] {
  const problems: string[] = [];
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] as string);
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) problems.push(`duplicate id "${id}"`);
    seen.add(id);
  }
  for (const m of html.matchAll(/<label[^>]*\sfor="([^"]+)"/g)) {
    if (!seen.has(m[1] as string)) problems.push(`label for="${m[1]}" points at nothing`);
  }
  if (card) {
    const flags = card.flags.includes('g') ? card.flags : `${card.flags}g`;
    let n = 0;
    for (const chunk of html.matchAll(new RegExp(card.source, flags))) {
      n++;
      const inside = new Set([...chunk[0].matchAll(/\sid="([^"]+)"/g)].map((m) => m[1] as string));
      for (const l of chunk[0].matchAll(/<label[^>]*\sfor="([^"]+)"/g)) {
        if (!inside.has(l[1] as string)) problems.push(`card ${n}: label for="${l[1]}" points outside its card`);
      }
    }
    if (n === 0) problems.push('no card matched the card pattern');
  }
  return problems;
}
