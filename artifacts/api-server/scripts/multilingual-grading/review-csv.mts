/** Strict UTF-8 CSV adapter, including quoted commas/newlines and CRLF.
 * No evaluation, spreadsheet formulas, or provider access. */
export function parseCsv(input: string): string[][] {
  const text = input.replace(/^\uFEFF/, "");
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    closed = false;
  const field = () => {
    row.push(cell);
    cell = "";
    closed = false;
  };
  const line = () => {
    field();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
        closed = true;
      } else cell += ch;
    } else if (ch === '"' && !cell && !closed) quoted = true;
    else if (ch === ",") field();
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      line();
    } else {
      if (closed || ch === '"') throw new Error("Malformed CSV quoting");
      cell += ch;
    }
  }
  if (quoted) throw new Error("Unterminated CSV field");
  if (cell || row.length || closed) line();
  return rows;
}

export function writeCsv(rows: string[][]): string {
  return (
    rows.map((row) => row.map((s) => `"${s.replace(/"/g, '""')}"`).join(",")).join("\r\n") + "\r\n"
  );
}
