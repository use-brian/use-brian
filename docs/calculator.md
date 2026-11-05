# Built-in arithmetic calculator

`calculate` is registered unconditionally by `createBaseTools`. Like `getTime`,
its description tells the assistant to call it for every relevant question
rather than answer from memory. This improves arithmetic reliability when the
model uses the tool; it does not force tool use or guarantee that the model
translates a word problem correctly or copies the result correctly.

No API key, sandbox, computer capability, workspace, or paid plan is required
by this tool. It is read-only, concurrency-safe, and performs no I/O.

## Input and result

Input: `{ "expression": "200 * 15 / 100" }`

Result data:
`{ "expression": "200 * 15 / 100", "result": "30", "precision": 40 }`

The result is a string to preserve decimal precision (including integers above
JavaScript's safe-integer range). Arithmetic uses `decimal.js` with 40
significant digits and half-up rounding per operation, not binary floating
point. Repeating fractions and results requiring more precision are approximate;
this is not symbolic algebra or an exact accounting ledger.

Supported syntax:
- Decimal and scientific numbers: `12`, `.5`, `1.2e-3`.
- `+`, `-`, `*`, `/`, unary signs, and parentheses.
- `^` for integer powers from -1000 to 1000, right-associative.
  `2^3^2` is `512`; `-2^2` is `-4`; `(-2)^2` is `4`.
- ASCII spaces, tabs, carriage returns, and newlines between tokens.

Express percentages using `/100`. Functions, variables, units, thousands
separators, implicit multiplication, `%`, and JavaScript syntax are not
supported. The execution boundary checks the type, length, and an ASCII
character allowlist before parsing, even when called without schema validation.
Invalid input is rejected, never coerced, stripped, or Unicode-normalized.
A restricted parser consumes the entire input; it never uses `eval`, `Function`,
a JavaScript VM, or dynamic property lookup. Only validated numeric literals
reach `decimal.js`; input cannot request function calls, imports, or globals.

Inputs are limited to 2048 characters and 64 recursive nesting levels. Each
nonzero literal and intermediate result must have a decimal exponent between
-1000 and 1000. Invalid syntax, division by zero, unsupported powers, and
resource-limit violations return a tool error rather than a numeric answer.
