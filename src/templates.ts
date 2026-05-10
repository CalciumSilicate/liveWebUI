type HtmlOptions = {
  title: string;
  bodyClass?: string;
  body: string;
  scriptPath?: string;
};

export function renderHtmlPage(options: HtmlOptions): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(options.title)}</title>
    <link rel="stylesheet" href="/assets/app.css" />
  </head>
  <body class="${options.bodyClass ?? ""}">
    ${options.body}
    ${options.scriptPath ? `<script type="module" src="${options.scriptPath}"></script>` : ""}
  </body>
</html>`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
