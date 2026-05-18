const jsreportFactory = require('jsreport');

let reporter;
let initPromise;

function getReporter() {
  if (!reporter) {
    reporter = jsreportFactory({
      loadConfig: false,
      logger: { silent: true },
      extensions: {
        express: { enabled: false },
      },
      templatingEngines: {
        strategy: 'in-process',
      },
      chrome: {
        launchOptions: {
          args: ['--no-sandbox', '--disable-dev-shm-usage'],
        },
      },
    });
  }

  if (!initPromise) {
    initPromise = reporter.init();
  }

  return initPromise.then(() => reporter);
}

async function closeReporter() {
  if (!reporter) return;
  try {
    await reporter.close();
  } finally {
    reporter = null;
    initPromise = null;
  }
}

function sanitizeFilename(value) {
  return String(value || 'report')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'report';
}

async function renderAdminPdfReport({
  fileName = 'report',
  title,
  subtitle = '',
  generatedAt = '',
  filterChips = [],
  summaryCards = [],
  charts = [],
  tables = [],
  orientation = 'landscape',
}) {
  const jsreport = await getReporter();
  const safeFileName = sanitizeFilename(fileName);
  const result = await jsreport.render({
    template: {
      engine: 'handlebars',
      recipe: 'chrome-pdf',
      chrome: {
        format: 'A4',
        landscape: orientation === 'landscape',
        printBackground: true,
        displayHeaderFooter: true,
        marginTop: '14mm',
        marginBottom: '16mm',
        marginLeft: '8mm',
        marginRight: '8mm',
        headerTemplate: '<div></div>',
        footerTemplate: `
          <div style="width:100%; font-size:9px; color:#6b7280; padding:0 10mm; display:flex; justify-content:space-between; align-items:center;">
            <span>NOGATU Alliance Admin Report</span>
            <span class="pageNumber"></span>/<span class="totalPages"></span>
          </div>
        `,
      },
      content: `
        <!DOCTYPE html>
        <html>
          <head>
            <meta charset="utf-8" />
            <style>
              * { box-sizing: border-box; }
              body {
                margin: 0;
                font-family: Arial, Helvetica, sans-serif;
                color: #111827;
                background: #fffaf0;
              }
              .page {
                padding: 10px 4px 0;
              }
              .hero {
                border: 1px solid #ead7a1;
                background: linear-gradient(135deg, #2f1408 0%, #5a2a14 48%, #7a4319 100%);
                color: white;
                border-radius: 18px;
                padding: 18px 20px;
                margin-bottom: 16px;
              }
              .eyebrow {
                font-size: 10px;
                letter-spacing: 0.18em;
                text-transform: uppercase;
                color: #f7df9a;
                margin-bottom: 8px;
              }
              .title {
                font-size: 28px;
                font-weight: 700;
                margin: 0 0 4px;
              }
              .subtitle {
                font-size: 12px;
                line-height: 1.5;
                color: rgba(255,255,255,0.82);
                margin: 0;
                max-width: 900px;
              }
              .generated {
                margin-top: 10px;
                font-size: 11px;
                color: rgba(255,255,255,0.72);
              }
              .chips {
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
                margin-bottom: 14px;
              }
              .chip {
                border: 1px solid #e6d6a3;
                background: #fff4d4;
                color: #6b4f06;
                border-radius: 999px;
                padding: 6px 10px;
                font-size: 10px;
                font-weight: 700;
              }
              .summary-grid {
                display: grid;
                grid-template-columns: repeat(4, minmax(0, 1fr));
                gap: 10px;
                margin-bottom: 16px;
              }
              .chart-grid {
                display: grid;
                grid-template-columns: repeat(2, minmax(0, 1fr));
                gap: 12px;
                margin-bottom: 16px;
              }
              .chart-card {
                border-radius: 16px;
                padding: 14px;
                border: 1px solid #ebdec0;
                background: white;
                page-break-inside: avoid;
              }
              .chart-title {
                font-size: 13px;
                font-weight: 700;
                color: #3a1000;
                margin: 0 0 4px;
              }
              .chart-note {
                font-size: 10px;
                color: #6b7280;
                margin: 0 0 10px;
                line-height: 1.45;
              }
              .chart-row {
                margin-bottom: 10px;
              }
              .chart-row:last-child {
                margin-bottom: 0;
              }
              .chart-row-top {
                display: flex;
                justify-content: space-between;
                gap: 12px;
                font-size: 10px;
                margin-bottom: 4px;
                color: #374151;
              }
              .chart-bar-track {
                width: 100%;
                height: 10px;
                border-radius: 999px;
                background: #f5ead4;
                overflow: hidden;
              }
              .chart-bar-fill {
                height: 100%;
                border-radius: 999px;
              }
              .summary-card {
                border-radius: 14px;
                padding: 12px 14px;
                border: 1px solid #ebdec0;
                background: white;
                min-height: 72px;
              }
              .summary-label {
                font-size: 10px;
                text-transform: uppercase;
                letter-spacing: 0.08em;
                color: #6b7280;
                margin-bottom: 6px;
              }
              .summary-value {
                font-size: 18px;
                font-weight: 700;
              }
              .section {
                border: 1px solid #eadfca;
                background: white;
                border-radius: 16px;
                padding: 14px 14px 12px;
                margin-bottom: 14px;
                page-break-inside: avoid;
              }
              .section-title {
                font-size: 14px;
                font-weight: 700;
                color: #3a1000;
                margin: 0 0 4px;
              }
              .section-note {
                font-size: 11px;
                line-height: 1.5;
                color: #6b7280;
                margin: 0 0 10px;
              }
              table {
                width: 100%;
                border-collapse: collapse;
                font-size: 10px;
              }
              thead {
                display: table-header-group;
              }
              th {
                text-align: left;
                padding: 8px 7px;
                color: #6b4f06;
                background: #fff4d4;
                border-bottom: 1px solid #ead7a1;
                text-transform: uppercase;
                letter-spacing: 0.04em;
                font-size: 9px;
              }
              td {
                padding: 7px;
                border-bottom: 1px solid #f2ead8;
                color: #1f2937;
                vertical-align: top;
              }
              tbody tr:nth-child(even) td {
                background: #fffcf5;
              }
              .empty {
                padding: 18px 0 8px;
                color: #6b7280;
                font-size: 11px;
              }
            </style>
          </head>
          <body>
            <div class="page">
              <section class="hero">
                <div class="eyebrow">NOGATU Alliance Admin Reporting</div>
                <h1 class="title">{{title}}</h1>
                {{#if subtitle}}<p class="subtitle">{{subtitle}}</p>{{/if}}
                {{#if generatedAt}}<div class="generated">Generated: {{generatedAt}}</div>{{/if}}
              </section>

              {{#if filterChips.length}}
                <section class="chips">
                  {{#each filterChips}}
                    <div class="chip">{{this}}</div>
                  {{/each}}
                </section>
              {{/if}}

              {{#if summaryCards.length}}
                <section class="summary-grid">
                  {{#each summaryCards}}
                    <div class="summary-card">
                      <div class="summary-label">{{label}}</div>
                      <div class="summary-value" style="color: {{color}};">{{value}}</div>
                    </div>
                  {{/each}}
                </section>
              {{/if}}

              {{#if charts.length}}
                <section class="chart-grid">
                  {{#each charts}}
                    <div class="chart-card">
                      <h2 class="chart-title">{{title}}</h2>
                      {{#if note}}<p class="chart-note">{{note}}</p>{{/if}}
                      {{#each bars}}
                        <div class="chart-row">
                          <div class="chart-row-top">
                            <span>{{label}}</span>
                            <span>{{valueLabel}}</span>
                          </div>
                          <div class="chart-bar-track">
                            <div class="chart-bar-fill" style="width: {{percent}}%; background: {{color}};"></div>
                          </div>
                        </div>
                      {{/each}}
                    </div>
                  {{/each}}
                </section>
              {{/if}}

              {{#each tables}}
                <section class="section">
                  <h2 class="section-title">{{title}}</h2>
                  {{#if note}}<p class="section-note">{{note}}</p>{{/if}}
                  {{#if rows.length}}
                    <table>
                      <thead>
                        <tr>
                          {{#each columns}}
                            <th>{{this}}</th>
                          {{/each}}
                        </tr>
                      </thead>
                      <tbody>
                        {{#each rows}}
                          <tr>
                            {{#each this}}
                              <td>{{this}}</td>
                            {{/each}}
                          </tr>
                        {{/each}}
                      </tbody>
                    </table>
                  {{else}}
                    <div class="empty">No rows available for this section.</div>
                  {{/if}}
                </section>
              {{/each}}
            </div>
          </body>
        </html>
      `,
    },
    data: {
      title,
      subtitle,
      generatedAt,
      filterChips,
      summaryCards,
      charts,
      tables,
    },
  });

  return {
    fileName: `${safeFileName}.pdf`,
    buffer: result.content,
    mimeType: 'application/pdf',
  };
}

function sendPdfReport(res, renderedReport) {
  res.setHeader('Content-Type', renderedReport.mimeType || 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${renderedReport.fileName}"`);
  res.send(renderedReport.buffer);
}

module.exports = {
  renderAdminPdfReport,
  sendPdfReport,
  closeReporter,
};
