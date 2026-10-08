// Minimal parser for the OpenStep/ASCII property list format used by Xcode project.pbxproj files.
// Supports: // and /* */ comments, quoted and bare strings, { key = value; } dictionaries, ( a, b, ) arrays.
// Duplicate dictionary keys are an error (a duplicated object id would corrupt an Xcode project).

export function parseOpenStep(text) {
  let index = 0;
  const fail = (message) => {
    const line = text.slice(0, index).split("\n").length;
    throw new Error(`pbxproj parse error at line ${line}: ${message}`);
  };

  function skip() {
    for (;;) {
      while (index < text.length && /\s/.test(text[index])) index += 1;
      if (text.startsWith("//", index)) { while (index < text.length && text[index] !== "\n") index += 1; continue; }
      if (text.startsWith("/*", index)) {
        const end = text.indexOf("*/", index + 2);
        if (end < 0) fail("unterminated comment");
        index = end + 2;
        continue;
      }
      return;
    }
  }

  function parseString() {
    if (text[index] === '"') {
      index += 1;
      let out = "";
      while (index < text.length && text[index] !== '"') {
        if (text[index] === "\\") {
          index += 1;
          const escaped = text[index];
          out += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped;
        } else {
          out += text[index];
        }
        index += 1;
      }
      if (text[index] !== '"') fail("unterminated string");
      index += 1;
      return out;
    }
    const start = index;
    while (index < text.length && /[A-Za-z0-9_$/.:\-+*@<>]/.test(text[index])) index += 1;
    if (start === index) fail(`unexpected character "${text[index]}"`);
    return text.slice(start, index);
  }

  function parseValue() {
    skip();
    if (text[index] === "{") return parseDict();
    if (text[index] === "(") return parseArray();
    return parseString();
  }

  function parseDict() {
    index += 1;
    const dict = Object.create(null);
    for (;;) {
      skip();
      if (text[index] === "}") { index += 1; return dict; }
      const key = parseString();
      skip();
      if (text[index] !== "=") fail(`expected "=" after key ${key}`);
      index += 1;
      const value = parseValue();
      skip();
      if (text[index] !== ";") fail(`expected ";" after value of ${key}`);
      index += 1;
      if (key in dict) fail(`duplicate key ${key}`);
      dict[key] = value;
    }
  }

  function parseArray() {
    index += 1;
    const items = [];
    for (;;) {
      skip();
      if (text[index] === ")") { index += 1; return items; }
      items.push(parseValue());
      skip();
      if (text[index] === ",") index += 1;
      else if (text[index] !== ")") fail('expected "," or ")" in array');
    }
  }

  const root = parseValue();
  skip();
  if (index < text.length) fail("trailing content");
  return root;
}
