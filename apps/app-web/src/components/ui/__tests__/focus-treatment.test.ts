/**
 * [COMP:app-web/focus-treatment] One-frame focus treatment.
 *
 * Standalone fields inherit the app-wide `:focus-visible` halo from
 * `app/globals.css`; they must not add a focused border unless they explicitly
 * opt out of that halo. Composite fields put the halo on their `focus-within`
 * wrapper and suppress every nested focus shadow.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";

const SOURCE_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

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

describe("[COMP:app-web/focus-treatment] source contract", () => {
  it("keeps standalone fields on one focus treatment", () => {
    const violations: string[] = [];

    for (const file of tsxFiles(SOURCE_ROOT)) {
      const source = readFileSync(file, "utf8");
      const sourceFile = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );

      function visit(node: ts.Node) {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const tag = node.tagName.getText(sourceFile);
          const fieldClass = classAttribute(node, sourceFile);
          const delegatedFieldClass = ["textareaClassName", "inputClassName", "fieldClass"]
            .map((name) => classAttribute(node, sourceFile, name))
            .join(" ");
          const classes = `${fieldClass} ${delegatedFieldClass}`;
          const nativeField = tag === "input" || tag === "textarea";
          const focusedBorder = /focus(?:-visible)?:border-/.test(classes);
          const haloOptOut = /focus-visible:shadow-none|focus-visible:ring-0/.test(classes);

          if (nativeField && focusedBorder && !haloOptOut) {
            violations.push(`${file}:${lineOf(node, sourceFile)} <${tag}>`);
          }

          if (
            (tag === "SelectPrimitive.Trigger" || tag === "Combobox.Trigger") &&
            focusedBorder &&
            /focus(?:-visible)?:ring-(?!0)/.test(classes)
          ) {
            violations.push(`${file}:${lineOf(node, sourceFile)} <${tag}>`);
          }
        }

        if (
          ts.isVariableDeclaration(node) &&
          ts.isIdentifier(node.name) &&
          /input|textarea|field/i.test(node.name.text) &&
          node.initializer
        ) {
          const classes = node.initializer.getText(sourceFile);
          if (
            /focus(?:-visible)?:border-/.test(classes) &&
            !/focus-visible:shadow-none|focus-visible:ring-0/.test(classes)
          ) {
            violations.push(`${file}:${lineOf(node, sourceFile)} ${node.name.text}`);
          }
        }

        ts.forEachChild(node, visit);
      }

      visit(sourceFile);
    }

    expect(violations).toEqual([]);
  });

  it("makes every focus-within frame suppress nested halos", () => {
    const violations: string[] = [];

    for (const file of tsxFiles(SOURCE_ROOT)) {
      const source = readFileSync(file, "utf8");
      const sourceFile = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX,
      );

      function visit(node: ts.Node) {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const classes = classAttribute(node, sourceFile);
          if (
            /focus-within:(?:border|ring)-/.test(classes) &&
            !classes.includes("[&_:focus-visible]:shadow-none")
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
