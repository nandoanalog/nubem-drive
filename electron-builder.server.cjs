const common = require('./electron-builder.common.cjs');

module.exports = {
  ...common,
  appId: 'org.nubem.server',
  productName: 'Nubem Server',
  icon: 'build/icon.png',
  extraMetadata: {
    ...common.extraMetadata,
    name: 'nubem-server',
    productName: 'Nubem Server',
    nubemFlavor: 'server',
    description: 'Private Nubem storage server.',
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
    executableName: 'nubem-server',
    artifactName: 'Nubem-Server-${version}-${arch}.${ext}',
  },
  deb: {
    afterInstall: 'build/linux/after-install-server.sh',
    afterRemove: 'build/linux/after-remove-server.sh',
  },
};
