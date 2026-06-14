const common = require('./electron-builder.common.cjs');

module.exports = {
  ...common,
  appId: 'org.nubem.server',
  productName: 'Nubem Server',
  extraMetadata: {
    ...common.extraMetadata,
    name: 'nubem-server',
    productName: 'Nubem Server',
    nubemFlavor: 'server',
    description: 'Private Nubem storage server.',
  },
  linux: {
    target: ['deb'],
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
