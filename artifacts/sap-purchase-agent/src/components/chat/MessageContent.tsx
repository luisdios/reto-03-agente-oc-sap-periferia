import type { ReactNode } from "react";

/** Renders only plain text and the server's simple tables; never interprets HTML. */
export function MessageContent({ content }: { content: string }) {
  const lines = content.split("\n");
  const blocks: ReactNode[] = [];
  const cells = (line: string) =>
    line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
  let index = 0;
  while (index < lines.length) {
    if (
      lines[index].trim().startsWith("|") &&
      /^\|?\s*:?-{3,}/.test(lines[index + 1]?.trim() ?? "")
    ) {
      const headings = cells(lines[index]);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].trim().startsWith("|")) {
        rows.push(cells(lines[index++]));
      }
      blocks.push(
        <div className="table-wrap" key={blocks.length} style={{ margin: "12px 0", whiteSpace: "normal" }}>
          <table className="data-table">
            <thead><tr>{headings.map((heading, i) => <th key={i}>{heading}</th>)}</tr></thead>
            <tbody>{rows.map((row, i) => <tr key={i}>{row.map((cell, j) =>
              <td key={j} style={{ overflowWrap: "anywhere" }}>{cell}</td>,
            )}</tr>)}</tbody>
          </table>
        </div>,
      );
    } else {
      const text: string[] = [lines[index++]];
      while (index < lines.length && !lines[index].trim().startsWith("|")) {
        text.push(lines[index++]);
      }
      blocks.push(<div key={blocks.length} style={{ whiteSpace: "pre-wrap" }}>{text.join("\n")}</div>);
    }
  }
  return <>{blocks}</>;
}
