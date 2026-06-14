const common = require('./electron-builder.common.cjs');

module.exports = {
  ...common,
  appId: 'org.nubem.drive',
  productName: 'Nubem Drive',
  extraMetadata: {
    ...common.extraMetadata,
    name: 'nubem-drive',
    productName: 'Nubem Drive',
    nubemFlavor: 'client',
    description: 'Private folder cloud client.',
  },
  linux: {
    target: ['deb'],
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
    signAndEditExecutable: false,
    executableName: 'Nubem Drive',
    artifactName: 'Nubem-Drive-Setup-${version}-${arch}.${ext}',
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    include: 'build/nsis/context-menu.nsh',
  },
};
