import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageContent } from "../src/components/chat/MessageContent";

test("la propuesta de OC se muestra como tabla y el contenido no se interpreta como HTML", () => {
  const content = [
    "Revisión de SOL-2026-004.",
    "| Campo SAP | Valor propuesto |",
    "| --- | --- |",
    "| Total | 25000000 COP |",
    "| Observación | <script>alert(1)</script> |",
    "¿Confirmas explícitamente su creación?",
  ].join("\n");
  const html = renderToStaticMarkup(createElement(MessageContent, { content }));

  assert.match(html, /<table class=\"data-table\">/);
  assert.match(html, /<td[^>]*>25000000 COP<\/td>/);
  assert.match(html, /¿Confirmas explícitamente su creación\?/);
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
});
