/**
 * [COMP:app-web/focus-treatment] One-frame focus treatment.
 *
 * Text-entry fields turn their existing border blue through the app-wide
 * `:focus-visible` override in `app/globals.css`. Composite fields put that
 * border change on their `focus-within` wrapper and suppress every nested
 * focus shadow. Outside halos stay reserved for discrete keyboard controls.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const SOURCE_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const GLOBALS_CSS = readFileSync(new URL("../../../app/globals.css", import.meta.url), "utf8");

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.isFile() && path.endsWith(".tsx") ? [path] : [];
  });
}

function classAttribute(
  node: ts.JsxOpeningLikeElement,
  sourceFile: ts.SourceFile,
  name = "className",
): string {
  const attr = node.attributes.properties.find(
    (prop): prop is ts.JsxAttribute =>
      ts.isJsxAttribute(prop) && prop.name.getText(sourceFile) === name,
  );
  return attr?.getText(sourceFile) ?? "";
}

function lineOf(node: ts.Node, sourceFile: ts.SourceFile): number {
  return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
}

// This is a whole-app source contract. Build the syntax trees once during test
// collection so each assertion only walks the same snapshot. Parsing every
// `.tsx` file inside each assertion exceeded Vitest's 5s per-test limit on CI.
const appSourceFiles = tsxFiles(SOURCE_ROOT).map((file) => ({
  file,
  sourceFile: ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  ),
}));

describe("[COMP:app-web/focus-treatment] source contract", () => {
  it("turns text-entry borders into the focus frame and suppresses every field halo", () => {
    expect(GLOBALS_CSS).toMatch(
      /:where\([\s\S]*?input\[type="text"\][\s\S]*?textarea[\s\S]*?\):focus-visible\s*\{[\s\S]*?border-color:\s*var\(--ring\)\s*!important;[\s\S]*?box-shadow:\s*none\s*!important;/,
    );
    expect(GLOBALS_CSS).toMatch(
      /:where\([\s\S]*?textarea[\s\S]*?\):focus-visible\[aria-invalid="true"\]\s*\{[\s\S]*?border-color:\s*var\(--destructive\)\s*!important;/,
    );
  });

  it("uses the dock composer border as its only focus frame", () => {
    const floatingChat = appSourceFiles.find(({ file }) =>
      file.endsWith("/components/chrome/floating-chat.tsx"),
    );
    const source = floatingChat?.sourceFile.getFullText();

    expect(source).toMatch(
      /inputWrapClassName="[^"]*focus-within:border-ring[^"]*\[&_:focus-visible\]:shadow-none[^"]*"/,
    );
    expect(source).toMatch(
      /textareaClassName=\{cn\([\s\S]*?focus-visible:shadow-none[\s\S]*?\)\}/,
    );
    expect(source).not.toMatch(
      /textareaClassName=\{cn\([\s\S]*?focus-visible:border-ring[\s\S]*?\)\}/,
    );
    expect(source).not.toMatch(/inputWrapClassName="[^"]*focus-within:ring-/);
  });

  it("uses the existing border on every shared field-like trigger", () => {
    const violations: string[] = [];

    for (const { file, sourceFile } of appSourceFiles) {

      function visit(node: ts.Node) {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const tag = node.tagName.getText(sourceFile);
          const fieldClass = classAttribute(node, sourceFile);
          if (tag === "SelectPrimitive.Trigger" || tag === "Combobox.Trigger") {
            const ownsBorder = fieldClass.includes("focus-visible:border-ring");
            const suppressesHalo = fieldClass.includes("focus-visible:shadow-none");
            const addsFocusRing = /focus-visible:ring-(?!0)/.test(fieldClass);
            const addsOpenRing = /data-\[popup-open\]:ring-(?!0)/.test(fieldClass);
            if (!ownsBorder || !suppressesHalo || addsFocusRing || addsOpenRing) {
              violations.push(`${file}:${lineOf(node, sourceFile)} <${tag}>`);
            }
          }
        }

        ts.forEachChild(node, visit);
      }

      visit(sourceFile);
    }

    expect(violations).toEqual([]);
  });

  it("makes every focus-within frame border-only and suppresses nested halos", () => {
    const violations: string[] = [];

    for (const { file, sourceFile } of appSourceFiles) {

      function visit(node: ts.Node) {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const classes = ["className", "inputWrapClassName"]
            .map((name) => classAttribute(node, sourceFile, name))
            .join(" ");
          if (
            /focus-within:(?:border|ring)-/.test(classes) &&
            (!classes.includes("[&_:focus-visible]:shadow-none") ||
              /focus-within:ring-(?!0)/.test(classes))
          ) {
            violations.push(
              `${file}:${lineOf(node, sourceFile)} <${node.tagName.getText(sourceFile)}>`,
            );
          }
        }
        ts.forEachChild(node, visit);
      }

      visit(sourceFile);
    }

    expect(violations).toEqual([]);
  });
});
