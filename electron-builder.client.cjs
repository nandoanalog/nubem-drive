const common = require('./electron-builder.common.cjs');

module.exports = {
  ...common,
  appId: 'org.nubem.drive',
  productName: 'Nubem Drive',
  icon: 'build/icon.png',
  extraMetadata: {
    ...common.extraMetadata,
    name: 'nubem-drive',
    productName: 'Nubem Drive',
    nubemFlavor: 'client',
    description: 'Private folder cloud client.',
  },
  extraResources: [
    { from: 'build/icon.ico', to: 'icon.ico' },
    { from: 'build/icon.png', to: 'icon.png' },
  ],
  linux: {
    target: ['deb'],
    icon: 'build/icon.png',
    category: 'Utility',
    maintainer: 'Nando <nando@nubem.org>',
    executableName: 'nubem-drive',
    artifactName: 'Nubem-Drive-${version}-${arch}.${ext}',
  },
  deb: {
    afterInstall: 'build/linux/after-install-client.sh',
    afterRemove: 'build/linux/after-remove-client.sh',
  },
  win: {
    target: ['nsis'],
    icon: 'build/icon.ico',
    signAndEditExecutable: false,
    executableName: 'Nubem Drive',
    artifactName: 'Nubem-Drive-Setup-${version}-${arch}.${ext}',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    installerIcon: 'build/icon.ico',
    uninstallerIcon: 'build/icon.ico',
    include: 'build/nsis/context-menu.nsh',
  },
  afterPack: 'scripts/after-pack-client.cjs',
};
