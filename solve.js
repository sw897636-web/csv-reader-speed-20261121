// A fast drop-in for csv-reader 1.0.0: run(input) returns exactly what
// csv-reader 1.0.0's readCsv returns for {text, header}:
// {columns, rows, errors}, following its broken-row policy literally.
//
// Speed comes from slicing fields instead of building them one character at
// a time: an unquoted field is the slice up to the next comma / LF / EOF
// (found with native indexOf), a quoted field is the slice up to its
// closing quote, and a whole physical line with no quote and no stray CR is
// split in one native call. Slow paths (quoted fields, stray CRs, junk
// after a closing quote, unterminated quotes) run only where the input
// actually needs them, and they follow the reference character for
// character: BOM dropped, CRLF and lone CR inside quotes read as one LF,
// lone CR outside quotes dropped with a stray_cr error, "" inside quotes
// one quote, text after a closing quote appended as it stands (quote_junk),
// a never-closing quote literal with the rest re-read unquoted
// (unterminated_quote), records padded / cut to the first record's width
// (short_row / long_row), empty lines no records. Nothing is kept from one
// call to the next.

const COMMA = 0;
const BREAK = 1;
const END = 2;

// The next comma or LF from a position, in one native scan.
const DELIM = /[,\n]/g;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const n = text.length;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  // The record being read: the line it starts on and its index in rows
  // (null for the header). Every error of the record carries these.
  let recordLine = 1;
  let recordRow = null;

  // Scratch the field readers write: the field's value, how it ended
  // (COMMA / BREAK / END) and how many characters were kept.
  let fVal = '';
  let fEnd = 0;
  let fAdded = 0;

  function pushErr(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // One quoted segment with CRLF and lone CR each read as one LF; counts
  // the line breaks into `line`. Segments without a line break pass through.
  function normSeg(seg) {
    if (seg.indexOf('\n') === -1 && seg.indexOf('\r') === -1) return seg;
    const norm = seg.replace(/\r\n|\r/g, '\n');
    let c = 0;
    for (let i = 0; i < norm.length; i++) if (norm.charCodeAt(i) === 10) c++;
    line += c;
    return norm;
  }

  // Reads unquoted characters onto `init` up to the next comma, line break
  // or the end of the text. A CR not followed by LF is dropped (stray_cr);
  // CRLF ends the field as one line break. Every CR inside the slice is
  // lone: a CR followed by LF would itself be the line break that ends it.
  function readUnquoted(init) {
    let value = init;
    let added = 0;
    DELIM.lastIndex = pos;
    const m = DELIM.exec(text);
    let end;
    let kind;
    if (m === null) { end = n; kind = END; }
    else if (m[0] === ',') { end = m.index; kind = COMMA; }
    else { end = m.index; kind = BREAK; }
    if (kind === BREAK && end > pos && text.charCodeAt(end - 1) === 13) {
      const seg = text.slice(pos, end - 1);
      if (seg.indexOf('\r') === -1) { value += seg; added += seg.length; }
      else {
        const parts = seg.split('\r');
        for (let i = 1; i < parts.length; i++) pushErr('stray_cr');
        const joined = parts.join('');
        value += joined; added += joined.length;
      }
      pos = end + 1;
      line++;
      fVal = value; fEnd = BREAK; fAdded = added;
      return;
    }
    const seg = text.slice(pos, end);
    if (seg.indexOf('\r') === -1) { value += seg; added += seg.length; }
    else {
      const parts = seg.split('\r');
      for (let i = 1; i < parts.length; i++) pushErr('stray_cr');
      const joined = parts.join('');
      value += joined; added += joined.length;
    }
    if (kind === COMMA) { pos = end + 1; fVal = value; fEnd = COMMA; fAdded = added; return; }
    if (kind === BREAK) { pos = end + 1; line++; fVal = value; fEnd = BREAK; fAdded = added; return; }
    pos = n; fVal = value; fEnd = END; fAdded = added;
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let pieces = null;
    let value = '';
    let segStart = pos + 1;
    for (;;) {
      const q = text.indexOf('"', segStart);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        pushErr('unterminated_quote');
        readUnquoted('"');
        return;
      }
      if (q + 1 < n && text.charCodeAt(q + 1) === 34) {
        const seg = normSeg(text.slice(segStart, q));
        if (pieces === null) pieces = [];
        pieces.push(seg);
        pieces.push('"');
        segStart = q + 2;
        continue;
      }
      const seg = normSeg(text.slice(segStart, q));
      if (pieces === null) value = seg;
      else { pieces.push(seg); value = pieces.join(''); }
      pos = q + 1;
      if (pos >= n) { fVal = value; fEnd = END; fAdded = 0; return; }
      const c = text.charCodeAt(pos);
      if (c === 44) { pos++; fVal = value; fEnd = COMMA; fAdded = 0; return; }
      if (c === 10) { pos++; line++; fVal = value; fEnd = BREAK; fAdded = 0; return; }
      if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
        pos += 2; line++; fVal = value; fEnd = BREAK; fAdded = 0; return;
      }
      // What follows the closing quote is appended as it stands, up to the
      // next comma or line break.
      readUnquoted(value);
      if (fAdded > 0) pushErr('quote_junk');
      return;
    }
  }

  while (pos < n) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos++; line++; }
      else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) { pos += 2; line++; }
      else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: this physical line holds no quote and no stray CR, so the
    // whole record is one native split. A quote anywhere in it, or a CR
    // that is not the CRLF at its end, falls through to the slow path.
    let fields;
    let lastQuoted = false;
    const lf = text.indexOf('\n', pos);
    const eol = lf === -1 ? n : lf;
    const seg = text.slice(pos, eol);
    if (seg.indexOf('"') === -1) {
      const ri = seg.indexOf('\r');
      if (ri === -1) {
        fields = seg.split(',');
        pos = lf === -1 ? n : lf + 1;
        if (lf !== -1) line++;
      } else if (ri === seg.length - 1 && lf !== -1) {
        fields = seg.slice(0, -1).split(',');
        pos = lf + 1;
        line++;
      }
    }
    if (fields === undefined) {
      fields = [];
      let endKind;
      do {
        if (text.charCodeAt(pos) === 34) { readQuoted(); lastQuoted = true; }
        else { readUnquoted(''); lastQuoted = false; }
        fields.push(fVal);
        endKind = fEnd;
      } while (endKind === COMMA);
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
