const JSZip = require('jszip');

async function buildCrystalPackage({ reportSlug, xml, xsd, readme }) {
  const zip = new JSZip();
  zip.file(`${reportSlug}.xml`, xml);
  zip.file(`${reportSlug}.xsd`, xsd);
  zip.file('README.txt', readme);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

function sendCrystalPackage(res, filename, buffer) {
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.zip"`);
  res.send(buffer);
}

function defaultCrystalReadme({ title, xmlFile, xsdFile, notes = [] }) {
  const bulletLines = notes.map((note) => `- ${note}`).join('\r\n');
  return [
    `${title} Crystal Reports package`,
    '',
    'How to use in SAP Crystal Reports:',
    '1. Open Crystal Reports.',
    '2. Create a new blank report.',
    '3. Choose the XML and Web Services data connection.',
    `4. Select ${xmlFile} as the XML source.`,
    `5. Select ${xsdFile} as the schema for the XML source.`,
    '6. Finish the connection and build the report from the provided fields.',
    '',
    'Package contents:',
    `- ${xmlFile}: report data`,
    `- ${xsdFile}: XML schema for Crystal field discovery`,
    '- README.txt: import steps',
    '',
    notes.length ? 'Notes:' : null,
    notes.length ? bulletLines : null,
  ].filter(Boolean).join('\r\n');
}

module.exports = {
  buildCrystalPackage,
  sendCrystalPackage,
  defaultCrystalReadme,
};
