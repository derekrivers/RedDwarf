function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function highlightJson(value: unknown): string {
  const escaped = escapeHtml(JSON.stringify(value, null, 2));

  return escaped.replace(
    /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (match) => {
      let className = "text-cyan";

      if (match.endsWith(":")) {
        className = "text-blue";
      } else if (match === "true" || match === "false") {
        className = "text-yellow";
      } else if (match === "null") {
        className = "text-secondary";
      } else if (/^-?\d/.test(match)) {
        className = "text-orange";
      }

      return `<span class="${className}">${match}</span>`;
    }
  );
}

export function HighlightedJson(props: { value: unknown }) {
  const { value } = props;

  return (
    <pre
      className="dashboard-code-block"
      dangerouslySetInnerHTML={{ __html: highlightJson(value) }}
    />
  );
}
