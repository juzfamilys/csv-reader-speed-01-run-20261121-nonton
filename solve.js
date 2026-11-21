// A faster drop-in for csv-reader 1.0.0.
//
// run(input) returns, for one case's input {text, header}, exactly the answer
// csv-reader 1.0.0 returns: {columns, rows, errors}. The text is read once,
// left to right, with commas and double quotes:
//
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF, and a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (error stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled, "" inside it one quote and each CRLF or lone CR inside it read
//     as LF; what follows its closing quote, up to the next comma or line
//     break, is appended as it stands (quote_junk, when the field ends); a
//     quote that never closes is a literal character, and the text after it is
//     read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character; fields stay
//     strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it (every record when header is false), each padded
//     with "" (short_row, with fields: its field count) or cut (long_row, with
//     extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}, in the order met: line the 1-based line
//     its record starts on, counting every LF, CRLF and lone CR inside quotes,
//     and row its record's index in rows, null for the header.
//
// Speed: csv-reader builds every field one character at a time. This reader
// instead takes the common record whole — a clean record (no quote, no stray
// CR) is split by String.split, which runs in native code — and only falls
// back to field-by-field reading for records that hold a quote or a stray CR.
// Inside those, every field is still found with indexOf over a bounded slice,
// never a character at a time, and a quoted field's value is a slice unless
// it holds a doubled quote or a line break. No dependency, no state kept
// between calls.

/** How a field ended: at a comma (the record goes on), at a line break or at the end of the text. */
const COMMA = 0;
const BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const len = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;
  if (len > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  // Reads an unquoted field from `pos`, starting with `init` already in the
  // value, and returns {value, ended, added}: `ended` is COMMA, BREAK or END,
  // and `added` counts the characters kept after `init`. A CR not followed by
  // LF is dropped (stray_cr); a CR followed by LF ends the field as a line
  // break. Every scan is bounded by the field's own end.
  function readUnq(init) {
    let value = init;
    let added = 0;
    let p = pos;
    for (;;) {
      let c = text.indexOf(',', p);
      if (c === -1) c = len;
      let n = text.indexOf('\n', p);
      if (n === -1) n = len;
      const m = c < n ? c : n;
      const seg = text.slice(p, m);
      const ri = seg.indexOf('\r');
      if (ri === -1) {
        if (seg.length !== 0) {
          value += seg;
          added += seg.length;
        }
        if (m >= len) {
          pos = len;
          return { value, ended: END, added };
        }
        if (m === c) {
          pos = m + 1;
          return { value, ended: COMMA, added };
        }
        pos = m + 1;
        line += 1;
        return { value, ended: BREAK, added };
      }
      if (ri === seg.length - 1 && m < len && text.charCodeAt(m) === 10) {
        // The CR is the first half of a CRLF line break.
        if (ri !== 0) {
          value += seg.slice(0, ri);
          added += ri;
        }
        pos = m + 1;
        line += 1;
        return { value, ended: BREAK, added };
      }
      // A stray CR: drop it, keep reading after it.
      if (ri !== 0) {
        value += seg.slice(0, ri);
        added += ri;
      }
      errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      p = p + ri + 1;
    }
  }

  // The value of a quoted field from its raw inner text `seg` (the characters
  // between the opening quote and the closing quote): "" inside it is one
  // quote, and each CRLF or lone CR inside it is read as LF. Every quote in
  // `seg` is doubled by construction, so a quote here always takes two.
  function quotedValue(seg) {
    let value = '';
    let p = 0;
    const L = seg.length;
    while (p < L) {
      let a = seg.indexOf('"', p);
      if (a === -1) a = L;
      let b = seg.indexOf('\r', p);
      if (b === -1) b = L;
      let c = seg.indexOf('\n', p);
      if (c === -1) c = L;
      const m = a < b ? (a < c ? a : c) : (b < c ? b : c);
      if (m >= L) {
        value += seg.slice(p, L);
        break;
      }
      if (m > p) value += seg.slice(p, m);
      if (m === a) {
        value += '"';
        p = m + 2;
      } else if (m === b) {
        value += '\n';
        line += 1;
        p = seg.charCodeAt(m + 1) === 10 ? m + 2 : m + 1;
      } else {
        value += '\n';
        line += 1;
        p = m + 1;
      }
    }
    return value;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // The record ends at the next LF (or at the end of the text); a CRLF's CR
    // is not part of its content.
    const nl = text.indexOf('\n', pos);
    const recEnd = nl === -1 ? len : nl;
    let contentEnd = recEnd;
    if (nl !== -1 && recEnd > pos && text.charCodeAt(recEnd - 1) === 13) contentEnd = recEnd - 1;
    const rec = text.slice(pos, contentEnd);

    let fields;
    let lastQuoted = false;
    if (rec.indexOf('"') === -1 && rec.indexOf('\r') === -1) {
      // A clean record: no quote, no stray CR. Split it whole in native code.
      fields = rec.split(',');
      pos = nl === -1 ? len : nl + 1;
      if (nl !== -1) line += 1;
    } else {
      // A record that holds a quote or a stray CR: read it field by field.
      fields = [];
      let ended = END;
      for (;;) {
        if (text.charCodeAt(pos) === 34) {
          lastQuoted = true;
          const open = pos;
          const openLine = line;
          // The closing quote is the first quote not followed by another quote.
          let scan = pos + 1;
          let close = -1;
          let doubled = false;
          for (;;) {
            const q = text.indexOf('"', scan);
            if (q === -1) break;
            if (text.charCodeAt(q + 1) === 34) {
              doubled = true;
              scan = q + 2;
              continue;
            }
            close = q;
            break;
          }
          if (close === -1) {
            // The quote never closes: it is a literal character, and the text
            // after it is read again as unquoted.
            errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
            pos = open + 1;
            line = openLine;
            const f = readUnq('"');
            fields.push(f.value);
            ended = f.ended;
          } else {
            const seg = text.slice(open + 1, close);
            let value;
            if (!doubled && seg.indexOf('\r') === -1 && seg.indexOf('\n') === -1) {
              // A plain quoted field: its value is the slice as it stands.
              value = seg;
            } else {
              value = quotedValue(seg);
            }
            pos = close + 1;
            if (pos >= len) {
              ended = END;
            } else {
              const cc = text.charCodeAt(pos);
              if (cc === 44) {
                pos += 1;
                ended = COMMA;
              } else if (cc === 10) {
                pos += 1;
                line += 1;
                ended = BREAK;
              } else if (cc === 13 && text.charCodeAt(pos + 1) === 10) {
                pos += 2;
                line += 1;
                ended = BREAK;
              } else {
                // What follows the closing quote is appended as it stands,
                // up to the next comma or line break.
                const f = readUnq(value);
                if (f.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
                value = f.value;
                ended = f.ended;
              }
            }
            fields.push(value);
          }
        } else {
          lastQuoted = false;
          // An unquoted field: it ends at the next comma or line break.
          let c = text.indexOf(',', pos);
          if (c === -1) c = len;
          let n = text.indexOf('\n', pos);
          if (n === -1) n = len;
          const m = c < n ? c : n;
          const seg = text.slice(pos, m);
          const ri = seg.indexOf('\r');
          if (ri === -1) {
            fields.push(seg);
            if (m >= len) {
              pos = len;
              ended = END;
            } else if (m === c) {
              pos = m + 1;
              ended = COMMA;
            } else {
              pos = m + 1;
              line += 1;
              ended = BREAK;
            }
          } else if (ri === seg.length - 1 && m < len && text.charCodeAt(m) === 10) {
            // The CR is the first half of a CRLF line break.
            fields.push(seg.slice(0, ri));
            pos = m + 1;
            line += 1;
            ended = BREAK;
          } else {
            // A stray CR sits inside the field: read it the slow way.
            const f = readUnq('');
            fields.push(f.value);
            ended = f.ended;
          }
        }
        if (ended !== COMMA) break;
      }
    }

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
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
