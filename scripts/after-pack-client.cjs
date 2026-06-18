const fs = require('node:fs');
const path = require('node:path');
const packageJson = require('../package.json');

module.exports = async (context) => {
  if (context.electronPlatformName !== 'win32') return;

  const exePath = path.join(context.appOutDir, 'Nubem Drive.exe');
  const iconPath = path.resolve(__dirname, '..', 'build', 'icon.ico');
  if (!fs.existsSync(exePath) || !fs.existsSync(iconPath)) {
    throw new Error('Nubem Drive icon patch inputs are missing');
  }

  const { rcedit } = await import('rcedit');
  await rcedit(exePath, {
    icon: iconPath,
    'file-version': packageJson.version,
    'product-version': packageJson.version,
    'version-string': {
      CompanyName: 'Nubem',
      FileDescription: 'Nubem Drive',
      InternalName: 'Nubem Drive',
      OriginalFilename: 'Nubem Drive.exe',
      ProductName: 'Nubem Drive',
    },
  });
};
